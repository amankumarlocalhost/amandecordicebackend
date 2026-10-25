'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const { getRedis } = require('../config/redis');

function store(prefix) {
  const redis = getRedis();
  if (!redis) return undefined;
  const { RedisStore } = require('rate-limit-redis');
  return new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args) => redis.call(...args) });
}

function limiter(prefix, { windowMs = env.RATE_LIMIT_WINDOW_MS, limit, key } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: store(prefix),
    keyGenerator: key || ((req) => (req.auth?.userId ? `u:${req.auth.userId}` : ipKeyGenerator(req.ip))),
    handler: (req, res) =>
      res.status(429).json({ success: false, message: 'Too many requests, please try again later', error: { code: 'RATE_LIMITED' }, requestId: req.id }),
    skip: () => env.isTest && process.env.TEST_RATE_LIMITS !== 'true',
  });
}

/** Authenticated requests are keyed by user; anonymous ones by IP + the identifier being targeted. */
const identityKey = (req) => {
  if (req.auth?.userId) return `u:${req.auth.userId}`;
  const id = String(req.body?.identifier || req.body?.email || req.body?.phone || '').toLowerCase().slice(0, 100);
  return `${ipKeyGenerator(req.ip)}:${id}`;
};

const limits = {
  api: limiter('api', { limit: env.RATE_LIMIT_MAX }),
  auth: limiter('auth', { windowMs: 15 * 60 * 1000, limit: env.AUTH_RATE_LIMIT_MAX, key: identityKey }),
  otp: limiter('otp', { windowMs: 60 * 60 * 1000, limit: env.OTP_RATE_LIMIT_MAX, key: identityKey }),
  checkout: limiter('checkout', { windowMs: 60 * 1000, limit: env.CHECKOUT_RATE_LIMIT_MAX }),
  ai: limiter('ai', { windowMs: 60 * 1000, limit: 20 }),
  upload: limiter('upload', { windowMs: 60 * 1000, limit: 20 }),
  review: limiter('review', { windowMs: 60 * 60 * 1000, limit: 20 }),
};

module.exports = { limiter, limits };
