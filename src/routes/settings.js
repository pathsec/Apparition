'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { getDb } = require('../models/init-db');
const { requireAdminSession } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdminSession);

const MAIL_KEYS       = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_FROM_NAME'];
const TURNSTILE_KEYS  = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'];

// GET /admin/settings
router.get('/', (req, res) => {
  const db   = getDb();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'SMTP_%' OR key LIKE 'TURNSTILE_%'").all();
  db.close();

  const cfg          = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const mailConfig   = Object.fromEntries(MAIL_KEYS.map(k => [k, cfg[k] || '']));
  const turnstile    = Object.fromEntries(TURNSTILE_KEYS.map(k => [k, cfg[k] || '']));
  res.render('admin/settings', { title: 'Settings', mailConfig, turnstile, error: null, success: null });
});

// POST /admin/settings/mail — save SMTP settings to DB
// Env vars override DB settings at runtime (see mailer.js).
router.post('/mail', (req, res) => {
  const db = getDb();
  try {
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    const saveAll = db.transaction(() => {
      for (const key of MAIL_KEYS) {
        // Never store blank/null passwords — preserve existing value instead.
        if (key === 'SMTP_PASS' && !req.body[key]) continue;
        upsert.run(key, req.body[key] || null);
      }
    });
    saveAll();
    res.render('admin/settings', {
      title: 'Settings', mailConfig: req.body,
      turnstile: Object.fromEntries(TURNSTILE_KEYS.map(k => [k, ''])),
      error: null, success: 'Mail settings saved',
    });
  } finally {
    db.close();
  }
});

// POST /admin/settings/turnstile — save Cloudflare Turnstile keys
router.post('/turnstile', (req, res) => {
  const db = getDb();
  try {
    const upsert = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    db.transaction(() => {
      for (const key of TURNSTILE_KEYS) {
        if (!req.body[key]) continue; // don't overwrite with blank
        upsert.run(key, req.body[key]);
      }
    })();
    const rows     = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'SMTP_%'").all();
    const mailConfig = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.render('admin/settings', {
      title: 'Settings', mailConfig, turnstile: req.body,
      error: null, success: 'Turnstile settings saved',
    });
  } finally {
    db.close();
  }
});

// POST /admin/settings/password — change admin password
router.post('/password', (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (new_password !== confirm_password) {
    return res.render('admin/settings', {
      title: 'Settings', mailConfig: {}, turnstile: {},
      error: 'New passwords do not match', success: null,
    });
  }

  const db = getDb();
  try {
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.session.adminId);
    if (!bcrypt.compareSync(current_password, user.password_hash)) {
      return res.render('admin/settings', {
        title: 'Settings', mailConfig: {}, turnstile: {},
        error: 'Current password is incorrect', success: null,
      });
    }

    const hash = bcrypt.hashSync(new_password, 12);
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, user.id);

    res.render('admin/settings', {
      title: 'Settings', mailConfig: {}, turnstile: {},
      error: null, success: 'Password updated successfully',
    });
  } finally {
    db.close();
  }
});

module.exports = router;
