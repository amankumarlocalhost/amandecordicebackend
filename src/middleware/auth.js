'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const cache = require('../services/cache');
const { unauthorized, forbidden } = require('../utils/errors');
const { permissionsFor, ROLES } = require('../constants/roles');

const ACCESS_COOKIE = 'access_token';
const JWT_OPTS = { issuer: 'crockery-api', audience: 'crockery' };

function signAccessToken({ userId, sessionId, role }) {
  return jwt.sign({ sub: String(userId), sid: String(sessionId), role }, env.JWT_ACCESS_SECRET, {
    ...JWT_OPTS,
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { ...JWT_OPTS, algorithms: ['HS256'] });
}

function extractToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return { token: header.slice(7), via: 'bearer' };
  const cookie = req.cookies?.[ACCESS_COOKIE];
  if (cookie) return { token: cookie, via: 'cookie' };
  return null;
}

/**
 * Resolves the authoritative auth context for a session. The JWT role claim is never trusted on
 * its own: the user's current role/status and the session's revocation state come from the DB
 * (cached for a short TTL and invalidated on revoke / role change).
 */
async function loadAuthContext(userId, sessionId) {
  const key = `${cache.NS.AUTH}:${sessionId}`;
  let ctx = await cache.get(key);
  if (ctx === undefined) {
    const User = require('../modules/users/user.model');
    const { Session } = require('../modules/auth/auth.models');
    const [user, session] = await Promise.all([
      User.findById(userId).select('name email phone role status').lean(),
      Session.findById(sessionId).select('user revokedAt expiresAt').lean(),
    ]);
    const valid =
      user &&
      session &&
      String(session.user) === String(userId) &&
      !session.revokedAt &&
      session.expiresAt > new Date() &&
      user.status === 'active';
    ctx = valid ? { userId: String(user._id), role: user.role, name: user.name, email: user.email, phone: user.phone } : null;
    await cache.set(key, ctx, 60);
  }
  return ctx;
}

async function invalidateSessionCache(sessionIds) {
  await Promise.all([].concat(sessionIds).map((sid) => cache.del(`${cache.NS.AUTH}:${sid}`)));
}

async function resolveAuth(req) {
  const found = extractToken(req);
  if (!found) return null;
  let payload;
  try {
    payload = verifyAccessToken(found.token);
  } catch {
    return null;
  }
  const ctx = await loadAuthContext(payload.sub, payload.sid);
  if (!ctx) return null;
  return {
    ...ctx,
    sessionId: payload.sid,
    via: found.via,
    isStaff: ctx.role !== ROLES.CUSTOMER,
    permissions: permissionsFor(ctx.role),
  };
}

async function authenticate(req, res, next) {
  const auth = await resolveAuth(req);
  if (!auth) throw unauthorized();
  req.auth = auth;
  next();
}

async function optionalAuth(req, res, next) {
  req.auth = (await resolveAuth(req)) || null;
  next();
}

function requireCustomer(req, res, next) {
  if (!req.auth) throw unauthorized();
  if (req.auth.role !== ROLES.CUSTOMER) throw forbidden('This endpoint is for customer accounts');
  next();
}

function requireStaff(req, res, next) {
  if (!req.auth) throw unauthorized();
  if (!req.auth.isStaff) throw forbidden();
  next();
}

function requirePermission(...perms) {
  return (req, res, next) => {
    if (!req.auth) throw unauthorized();
    if (!req.auth.isStaff || !perms.some((p) => req.auth.permissions.includes(p))) throw forbidden();
    next();
  };
}

module.exports = {
  ACCESS_COOKIE,
  signAccessToken,
  verifyAccessToken,
  loadAuthContext,
  invalidateSessionCache,
  resolveAuth,
  authenticate,
  optionalAuth,
  requireCustomer,
  requireStaff,
  requirePermission,
};
