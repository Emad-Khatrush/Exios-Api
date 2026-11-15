// Limits how often one caller can hit a public endpoint (sign-in, password reset emails), kept in
// memory: it resets when the server restarts, which is fine for slowing down guessing and spam.
// req.ip is the visitor's real address only because app.js sets 'trust proxy' (the host's router
// sits in front of the app).
const { errorMessages } = require('../constants/errorTypes');

const limiter = ({ windowMs, max, key = (req) => req.ip }) => {
  const hits = new Map();
  return (req, res, next) => {
    const id = key(req);
    if (!id) return next();
    const now = Date.now();
    const recent = (hits.get(id) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const retryAfter = Math.ceil((recent[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, message: errorMessages.TOO_MANY_REQUESTS, retryAfter });
    }
    recent.push(now);
    hits.set(id, recent);
    // never let the map grow without bound
    if (hits.size > 10000) hits.clear();
    next();
  };
};

const emailKey = (req) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '');

module.exports = {
  // Sign-in from one address: enough for a family behind one router, too few to try passwords on many accounts
  loginByIp: limiter({ windowMs: 10 * 60 * 1000, max: 20 }),
  // Password reset emails: a few to the same inbox per hour, and not many from one address
  resetByEmail: limiter({ windowMs: 60 * 60 * 1000, max: 3, key: emailKey }),
  resetByIp: limiter({ windowMs: 60 * 60 * 1000, max: 10 }),
};
