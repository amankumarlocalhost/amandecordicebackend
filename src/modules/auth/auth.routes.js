'use strict';

const { z } = require('zod');
const env = require('../../config/env');
const service = require('./auth.service');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { limits } = require('../../middleware/rateLimit');
const { ACCESS_COOKIE } = require('../../middleware/auth');
const { cookieBase, issueCsrfToken } = require('../../middleware/security');
const { unauthorized } = require('../../utils/errors');
const { emailSchema, phoneSchema } = require('../../utils/common');

const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/api/v1/auth';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must contain letters and numbers');

function setAuthCookies(res, tokens) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...cookieBase(), httpOnly: true, maxAge: env.ACCESS_TOKEN_TTL_MIN * 60000 });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...cookieBase(),
    httpOnly: true,
    path: REFRESH_PATH,
    expires: tokens.refreshExpiresAt,
  });
  return issueCsrfToken(res);
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase() });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: REFRESH_PATH });
}

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** Tokens are also returned in the body for non-browser clients that use Bearer auth. */
function authPayload(req, user, tokens, csrfToken, extra = {}) {
  const wantsTokens = req.get('x-client-type') === 'mobile';
  return {
    user: user.toSafeJSON(),
    csrfToken,
    ...(wantsTokens ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } : {}),
    ...extra,
  };
}

async function linkGuestCart(req, res, user) {
  if (user.role !== 'customer') return;
  const { mergeGuestCart } = require('../cart/cart.service');
  await mergeGuestCart(req, res, user._id);
}

const api = createRouter({ prefix: '/api/v1/auth', tag: 'Auth' });

api.get('/csrf', { summary: 'Issue a CSRF token (cookie + body). Call before any unsafe request.' }, (req, res) => {
  ok(res, { csrfToken: issueCsrfToken(res) });
});

api.post(
  '/register',
  {
    summary: 'Register a customer account (sends phone OTP and email verification link)',
    rateLimit: limits.auth,
    body: z.object({ name: z.string().trim().min(2).max(100), email: emailSchema, phone: phoneSchema, password }),
  },
  async (req, res) => {
    const { user, tokens, dev } = await service.register(req.body, meta(req));
    const csrf = setAuthCookies(res, tokens);
    await linkGuestCart(req, res, user);
    created(res, authPayload(req, user, tokens, csrf, dev), 'Account created. Verify your phone number with the code we sent.');
  },
);

api.post(
  '/login',
  {
    summary: 'Customer login with email or phone + password',
    rateLimit: limits.auth,
    body: z.object({ identifier: z.string().trim().min(3).max(254), password: z.string().min(1).max(128) }),
  },
  async (req, res) => {
    const { user, tokens } = await service.login(req.body, meta(req));
    const csrf = setAuthCookies(res, tokens);
    await linkGuestCart(req, res, user);
    ok(res, authPayload(req, user, tokens, csrf), { message: 'Logged in' });
  },
);

api.post(
  '/admin/login',
  {
    summary: 'Staff/administrator login',
    rateLimit: limits.auth,
    body: z.object({ identifier: z.string().trim().min(3).max(254), password: z.string().min(1).max(128) }),
  },
  async (req, res) => {
    const { user, tokens } = await service.login(req.body, meta(req), { staff: true });
    const csrf = setAuthCookies(res, tokens);
    const { permissionsFor } = require('../../constants/roles');
    ok(res, { ...authPayload(req, user, tokens, csrf), permissions: permissionsFor(user.role) }, { message: 'Logged in' });
  },
);

api.post(
  '/otp/send',
  {
    summary: 'Send a phone OTP (purpose verify_phone requires login; login_phone does not)',
    auth: 'optional',
    rateLimit: limits.otp,
    body: z.object({ purpose: z.enum(['verify_phone', 'login_phone']), phone: phoneSchema.optional() }),
  },
  async (req, res) => {
    const { purpose, phone } = req.body;
    if (purpose === 'verify_phone' && !req.auth) throw unauthorized();
    if (purpose === 'login_phone' && !phone) throw unauthorized('Phone number required');
    const dev = await service.sendPhoneOtp({ userId: req.auth?.userId, phone, purpose });
    ok(res, dev, { message: 'If the number is registered, a code has been sent' });
  },
);

api.post(
  '/otp/verify-phone',
  { summary: 'Verify the account phone number', auth: 'required', rateLimit: limits.otp, body: z.object({ code: z.string().regex(/^\d{6}$/) }) },
  async (req, res) => {
    const user = await service.verifyPhone(req.auth.userId, req.body.code);
    ok(res, { user: user.toSafeJSON?.() || { phoneVerified: true } }, { message: 'Phone number verified' });
  },
);

api.post(
  '/otp/login',
  { summary: 'Log in with a phone OTP', rateLimit: limits.auth, body: z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/) }) },
  async (req, res) => {
    const { user, tokens } = await service.loginWithOtp(req.body, meta(req));
    const csrf = setAuthCookies(res, tokens);
    await linkGuestCart(req, res, user);
    ok(res, authPayload(req, user, tokens, csrf), { message: 'Logged in' });
  },
);

api.post('/email/resend-verification', { summary: 'Resend email verification link', auth: 'required', rateLimit: limits.otp }, async (req, res) => {
  ok(res, await service.resendEmailVerification(req.auth.userId), { message: 'Verification email sent' });
});

api.post('/email/verify', { summary: 'Verify email with the emailed token', rateLimit: limits.auth, body: z.object({ token: z.string().min(20).max(200) }) }, async (req, res) => {
  await service.verifyEmail(req.body.token);
  ok(res, null, { message: 'Email verified' });
});

api.post(
  '/refresh',
  { summary: 'Rotate the refresh token and issue a new access token' },
  async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
    if (!token) throw unauthorized('No session', 'SESSION_INVALID');
    try {
      const tokens = await service.refresh(token, meta(req));
      const csrf = setAuthCookies(res, tokens);
      const wantsTokens = req.get('x-client-type') === 'mobile';
      ok(res, { csrfToken: csrf, ...(wantsTokens ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } : {}) }, { message: 'Session refreshed' });
    } catch (err) {
      if (err.code === 'SESSION_INVALID' || err.code === 'ACCOUNT_INACTIVE') clearAuthCookies(res);
      throw err;
    }
  },
);

api.post('/logout', { summary: 'Log out of the current session', auth: 'optional' }, async (req, res) => {
  if (req.auth) await service.revokeSession(req.auth.sessionId, 'logout');
  clearAuthCookies(res);
  ok(res, null, { message: 'Logged out' });
});

api.post('/logout-all', { summary: 'Log out of every session', auth: 'required' }, async (req, res) => {
  const count = await service.revokeAllSessions(req.auth.userId, { reason: 'logout_all' });
  clearAuthCookies(res);
  ok(res, { revoked: count }, { message: 'Logged out everywhere' });
});

api.get('/sessions', { summary: 'List active sessions', auth: 'required' }, async (req, res) => {
  ok(res, await service.listSessions(req.auth.userId, req.auth.sessionId));
});

api.delete(
  '/sessions/:id',
  { summary: 'Revoke one session', auth: 'required', params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }) },
  async (req, res) => {
    const { Session } = require('./auth.models');
    const s = await Session.findOne({ _id: req.params.id, user: req.auth.userId }).select('_id').lean();
    if (s) await service.revokeSession(s._id, 'user_revoked');
    ok(res, null, { message: 'Session revoked' });
  },
);

api.post(
  '/password/forgot',
  { summary: 'Request a password reset (email link or phone OTP)', rateLimit: limits.otp, body: z.object({ identifier: z.string().trim().min(3).max(254) }) },
  async (req, res) => {
    const dev = await service.requestPasswordReset(req.body);
    ok(res, dev, { message: 'If an account exists, reset instructions have been sent' });
  },
);

api.post(
  '/password/reset',
  {
    summary: 'Reset password with an email token or phone + OTP',
    rateLimit: limits.auth,
    body: z.union([
      z.object({ token: z.string().min(20).max(200), newPassword: password }),
      z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/), newPassword: password }),
    ]),
  },
  async (req, res) => {
    await service.resetPassword(req.body);
    clearAuthCookies(res);
    ok(res, null, { message: 'Password updated. Please log in again.' });
  },
);

api.post(
  '/password/change',
  { summary: 'Change password (other sessions are revoked)', auth: 'required', rateLimit: limits.auth, body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }) },
  async (req, res) => {
    await service.changePassword(req.auth.userId, req.auth.sessionId, req.body);
    ok(res, null, { message: 'Password changed' });
  },
);

module.exports = { router: api, passwordSchema: password, setAuthCookies, clearAuthCookies };
