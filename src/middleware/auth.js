'use strict';

/**
 * Require an active admin session cookie.
 * Redirects to /admin/login for browser requests, returns 401 for API calls.
 */
function requireAdminSession(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/admin/login');
}

module.exports = { requireAdminSession };
