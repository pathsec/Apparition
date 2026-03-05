'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/app.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    -- ----------------------------------------------------------------
    -- campaigns: defines a set of invite links with shared settings
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS campaigns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      expires_at  TEXT    NOT NULL,          -- ISO8601; links invalid after this
      lifetime_minutes INTEGER NOT NULL DEFAULT 60,
      redirect_url TEXT   NOT NULL,          -- user lands here after session ends
      start_url    TEXT   NOT NULL,          -- Firefox opens this URL on launch
      favicon_url  TEXT,                     -- URL or NULL; passed to container
      favicon_blob TEXT,                     -- base64 data URI alternative
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ----------------------------------------------------------------
    -- invite_tokens: one row per unique /join/<token> link
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS invite_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token        TEXT    NOT NULL UNIQUE,  -- UUIDv4; never sequential
      campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      email        TEXT,                     -- set when sent via email flow
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      clicked_at   TEXT,                     -- first time /join/<token> was hit
      clicked_ip   TEXT,
      launched     INTEGER NOT NULL DEFAULT 0, -- 1 once container started
      completed    INTEGER NOT NULL DEFAULT 0  -- 1 once session ended
    );

    CREATE INDEX IF NOT EXISTS idx_invite_tokens_token       ON invite_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_campaign_id ON invite_tokens(campaign_id);

    -- ----------------------------------------------------------------
    -- sessions: one row per live or completed container session
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS sessions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT    NOT NULL UNIQUE,  -- UUIDv4 used in JWT
      invite_token_id  INTEGER NOT NULL REFERENCES invite_tokens(id),
      container_id     TEXT,                     -- Docker container ID (short)
      container_port   INTEGER,                  -- host port mapped to NoVNC
      vnc_password     TEXT,                     -- per-session VNC password (for viewer page)
      launched_at      TEXT,
      completed_at     TEXT,
      -- timeout | trigger | manual | error
      completion_reason TEXT,
      submitted        INTEGER NOT NULL DEFAULT 0,
      jwt_invalidated  INTEGER NOT NULL DEFAULT 0  -- 1 after complete/submit
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);

    -- ----------------------------------------------------------------
    -- email_sends: tracks every individual email dispatch
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS email_sends (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_token_id INTEGER NOT NULL REFERENCES invite_tokens(id),
      campaign_id     INTEGER NOT NULL REFERENCES campaigns(id),
      recipient_email TEXT    NOT NULL,
      subject         TEXT    NOT NULL,
      body_text       TEXT,
      body_html       TEXT,
      sent_at         TEXT,
      send_error      TEXT,                 -- NULL on success, error message otherwise
      opened          INTEGER NOT NULL DEFAULT 0,  -- set by webhook if provider supports it
      opened_at       TEXT
    );

    -- ----------------------------------------------------------------
    -- session_submissions: structured JSON posted by containers
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS session_submissions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL REFERENCES sessions(session_id),
      event_type  TEXT    NOT NULL,
      payload     TEXT    NOT NULL,  -- JSON blob
      timestamp   TEXT    NOT NULL,  -- client-supplied ISO8601
      received_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ----------------------------------------------------------------
    -- admin_users: simple single-admin table
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS admin_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ----------------------------------------------------------------
    -- settings: key/value store for mail config etc.
    -- ----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations: add columns that didn't exist in older schema versions
  const migrations = [
    "ALTER TABLE sessions ADD COLUMN vnc_password TEXT",
    "ALTER TABLE campaigns ADD COLUMN completion_url TEXT",
    "ALTER TABLE sessions ADD COLUMN profile_path TEXT",
    "ALTER TABLE campaigns ADD COLUMN completion_cookie TEXT",
    "ALTER TABLE campaigns ADD COLUMN show_loading_page INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE campaigns ADD COLUMN slug TEXT",
    "ALTER TABLE campaigns ADD COLUMN after_completion TEXT NOT NULL DEFAULT 'redirect'",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }

  console.log('Database initialized at', DB_PATH);
  db.close();
}

if (require.main === module) {
  initDb();
}

module.exports = { getDb, initDb };
