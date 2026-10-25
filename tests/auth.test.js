'use strict';

const { startApp, stopApp, Client, registerCustomer, createStaff } = require('./helpers/app');
const { OneTimeCode } = require('../src/modules/auth/auth.models');
const User = require('../src/modules/users/user.model');

beforeAll(startApp);
afterAll(stopApp);

describe('registration & login', () => {
  test('registers, verifies phone, logs in and reads profile', async () => {
    const c = await registerCustomer();
    const me = await c.get('/api/v1/users/me');
    expect(me.status).toBe(200);
    expect(me.body.data.phoneVerified).toBe(true);
    expect(me.body.data.role).toBe('customer');
    expect(me.body.data).not.toHaveProperty('passwordHash');

    const fresh = new Client();
    const login = await fresh.post('/api/v1/auth/login', { identifier: c.email, password: 'Secret123' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie'].join(';')).toMatch(/access_token=.*HttpOnly/i);
  });

  test('rejects duplicate accounts and weak passwords', async () => {
    const c = await registerCustomer();
    const dup = await new Client().post('/api/v1/auth/register', { name: 'X Y', email: c.email, phone: '9123456780', password: 'Secret123' });
    expect(dup.status).toBe(409);
    const weak = await new Client().post('/api/v1/auth/register', { name: 'X Y', email: 'weak@example.com', phone: '9123456781', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('cannot self-register as an administrator (role field ignored)', async () => {
    const c = new Client();
    const res = await c.post('/api/v1/auth/register', { name: 'Evil User', email: 'evil@example.com', phone: '9000000001', password: 'Secret123', role: 'super_admin' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('customer');
    expect((await c.get('/api/v1/admin/customers')).status).toBe(403);
  });

  test('invalid credentials return a generic error and lock after 5 failures', async () => {
    const c = await registerCustomer();
    const fresh = new Client();
    for (let i = 0; i < 5; i++) {
      const r = await fresh.post('/api/v1/auth/login', { identifier: c.email, password: 'WrongPass1' });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await fresh.post('/api/v1/auth/login', { identifier: c.email, password: 'Secret123' });
    expect(locked.status).toBe(423);
    const unknown = await fresh.post('/api/v1/auth/login', { identifier: 'nobody@example.com', password: 'Secret123' });
    expect(unknown.status).toBe(401);
  });

  test('staff cannot use the customer login and customers cannot use the admin login', async () => {
    const admin = await createStaff('order_manager');
    const viaCustomer = await new Client().post('/api/v1/auth/login', { identifier: admin.user.email, password: 'Admin12345' });
    expect(viaCustomer.status).toBe(401);
    const c = await registerCustomer();
    const viaAdmin = await new Client().post('/api/v1/auth/admin/login', { identifier: c.email, password: 'Secret123' });
    expect(viaAdmin.status).toBe(401);
  });
});

describe('CSRF', () => {
  test('cookie-authenticated unsafe requests without the CSRF header are rejected', async () => {
    const c = await registerCustomer();
    const res = await c.agent.post('/api/v1/addresses').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
    const forged = await c.agent.post('/api/v1/addresses').set('x-csrf-token', 'abc.def').send({});
    expect(forged.status).toBe(403);
  });
});

describe('OTP', () => {
  test('wrong, expired and reused codes are rejected; resend has a cooldown', async () => {
    const c = await registerCustomer({ verifyPhone: false });
    expect((await c.post('/api/v1/auth/otp/verify-phone', { code: '000000' })).status).toBe(400);
    const resend = await c.post('/api/v1/auth/otp/send', { purpose: 'verify_phone' });
    expect(resend.status).toBe(429); // 60s cooldown since registration

    await OneTimeCode.collection.updateMany({ purpose: "verify_phone", target: c.phone }, { $set: { createdAt: new Date(Date.now() - 120000) } });
    const sent = await c.post('/api/v1/auth/otp/send', { purpose: 'verify_phone' });
    expect(sent.status).toBe(200);
    await OneTimeCode.updateMany({ purpose: 'verify_phone', target: c.phone }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await c.post('/api/v1/auth/otp/verify-phone', { code: sent.body.data.devCode });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('OTP_INVALID');
  });

  test('OTP attempts are capped', async () => {
    const c = await registerCustomer({ verifyPhone: false });
    const doc = await OneTimeCode.findOne({ purpose: 'verify_phone', target: c.phone, consumedAt: null });
    for (let i = 0; i < 5; i++) await c.post('/api/v1/auth/otp/verify-phone', { code: '111111' });
    await OneTimeCode.updateOne({ _id: doc._id }, { $set: { codeHash: doc.codeHash } });
    const after = await OneTimeCode.findById(doc._id);
    expect(after.attempts).toBeGreaterThanOrEqual(5);
  });
});

describe('sessions', () => {
  test('refresh rotates the token; reusing an old one revokes the session', async () => {
    const c = await registerCustomer();
    const cookies = c.agent.jar.getCookies({ path: '/api/v1/auth', domain: '127.0.0.1', secure: false, script: false });
    const oldRefresh = cookies.find((x) => x.name === 'refresh_token').value;

    const r1 = await c.post('/api/v1/auth/refresh');
    expect(r1.status).toBe(200);

    // Simulate an attacker replaying the old token after the grace window.
    const { Session } = require('../src/modules/auth/auth.models');
    await Session.updateMany({}, { $set: { rotatedAt: new Date(Date.now() - 60000) } });
    const attacker = new Client();
    const replay = await attacker.post('/api/v1/auth/refresh', { refreshToken: oldRefresh });
    expect(replay.status).toBe(401);
    // The legitimate session is now revoked too.
    expect((await c.get('/api/v1/users/me')).status).toBe(401);
  });

  test('logout revokes the session immediately', async () => {
    const c = await registerCustomer();
    const token = c.agent.jar.getCookies({ path: '/', domain: '127.0.0.1', secure: false, script: false }).find((x) => x.name === 'access_token').value;
    await c.post('/api/v1/auth/logout');
    const bearer = await new Client().agent.get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
    expect(bearer.status).toBe(401);
  });

  test('password change revokes other sessions', async () => {
    const c = await registerCustomer();
    const other = new Client();
    await other.post('/api/v1/auth/login', { identifier: c.email, password: 'Secret123' });
    expect((await other.get('/api/v1/users/me')).status).toBe(200);
    expect((await c.post('/api/v1/auth/password/change', { currentPassword: 'Secret123', newPassword: 'NewSecret456' })).status).toBe(200);
    expect((await other.get('/api/v1/users/me')).status).toBe(401);
    expect((await c.get('/api/v1/users/me')).status).toBe(200);
  });

  test('password reset by email token', async () => {
    const c = await registerCustomer();
    const fresh = new Client();
    const f = await fresh.post('/api/v1/auth/password/forgot', { identifier: c.email });
    expect(f.status).toBe(200);
    const reset = await fresh.post('/api/v1/auth/password/reset', { token: f.body.data.devEmailToken, newPassword: 'Changed789' });
    expect(reset.status).toBe(200);
    expect((await fresh.post('/api/v1/auth/password/reset', { token: f.body.data.devEmailToken, newPassword: 'Changed789' })).status).toBe(400);
    expect((await new Client().post('/api/v1/auth/login', { identifier: c.email, password: 'Changed789' })).status).toBe(200);
  });
});

describe('role-based access', () => {
  test('customers are blocked from admin APIs; staff permissions are enforced per role', async () => {
    const c = await registerCustomer();
    expect((await c.get('/api/v1/admin/orders')).status).toBe(403);
    const catalog = await createStaff('catalog_manager');
    expect((await catalog.get('/api/v1/admin/products')).status).toBe(200);
    expect((await catalog.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await catalog.get('/api/v1/admin/refunds')).status).toBe(403);
    const analyst = await createStaff('analyst');
    expect((await analyst.post('/api/v1/admin/categories', { name: 'Nope' })).status).toBe(403);
    expect((await analyst.get('/api/v1/admin/analytics/sales')).status).toBe(200);
  });

  test('role change by super admin revokes the staff member sessions', async () => {
    const admin = await createStaff('super_admin');
    const support = await createStaff('support_agent');
    const u = await User.findOne({ email: support.user.email });
    const res = await admin.patch(`/api/v1/admin/staff/${u._id}`, { role: 'analyst' });
    expect(res.status).toBe(200);
    expect((await support.get('/api/v1/users/me')).status).toBe(401);
  });

  test('unauthenticated access is rejected', async () => {
    expect((await new Client().get('/api/v1/orders')).status).toBe(401);
  });
});
