'use strict';
const express = require('express');
const { getDb } = require('../models/init-db');
const { requireAdminSession } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdminSession);

// GET /admin/campaigns — list all campaigns
router.get('/', (req, res) => {
  const db = getDb();
  const campaigns = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM invite_tokens WHERE campaign_id = c.id) AS token_count,
      (SELECT COUNT(*) FROM invite_tokens WHERE campaign_id = c.id AND launched = 1) AS launched_count
    FROM campaigns c ORDER BY c.created_at DESC
  `).all();
  db.close();
  res.render('admin/campaigns/list', { title: 'Campaigns', campaigns });
});

// GET /admin/campaigns/new
router.get('/new', (req, res) => {
  res.render('admin/campaigns/form', { title: 'New Campaign', campaign: null, error: null });
});

// POST /admin/campaigns — create campaign
router.post('/', (req, res) => {
  const { name, description, expires_date, expires_time, lifetime_minutes, redirect_url, start_url,
          favicon_url, completion_url, completion_cookie, show_loading_page, slug, after_completion } = req.body;
  const expires_at = (expires_date && expires_time) ? `${expires_date}T${expires_time}` : null;

  if (!name || !expires_at || !redirect_url || !start_url) {
    return res.render('admin/campaigns/form', {
      title: 'New Campaign',
      campaign: req.body,
      error: 'name, expiry date/time, redirect_url, and start_url are required',
    });
  }

  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO campaigns (name, description, expires_at, lifetime_minutes, redirect_url, start_url,
                             favicon_url, completion_url, completion_cookie, show_loading_page,
                             slug, after_completion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, description || null, expires_at, parseInt(lifetime_minutes) || 60,
           redirect_url, start_url, favicon_url || null, completion_url || null,
           completion_cookie || null, show_loading_page === 'on' ? 1 : 0,
           slug || null, after_completion || 'redirect');
    res.redirect(`/admin/campaigns/${result.lastInsertRowid}`);
  } finally {
    db.close();
  }
});

// GET /admin/campaigns/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) { db.close(); return res.status(404).render('error', { title: 'Not Found', message: 'Campaign not found' }); }

  const tokens = db.prepare(`
    SELECT it.*, s.session_id, s.launched_at, s.completed_at, s.completion_reason, s.profile_path
    FROM invite_tokens it
    LEFT JOIN sessions s ON s.invite_token_id = it.id
    WHERE it.campaign_id = ?
    ORDER BY it.created_at DESC
  `).all(campaign.id);
  db.close();

  const baseUrl  = process.env.CONTROL_HOST || `http://localhost:${process.env.PORT || 3000}`;
  const joinPath = process.env.JOIN_PATH || 'join';
  res.render('admin/campaigns/detail', { title: campaign.name, campaign, tokens, baseUrl, joinPath });
});

// GET /admin/campaigns/:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  db.close();
  if (!campaign) return res.status(404).render('error', { title: 'Not Found', message: 'Campaign not found' });
  res.render('admin/campaigns/form', { title: 'Edit Campaign', campaign, error: null });
});

// POST /admin/campaigns/:id — update campaign
router.post('/:id', (req, res) => {
  const { name, description, expires_date, expires_time, lifetime_minutes, redirect_url, start_url,
          favicon_url, completion_url, completion_cookie, show_loading_page, slug, after_completion } = req.body;
  const expires_at = (expires_date && expires_time) ? `${expires_date}T${expires_time}` : null;
  const db = getDb();
  try {
    db.prepare(`
      UPDATE campaigns
      SET name=?, description=?, expires_at=?, lifetime_minutes=?,
          redirect_url=?, start_url=?, favicon_url=?, completion_url=?, completion_cookie=?,
          show_loading_page=?, slug=?, after_completion=?, updated_at=datetime('now')
      WHERE id=?
    `).run(name, description || null, expires_at, parseInt(lifetime_minutes) || 60,
           redirect_url, start_url, favicon_url || null, completion_url || null,
           completion_cookie || null, show_loading_page === 'on' ? 1 : 0,
           slug || null, after_completion || 'redirect', req.params.id);
    res.redirect(`/admin/campaigns/${req.params.id}`);
  } finally {
    db.close();
  }
});

// GET /admin/campaigns/:id/export.csv
router.get('/:id/export.csv', (req, res) => {
  const db = getDb();
  try {
    const campaign = db.prepare('SELECT name FROM campaigns WHERE id = ?').get(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const rows = db.prepare(`
      SELECT
        it.email,
        it.token,
        es.sent_at,
        es.send_error,
        COUNT(CASE WHEN ee.event_type = 'open'  THEN 1 END) AS open_count,
        MIN(CASE  WHEN ee.event_type = 'open'  THEN ee.occurred_at END) AS first_open,
        MAX(CASE  WHEN ee.event_type = 'open'  THEN ee.occurred_at END) AS last_open,
        GROUP_CONCAT(CASE WHEN ee.event_type = 'open'  THEN ee.ip END) AS open_ips,
        GROUP_CONCAT(CASE WHEN ee.event_type = 'open'  THEN ee.user_agent END) AS open_user_agents,
        COUNT(CASE WHEN ee.event_type = 'click' THEN 1 END) AS click_count,
        MIN(CASE  WHEN ee.event_type = 'click' THEN ee.occurred_at END) AS first_click,
        MAX(CASE  WHEN ee.event_type = 'click' THEN ee.occurred_at END) AS last_click,
        GROUP_CONCAT(CASE WHEN ee.event_type = 'click' THEN ee.ip END) AS click_ips,
        it.launched,
        it.completed
      FROM invite_tokens it
      LEFT JOIN email_sends es ON es.invite_token_id = it.id
      LEFT JOIN email_events ee ON ee.invite_token_id = it.id
      WHERE it.campaign_id = ? AND it.email IS NOT NULL
      GROUP BY it.id, es.id
      ORDER BY es.sent_at ASC
    `).all(req.params.id);

    const headers = [
      'email', 'token', 'sent_at', 'send_error',
      'open_count', 'first_open', 'last_open', 'open_ips', 'open_user_agents',
      'click_count', 'first_click', 'last_click', 'click_ips',
      'launched', 'completed',
    ];

    function csvField(v) {
      if (v == null) return '';
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }

    const lines = [
      headers.join(','),
      ...rows.map(r => headers.map(h => csvField(r[h])).join(',')),
    ];

    const filename = `${campaign.name.replace(/[^a-z0-9]+/gi, '-')}-tracking.csv`;
    res.set({
      'Content-Type':        'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send(lines.join('\r\n'));
  } finally {
    db.close();
  }
});

// POST /admin/campaigns/:id/delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
    res.redirect('/admin/campaigns');
  } finally {
    db.close();
  }
});

module.exports = router;
