'use strict';
const { getDb } = require('../models/init-db');
const { expireSession } = require('./docker');

const INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS) || 60 * 1000; // every 60s

/**
 * Cleanup job: finds sessions whose lifetime has elapsed but were never
 * explicitly completed (e.g. the setTimeout was lost on server restart).
 *
 * This is a safety net — the primary teardown is the per-session setTimeout
 * in docker.js. Running both ensures no containers are orphaned across restarts.
 */
async function runCleanup() {
  const db = getDb();
  let stale;
  try {
    stale = db.prepare(`
      SELECT s.session_id, s.container_id, s.launched_at, c.lifetime_minutes
      FROM sessions s
      JOIN invite_tokens it ON it.id = s.invite_token_id
      JOIN campaigns c ON c.id = it.campaign_id
      WHERE s.completed_at IS NULL
        AND s.launched_at IS NOT NULL
        AND datetime(s.launched_at, '+' || c.lifetime_minutes || ' minutes') < datetime('now')
    `).all();
  } finally {
    db.close();
  }

  if (stale.length) {
    console.log(`[cleanup] Found ${stale.length} stale session(s) to expire`);
  }

  for (const s of stale) {
    try {
      await expireSession(s.session_id, s.container_id);
      console.log(`[cleanup] Expired session ${s.session_id}`);
    } catch (err) {
      console.error(`[cleanup] Failed to expire session ${s.session_id}:`, err.message);
    }
  }
}

function startCleanupJob() {
  // Run immediately on startup to handle any sessions that expired while the
  // server was down, then on the configured interval.
  runCleanup().catch(err => console.error('[cleanup] startup run failed:', err));
  setInterval(() => runCleanup().catch(err => console.error('[cleanup]', err)), INTERVAL_MS);
  console.log(`[cleanup] Job started, interval=${INTERVAL_MS}ms`);
}

module.exports = { startCleanupJob, runCleanup };
