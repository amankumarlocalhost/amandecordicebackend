'use strict';

const crypto = require('crypto');
const env = require('../config/env');
const { forbidden } = require('../utils/errors');
const { hmacSha256, randomToken, safeEqual } = require('../utils/crypto');

const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function cookieBase() {
  return {
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
  };
}

/** Signed double-submit token: `<random>.<hmac>`. Readable by the SPA, verified on every unsafe request. */
function issueCsrfToken(res) {
  const raw = randomToken(18);
  const token = `${raw}.${hmacSha256(env.COOKIE_SECRET, raw).slice(0, 32)}`;
  res.cookie(CSRF_COOKIE, token, { ...cookieBase(), httpOnly: false, maxAge: 7 * 24 * 3600 * 1000 });
  return token;
}

function validCsrfToken(token) {
  if (typeof token !== 'string') return false;
  const [raw, sig] = token.split('.');
  return Boolean(raw && sig && safeEqual(sig, hmacSha256(env.COOKIE_SECRET, raw).slice(0, 32)));
}

/**
 * CSRF applies to cookie-authenticated browsers. Requests that authenticate with an explicit
 * Bearer token and send no cookies cannot be forged cross-site, and provider webhooks are
 * authenticated by signature instead.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.path.startsWith('/api/v1/webhooks/')) return next();
  // Non-browser clients (mobile apps, server-to-server) send no cookies and either a Bearer token
  // or the custom X-Client-Type header. A cross-site page cannot send a custom header without a
  // CORS preflight, which only succeeds for allowed origins, so this cannot be used for (login) CSRF.
  const hasCookies = req.headers.cookie && req.headers.cookie.length > 0;
  if (!hasCookies && (req.headers.authorization?.startsWith('Bearer ') || req.get('x-client-type'))) return next();
  const header = req.get(CSRF_HEADER);
  const cookie = req.cookies?.[CSRF_COOKIE];
  if (!header || !cookie || !safeEqual(header, cookie) || !validCsrfToken(header)) {
    throw forbidden('Missing or invalid CSRF token. Fetch /api/v1/auth/csrf and send it in the X-CSRF-Token header.', 'CSRF_INVALID');
  }
  next();
}

/** Removes keys starting with `$` or containing `.` from user input (NoSQL operator injection). */
function stripDangerousKeys(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripDangerousKeys(v, depth + 1));
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      delete value[key];
    } else {
      value[key] = stripDangerousKeys(value[key], depth + 1);
    }
  }
  return value;
}

function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) stripDangerousKeys(req.body);
  if (req.query) stripDangerousKeys(req.query);
  next();
}

function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

module.exports = { CSRF_COOKIE, CSRF_HEADER, cookieBase, issueCsrfToken, csrfProtection, sanitizeInput, stripDangerousKeys, requestId };
