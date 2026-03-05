'use strict';
const rateLimit = require('express-rate-limit');

// Protects /join/:token from enumeration attacks.
// 10 requests per minute per IP — tight enough to block scanners,
// loose enough for legitimate one-click use.
const joinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// Light limiter for the public session endpoints (/submit, /complete).
// Containers are automated so a slightly higher limit is appropriate.
const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

module.exports = { joinLimiter, sessionLimiter };
