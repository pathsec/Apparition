'use strict';
const express = require('express');
const crypto  = require('crypto');
const { getDb } = require('../models/init-db');
const { requireAdminSession } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdminSession);

// GET /admin/invites?campaign_id=<id>
router.get('/', (req, res) => {
  const { campaign_id } = req.query;
  const db = getDb();

  const campaign = campaign_id
    ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id)
    : null;

  const tokens = campaign_id
    ? db.prepare(`
        SELECT it.*, s.launched_at, s.completed_at, s.completion_reason, s.submitted
        FROM invite_tokens it
        LEFT JOIN sessions s ON s.invite_token_id = it.id
        WHERE it.campaign_id = ?
        ORDER BY it.created_at DESC
      `).all(campaign_id)
    : [];

  const campaigns = db.prepare('SELECT id, name FROM campaigns ORDER BY name').all();
  db.close();

  res.render('admin/invites/list', { title: 'Invite Links', tokens, campaign, campaigns });
});

// POST /admin/invites/generate
// Body: { campaign_id, count }
// Generates N unique UUIDv4 tokens for a campaign — never sequential/guessable.
router.post('/generate', (req, res) => {
  const { campaign_id, count } = req.body;
  const n = Math.min(parseInt(count) || 1, 1000); // cap at 1000 per batch

  const db = getDb();
  try {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id);
    if (!campaign) {
      db.close();
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const insert = db.prepare(
      'INSERT INTO invite_tokens (token, campaign_id) VALUES (?, ?)'
    );
    const insertMany = db.transaction(() => {
      const tokens = [];
      for (let i = 0; i < n; i++) {
        const token = crypto.randomBytes(6).toString('hex'); // 12-char hex, e.g. a3f7b2c1d4e5
        insert.run(token, campaign_id);
        tokens.push(token);
      }
      return tokens;
    });

    const tokens = insertMany();
    res.json({ generated: tokens.length, tokens });
  } finally {
    db.close();
  }
});

// GET /admin/invites/:id — single token detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const token = db.prepare(`
    SELECT it.*, c.name as campaign_name, c.expires_at,
           s.session_id, s.launched_at, s.completed_at, s.completion_reason, s.submitted,
           ss.event_type, ss.payload, ss.received_at
    FROM invite_tokens it
    JOIN campaigns c ON c.id = it.campaign_id
    LEFT JOIN sessions s ON s.invite_token_id = it.id
    LEFT JOIN session_submissions ss ON ss.session_id = s.session_id
    WHERE it.id = ?
  `).get(req.params.id);
  db.close();

  if (!token) return res.status(404).render('error', { title: 'Not Found', message: 'Token not found' });
  res.render('admin/invites/detail', { title: 'Invite Detail', token });
});

// POST /admin/invites/:id/revoke — manually invalidate a token
router.post('/:id/revoke', (req, res) => {
  const db = getDb();
  try {
    db.prepare('UPDATE invite_tokens SET completed = 1 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } finally {
    db.close();
  }
});

module.exports = router;
