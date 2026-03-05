'use strict';
const nodemailer = require('nodemailer');
const { getDb } = require('../models/init-db');

/**
 * Build mail config by merging DB-stored settings with environment variables.
 * Env vars always take precedence so that secrets stay out of the database.
 *
 * Provider-agnostic: works with any SMTP server (Mailjet, SendGrid, Postfix…).
 * For Mailjet specifically:
 *   SMTP_HOST=in-v3.mailjet.com
 *   SMTP_PORT=587
 *   SMTP_USER=<API key>
 *   SMTP_PASS=<Secret key>
 */
function getMailConfig() {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'SMTP_%'").all();
  db.close();

  const fromDb = Object.fromEntries(rows.map(r => [r.key, r.value]));

  return {
    host:     process.env.SMTP_HOST     || fromDb.SMTP_HOST     || '',
    port:     parseInt(process.env.SMTP_PORT || fromDb.SMTP_PORT || '587'),
    secure:   (process.env.SMTP_SECURE  || fromDb.SMTP_SECURE   || 'false') === 'true',
    user:     process.env.SMTP_USER     || fromDb.SMTP_USER     || '',
    pass:     process.env.SMTP_PASS     || fromDb.SMTP_PASS     || '',
    from:     process.env.SMTP_FROM     || fromDb.SMTP_FROM     || '',
    fromName: process.env.SMTP_FROM_NAME|| fromDb.SMTP_FROM_NAME|| 'NoVNC Manager',
  };
}

/**
 * Create a Nodemailer transporter from current config.
 * Throws a descriptive error if required fields are missing.
 */
function createTransporter() {
  const cfg = getMailConfig();
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.from) {
    throw new Error(
      'Incomplete mail configuration. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM ' +
      'in environment variables or via Settings > Mail.'
    );
  }

  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    // Increase timeout for slow mail servers.
    connectionTimeout: 10000,
    greetingTimeout:   10000,
  });
}

/**
 * Send a single email.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.text   - plain text body
 * @param {string} [opts.html] - HTML body (optional)
 */
async function sendEmail({ to, subject, text, html }) {
  const transporter = createTransporter();
  const cfg = getMailConfig();

  await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.from}>`,
    to,
    subject,
    text,
    html: html || undefined,
  });
}

module.exports = { sendEmail, getMailConfig };
