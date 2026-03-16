'use strict';
const express = require('express');
const crypto  = require('crypto');
const { getDb } = require('../models/init-db');
const { requireAdminSession } = require('../middleware/auth');
const { sendEmail, getMailConfig } = require('../services/mailer');

const router = express.Router();
router.use(requireAdminSession);

// GET /admin/email — compose & send invites
router.get('/', (req, res) => {
  const db = getDb();
  const campaigns = db.prepare('SELECT id, name FROM campaigns ORDER BY name').all();
  const history   = db.prepare(`
    SELECT es.*, it.token, c.name as campaign_name
    FROM email_sends es
    JOIN invite_tokens it ON it.id = es.invite_token_id
    JOIN campaigns c ON c.id = es.campaign_id
    ORDER BY es.sent_at DESC LIMIT 100
  `).all();
  db.close();
  res.render('admin/email/compose', { title: 'Email Invites', campaigns, history, error: null, success: null });
});

// POST /admin/email/send
// Body: { campaign_id, emails (newline-separated), subject, body_text, body_html }
//
// Each recipient gets their own unique token. Tokens are created fresh here if
// the campaign doesn't have pre-generated unused ones; otherwise existing unset
// tokens are consumed first.
router.post('/send', async (req, res) => {
  const { campaign_id, emails: rawEmails, subject, body_text, body_html } = req.body;

  const emailList = (rawEmails || '')
    .split(/[\n,]+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e.includes('@'));

  if (!campaign_id || !emailList.length || !subject || !body_text) {
    const db = getDb();
    const campaigns = db.prepare('SELECT id, name FROM campaigns').all();
    db.close();
    return res.render('admin/email/compose', {
      title: 'Email Invites',
      campaigns,
      history: [],
      error: 'campaign_id, at least one email, subject, and body_text are required',
      success: null,
    });
  }

  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id);
  if (!campaign) {
    db.close();
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const controlHost = process.env.CONTROL_HOST || `http://localhost:${process.env.PORT || 3000}`;
  const joinPath    = process.env.JOIN_PATH || 'join';
  const results = [];

  for (const email of emailList) {
    // Generate a fresh token for each recipient — same format as invites.js.
    const token = crypto.randomBytes(6).toString('hex');
    let inviteId;

    try {
      const insert = db.prepare(
        'INSERT INTO invite_tokens (token, campaign_id, email) VALUES (?, ?, ?)'
      );
      inviteId = insert.run(token, campaign_id, email).lastInsertRowid;

      const link    = `${controlHost}/${joinPath}/${token}`;
      const txtBody = body_text.replace(/\{link\}/g, link);
      const htmlBody = body_html ? body_html.replace(/\{link\}/g, `<a href="${link}">${link}</a>`) : null;

      await sendEmail({ to: email, subject, text: txtBody, html: htmlBody });

      db.prepare(`
        INSERT INTO email_sends (invite_token_id, campaign_id, recipient_email, subject, body_text, body_html, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(inviteId, campaign_id, email, subject, txtBody, htmlBody);

      results.push({ email, status: 'sent', token });
    } catch (err) {
      if (inviteId) {
        db.prepare(`
          INSERT INTO email_sends (invite_token_id, campaign_id, recipient_email, subject, body_text, body_html, send_error)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(inviteId, campaign_id, email, subject, body_text, body_html || null, err.message);
      }
      results.push({ email, status: 'error', error: err.message });
    }
  }

  db.close();

  const successCount = results.filter(r => r.status === 'sent').length;
  const campaigns = getDb().prepare('SELECT id, name FROM campaigns').all();
  getDb().close();

  res.render('admin/email/compose', {
    title: 'Email Invites',
    campaigns,
    history: [],
    error: null,
    success: `Sent ${successCount}/${emailList.length} emails`,
    results,
  });
});

// GET /admin/email/history — full send history
router.get('/history', (req, res) => {
  const db = getDb();
  const history = db.prepare(`
    SELECT es.*, it.token, c.name as campaign_name
    FROM email_sends es
    JOIN invite_tokens it ON it.id = es.invite_token_id
    JOIN campaigns c ON c.id = es.campaign_id
    ORDER BY es.sent_at DESC
  `).all();
  db.close();
  res.render('admin/email/history', { title: 'Email History', history });
});

// POST /admin/email/webhook/open — open tracking webhook (provider-agnostic)
// Providers can POST here when an email is opened. No auth required (obscurity
// + provider IP allowlist in nginx is the recommended protection).
router.post('/webhook/open', express.json(), (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const db = getDb();
  try {
    db.prepare(`
      UPDATE email_sends SET opened = 1, opened_at = datetime('now')
      WHERE invite_token_id = (SELECT id FROM invite_tokens WHERE token = ?)
    `).run(token);
    res.json({ ok: true });
  } finally {
    db.close();
  }
});

module.exports = router;
