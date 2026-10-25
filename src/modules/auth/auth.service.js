'use strict';

const argon2 = require('argon2');
const bcrypt = require('bcryptjs'); // only to verify legacy hashes, which are upgraded on login
const env = require('../../config/env');
const User = require('../users/user.model');
const { Session, OneTimeCode } = require('./auth.models');
const { signAccessToken, invalidateSessionCache } = require('../../middleware/auth');
const { hmacSha256, randomToken, randomDigits, safeEqual } = require('../../utils/crypto');
const { normalizePhone } = require('../../utils/common');
const { AppError, unauthorized, badRequest, conflict, tooMany } = require('../../utils/errors');
const { ROLES } = require('../../constants/roles');
const { enqueue, QUEUES } = require('../../queues');
const cache = require('../../services/cache');
const audit = require('../audit/audit');
const bus = require('../../events/bus');

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const OTP_TTL_MIN = 10;
const OTP_COOLDOWN_SEC = 60;
const OTP_MAX_PER_HOUR = 5;
const STAFF_REFRESH_DAYS = 1;
const ROTATION_GRACE_MS = 20 * 1000;
/** Argon2id (OWASP baseline: 19 MiB, t=2, p=1). Hashing runs on libuv's thread pool, not the event loop. */
const ARGON2 = { type: argon2.argon2id, memoryCost: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST, parallelism: 1 };
const hashPassword = (pw) => argon2.hash(pw, ARGON2);
let dummyHash = null;

async function verifyHash(hash, pw) {
  if (!hash) {
    dummyHash = dummyHash || (await argon2.hash('timing-equaliser', ARGON2));
    await argon2.verify(dummyHash, pw); // equalise timing for unknown accounts
    return false;
  }
  if (hash.startsWith('$argon2')) return argon2.verify(hash, pw);
  if (hash.startsWith('$2')) return bcrypt.compare(pw, hash);
  return false;
}
const needsRehash = (hash) => !hash.startsWith('$argon2') || argon2.needsRehash(hash, ARGON2);
const hashRefresh = (raw) => hmacSha256(env.JWT_REFRESH_SECRET, raw);
const hashCode = (target, purpose, code) => hmacSha256(env.JWT_REFRESH_SECRET, `${purpose}:${target}:${code}`);

function findByIdentifier(identifier) {
  const id = String(identifier).trim();
  if (id.includes('@')) return { email: id.toLowerCase() };
  const phone = normalizePhone(id);
  if (!phone) return null;
  return { phone };
}

// ---------------------------------------------------------------- sessions

async function issueSession(user, meta = {}) {
  const raw = randomToken(32);
  const days = user.role === ROLES.CUSTOMER ? env.REFRESH_TOKEN_TTL_DAYS : STAFF_REFRESH_DAYS;
  const session = await Session.create({
    user: user._id,
    tokenHash: hashRefresh(raw),
    isStaff: user.role !== ROLES.CUSTOMER,
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip,
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + days * 86400000),
  });
  return {
    sessionId: String(session._id),
    accessToken: signAccessToken({ userId: user._id, sessionId: session._id, role: user.role }),
    refreshToken: `${session._id}.${raw}`,
    refreshExpiresAt: session.expiresAt,
  };
}

async function refresh(refreshToken, meta = {}) {
  const [sid, raw] = String(refreshToken || '').split('.');
  if (!sid || !raw || !/^[a-f0-9]{24}$/.test(sid)) throw unauthorized('Invalid session', 'SESSION_INVALID');
  const session = await Session.findById(sid);
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw unauthorized('Session expired', 'SESSION_INVALID');
  const presented = hashRefresh(raw);

  if (!safeEqual(presented, session.tokenHash)) {
    if (session.prevTokenHash && safeEqual(presented, session.prevTokenHash)) {
      if (Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS) {
        throw new AppError(409, 'TOKEN_ALREADY_ROTATED', 'Session was refreshed by another request; retry with the latest cookie');
      }
      await revokeSession(session._id, 'refresh_token_reuse');
      await audit.record({ actor: { type: 'system' }, action: 'auth.refresh_reuse_detected', resource: { type: 'session', id: session._id }, metadata: { ip: meta.ip } });
      bus.publish(bus.EVENTS.SECURITY_EVENT, { userId: session.user, type: 'refresh_reuse', ip: meta.ip });
    }
    throw unauthorized('Invalid session', 'SESSION_INVALID');
  }

  const user = await User.findById(session.user).select('role status');
  if (!user || user.status !== 'active') {
    await revokeSession(session._id, 'user_inactive');
    throw unauthorized('Account is not active', 'ACCOUNT_INACTIVE');
  }

  const nextRaw = randomToken(32);
  const nextHash = hashRefresh(nextRaw);
  // Conditional update: only one concurrent refresh can win the rotation.
  const rotated = await Session.findOneAndUpdate(
    { _id: session._id, tokenHash: session.tokenHash, revokedAt: null },
    { $set: { prevTokenHash: session.tokenHash, tokenHash: nextHash, rotatedAt: new Date(), lastUsedAt: new Date(), ip: meta.ip } },
    { new: true },
  );
  if (!rotated) throw new AppError(409, 'TOKEN_ALREADY_ROTATED', 'Session was refreshed by another request');
  return {
    sessionId: String(session._id),
    accessToken: signAccessToken({ userId: user._id, sessionId: session._id, role: user.role }),
    refreshToken: `${session._id}.${nextRaw}`,
    refreshExpiresAt: session.expiresAt,
  };
}

async function revokeSession(sessionId, reason = 'logout') {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  await invalidateSessionCache(String(sessionId));
}

async function revokeAllSessions(userId, { exceptSessionId, reason = 'revoke_all' } = {}) {
  const filter = { user: userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const sessions = await Session.find(filter).select('_id').lean();
  if (!sessions.length) return 0;
  await Session.updateMany({ _id: { $in: sessions.map((s) => s._id) } }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  await invalidateSessionCache(sessions.map((s) => String(s._id)));
  return sessions.length;
}

async function listSessions(userId, currentSessionId) {
  const sessions = await Session.find({ user: userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .select('userAgent ip createdAt lastUsedAt expiresAt')
    .sort({ lastUsedAt: -1 })
    .lean();
  return sessions.map((s) => ({ ...s, current: String(s._id) === String(currentSessionId) }));
}

// ---------------------------------------------------------------- one-time codes

async function createCode({ target, purpose, user, ttlMin = OTP_TTL_MIN, link = false }) {
  const latest = await OneTimeCode.findOne({ target, purpose }).sort({ createdAt: -1 }).select('createdAt').lean();
  if (latest && Date.now() - latest.createdAt.getTime() < OTP_COOLDOWN_SEC * 1000) {
    throw tooMany(`Please wait ${OTP_COOLDOWN_SEC} seconds before requesting another code`);
  }
  const hourly = await cache.incrCounter(`otp:${purpose}:${target}`, 3600);
  if (hourly > OTP_MAX_PER_HOUR) throw tooMany('Too many codes requested. Try again in an hour.');

  const code = link ? randomToken(24) : randomDigits(6);
  await OneTimeCode.updateMany({ target, purpose, consumedAt: null }, { $set: { consumedAt: new Date() } }); // invalidate older codes
  const doc = await OneTimeCode.create({ target, purpose, user, codeHash: hashCode(target, purpose, code), expiresAt: new Date(Date.now() + ttlMin * 60000) });
  return link ? `${doc._id}.${code}` : code;
}

async function consumeCode({ target, purpose, code }) {
  const doc = await OneTimeCode.findOneAndUpdate(
    { target, purpose, consumedAt: null, expiresAt: { $gt: new Date() }, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
    { $inc: { attempts: 1 } },
    { sort: { createdAt: -1 }, new: true },
  );
  if (!doc) throw badRequest('The code is invalid or has expired', undefined, 'OTP_INVALID');
  if (!safeEqual(doc.codeHash, hashCode(target, purpose, String(code)))) {
    throw badRequest('The code is invalid or has expired', undefined, 'OTP_INVALID');
  }
  const consumed = await OneTimeCode.findOneAndUpdate({ _id: doc._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!consumed) throw badRequest('The code has already been used', undefined, 'OTP_INVALID');
  return doc;
}

/** Link tokens are `<recordId>.<secret>`; only the secret's hash is stored. */
async function consumeLinkToken(purpose, token) {
  const [id, secret] = String(token || '').split('.');
  const invalid = () => badRequest('This link is invalid or has expired', undefined, 'TOKEN_INVALID');
  if (!/^[a-f0-9]{24}$/.test(id || '') || !secret) throw invalid();
  const doc = await OneTimeCode.findOne({ _id: id, purpose, consumedAt: null, expiresAt: { $gt: new Date() } }).lean();
  if (!doc || !safeEqual(doc.codeHash, hashCode(doc.target, purpose, secret))) throw invalid();
  const consumed = await OneTimeCode.findOneAndUpdate({ _id: doc._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!consumed) throw invalid();
  return doc;
}

function deliverOtp(phone, code, purpose) {
  const text = `${code} is your verification code (${purpose.replace(/_/g, ' ')}). It expires in ${OTP_TTL_MIN} minutes. Never share it.`;
  return enqueue(QUEUES.NOTIFICATIONS, 'sms', { to: phone, text, sensitive: true });
}

function devEcho(code) {
  return env.DEV_EXPOSE_OTP && !env.isProd ? { devCode: code } : {};
}

// ---------------------------------------------------------------- flows

async function register({ name, email, phone, password }, meta) {
  const exists = await User.findOne({ $or: [{ email }, { phone }] }).select('email phone').lean();
  if (exists) throw conflict('An account with this email or phone already exists', 'ACCOUNT_EXISTS');
  const user = await User.create({ name, email, phone, passwordHash: await hashPassword(password), role: ROLES.CUSTOMER });
  const tokens = await issueSession(user, meta);
  const phoneCode = await createCode({ target: phone, purpose: 'verify_phone', user: user._id });
  await deliverOtp(phone, phoneCode, 'verify_phone');
  const emailToken = await createCode({ target: email, purpose: 'verify_email', user: user._id, ttlMin: 24 * 60, link: true });
  await enqueue(QUEUES.NOTIFICATIONS, 'email', {
    to: email,
    subject: 'Verify your email',
    text: `Hi ${name}, verify your email: ${env.frontendOrigins[0]}/verify-email?token=${emailToken}`,
    sensitive: true,
  });
  bus.publish(bus.EVENTS.USER_REGISTERED, { userId: user._id });
  await audit.record({ actor: { type: 'customer', id: user._id, role: user.role }, action: 'auth.register', resource: { type: 'user', id: user._id } });
  return { user, tokens, dev: { ...devEcho(phoneCode), ...(env.DEV_EXPOSE_OTP && !env.isProd ? { devEmailToken: emailToken } : {}) } };
}

async function login({ identifier, password }, meta, { staff = false } = {}) {
  const query = findByIdentifier(identifier);
  const user = query ? await User.findOne(query).select('+passwordHash +failedLoginAttempts +lockUntil') : null;
  if (!user || !user.passwordHash) {
    await verifyHash(null, password);
    throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or reset your password.');
  }
  const valid = await verifyHash(user.passwordHash, password);
  if (!valid) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { $set: { failedLoginAttempts: attempts } };
    if (attempts >= MAX_FAILED_LOGINS) update.$set = { failedLoginAttempts: 0, lockUntil: new Date(Date.now() + LOCK_MINUTES * 60000) };
    await User.updateOne({ _id: user._id }, update);
    if (attempts >= MAX_FAILED_LOGINS) {
      await audit.record({ actor: { type: 'system' }, action: 'auth.account_locked', resource: { type: 'user', id: user._id }, metadata: { ip: meta.ip } });
    }
    throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }
  const isStaff = user.role !== ROLES.CUSTOMER;
  if (staff !== isStaff) {
    throw unauthorized(staff ? 'Invalid credentials' : 'Staff accounts must sign in through the admin login', 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'active') {
    if (user.status === 'deactivated' && !isStaff) {
      user.status = 'active'; // customers reactivate by logging in
      user.deactivatedAt = undefined;
    } else {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
    }
  }
  user.failedLoginAttempts = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = new Date();
  if (needsRehash(user.passwordHash)) user.passwordHash = await hashPassword(password);
  await user.save();
  const tokens = await issueSession(user, meta);
  if (isStaff) {
    await audit.record({ actor: { type: 'staff', id: user._id, role: user.role }, action: 'auth.staff_login', resource: { type: 'user', id: user._id }, metadata: { ip: meta.ip, userAgent: meta.userAgent } });
  }
  return { user, tokens };
}

async function sendPhoneOtp({ userId, phone, purpose }) {
  if (purpose === 'verify_phone') {
    const user = await User.findById(userId).select('phone phoneVerifiedAt');
    if (!user?.phone) throw badRequest('No phone number on this account');
    if (user.phoneVerifiedAt) throw conflict('Phone number already verified', 'ALREADY_VERIFIED');
    const code = await createCode({ target: user.phone, purpose, user: user._id });
    await deliverOtp(user.phone, code, purpose);
    return devEcho(code);
  }
  // login_phone: do not reveal whether the number exists
  const user = await User.findOne({ phone, role: ROLES.CUSTOMER }).select('_id status').lean();
  if (user && user.status !== 'deleted') {
    const code = await createCode({ target: phone, purpose, user: user._id });
    await deliverOtp(phone, code, purpose);
    return devEcho(code);
  }
  return {};
}

async function verifyPhone(userId, code) {
  const user = await User.findById(userId).select('phone phoneVerifiedAt');
  if (!user?.phone) throw badRequest('No phone number on this account');
  await consumeCode({ target: user.phone, purpose: 'verify_phone', code });
  user.phoneVerifiedAt = new Date();
  await user.save();
  return user;
}

async function loginWithOtp({ phone, code }, meta) {
  await consumeCode({ target: phone, purpose: 'login_phone', code });
  const user = await User.findOne({ phone, role: ROLES.CUSTOMER });
  if (!user || !['active', 'deactivated'].includes(user.status)) throw unauthorized('Invalid code', 'OTP_INVALID');
  user.status = 'active';
  user.phoneVerifiedAt = user.phoneVerifiedAt || new Date();
  user.lastLoginAt = new Date();
  await user.save();
  return { user, tokens: await issueSession(user, meta) };
}

async function resendEmailVerification(userId) {
  const user = await User.findById(userId).select('email name emailVerifiedAt');
  if (!user?.email) throw badRequest('No email on this account');
  if (user.emailVerifiedAt) throw conflict('Email already verified', 'ALREADY_VERIFIED');
  const token = await createCode({ target: user.email, purpose: 'verify_email', user: user._id, ttlMin: 24 * 60, link: true });
  await enqueue(QUEUES.NOTIFICATIONS, 'email', {
    to: user.email,
    subject: 'Verify your email',
    text: `Verify your email: ${env.frontendOrigins[0]}/verify-email?token=${token}`,
    sensitive: true,
  });
  return env.DEV_EXPOSE_OTP && !env.isProd ? { devEmailToken: token } : {};
}

async function verifyEmail(token) {
  const doc = await consumeLinkToken('verify_email', token);
  await User.updateOne({ email: doc.target }, { $set: { emailVerifiedAt: new Date() } });
}

async function requestPasswordReset({ identifier }) {
  const query = findByIdentifier(identifier);
  if (!query) return {};
  const user = await User.findOne(query).select('email phone status').lean();
  if (!user || user.status === 'deleted') return {};
  if (query.email) {
    const token = await createCode({ target: user.email, purpose: 'reset_password_email', user: user._id, ttlMin: 30, link: true });
    await enqueue(QUEUES.NOTIFICATIONS, 'email', {
      to: user.email,
      subject: 'Reset your password',
      text: `Reset your password (valid for 30 minutes): ${env.frontendOrigins[0]}/reset-password?token=${token}\nIf you did not request this, ignore this email.`,
      sensitive: true,
    });
    return env.DEV_EXPOSE_OTP && !env.isProd ? { devEmailToken: token } : {};
  }
  const code = await createCode({ target: user.phone, purpose: 'reset_password_phone', user: user._id });
  await deliverOtp(user.phone, code, 'reset_password');
  return devEcho(code);
}

async function resetPassword({ token, phone, code, newPassword }) {
  let userId;
  if (token) userId = (await consumeLinkToken('reset_password_email', token)).user;
  else userId = (await consumeCode({ target: phone, purpose: 'reset_password_phone', code })).user;
  const user = await User.findById(userId);
  if (!user) throw badRequest('Invalid reset request');
  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.lockUntil = undefined;
  await user.save();
  await revokeAllSessions(user._id, { reason: 'password_reset' });
  await audit.record({ actor: { type: user.role === ROLES.CUSTOMER ? 'customer' : 'staff', id: user._id }, action: 'auth.password_reset', resource: { type: 'user', id: user._id } });
  bus.publish(bus.EVENTS.SECURITY_EVENT, { userId: user._id, type: 'password_reset' });
}

async function changePassword(userId, sessionId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await verifyHash(user.passwordHash, currentPassword))) {
    throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  }
  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  await revokeAllSessions(userId, { exceptSessionId: sessionId, reason: 'password_changed' });
  bus.publish(bus.EVENTS.SECURITY_EVENT, { userId, type: 'password_changed' });
}

async function verifyPassword(userId, password) {
  const user = await User.findById(userId).select('+passwordHash');
  return Boolean(user && user.passwordHash && (await verifyHash(user.passwordHash, password)));
}

module.exports = {
  hashPassword,
  issueSession,
  refresh,
  revokeSession,
  revokeAllSessions,
  listSessions,
  register,
  login,
  sendPhoneOtp,
  verifyPhone,
  loginWithOtp,
  resendEmailVerification,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  changePassword,
  verifyPassword,
};
