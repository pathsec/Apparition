#!/usr/bin/env node
'use strict';
/**
 * Run once to create the initial admin account:
 *   node src/scripts/create-admin.js <username> <password>
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb, initDb } = require('../models/init-db');

const [,, username, password] = process.argv;
if (!username || !password) {
  console.error('Usage: node src/scripts/create-admin.js <username> <password>');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters');
  process.exit(1);
}

initDb();
const db   = getDb();
const hash = bcrypt.hashSync(password, 12);

try {
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`Admin user "${username}" created.`);
} catch (e) {
  if (e.message.includes('UNIQUE')) {
    // Update password if user already exists
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE username = ?').run(hash, username);
    console.log(`Admin user "${username}" password updated.`);
  } else {
    throw e;
  }
} finally {
  db.close();
}
