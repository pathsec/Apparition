'use strict';
const jwt = require('jsonwebtoken');

// JWT_SECRET must be a long random string set in the environment.
// Never fall back to a default in production — we throw if it's missing.
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return secret;
}

/**
 * Issue a signed session JWT.
 * @param {object} opts
 * @param {string} opts.sessionId   - UUIDv4 session identifier
 * @param {string} opts.containerId - Docker container ID
 * @param {number} opts.lifetimeMinutes - TTL for the token (matches container lifetime)
 */
function signSessionToken({ sessionId, containerId, lifetimeMinutes }) {
  return jwt.sign(
    { session_id: sessionId, container_id: containerId },
    getSecret(),
    { algorithm: 'HS256', expiresIn: lifetimeMinutes * 60 }
  );
}

/**
 * Verify a session JWT and return its payload.
 * Throws if invalid or expired.
 */
function verifySessionToken(token) {
  return jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
}

/**
 * Extract and verify the Bearer token from an Authorization header value.
 * Returns the decoded payload or throws.
 */
function verifyBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or malformed Authorization header');
    err.status = 401;
    throw err;
  }
  return verifySessionToken(authHeader.slice(7));
}

module.exports = { signSessionToken, verifySessionToken, verifyBearerToken };
