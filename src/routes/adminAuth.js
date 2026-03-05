'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { getDb } = require('../models/init-db');
const { requireAdminSession } = require('../middleware/auth');

const router = express.Router();

// GET /admin/login
router.get('/login', (req, res) => {
  if (req.session.adminId) return res.redirect('/admin/dashboard');
  res.render('admin/login', { title: 'Admin Login', error: null });
});

// POST /admin/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db   = getDb();
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  db.close();

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('admin/login', { title: 'Admin Login', error: 'Invalid credentials' });
  }

  req.session.adminId   = user.id;
  req.session.adminUser = user.username;
  res.redirect('/admin/dashboard');
});

// POST /admin/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// GET /admin/dashboard
router.get('/dashboard', requireAdminSession, (req, res) => {
  const db = getDb();

  const activeContainers = db.prepare(`
    SELECT COUNT(*) as count FROM sessions
    WHERE completed_at IS NULL AND launched_at IS NOT NULL
  `).get();

  const recentSessions = db.prepare(`
    SELECT s.*, it.email, it.token, c.name as campaign_name
    FROM sessions s
    JOIN invite_tokens it ON it.id = s.invite_token_id
    JOIN campaigns c ON c.id = it.campaign_id
    ORDER BY s.launched_at DESC LIMIT 10
  `).all();

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM campaigns)      AS total_campaigns,
      (SELECT COUNT(*) FROM invite_tokens)  AS total_tokens,
      (SELECT COUNT(*) FROM sessions)       AS total_sessions,
      (SELECT COUNT(*) FROM sessions WHERE submitted = 1) AS submitted_sessions
  `).get();

  db.close();

  res.render('admin/dashboard', {
    title: 'Dashboard',
    user: req.session.adminUser,
    activeContainers: activeContainers.count,
    recentSessions,
    stats,
  });
});

module.exports = router;
