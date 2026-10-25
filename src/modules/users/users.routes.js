'use strict';

const { z } = require('zod');
const User = require('./user.model');
const authService = require('../auth/auth.service');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, unauthorized, badRequest, forbidden } = require('../../utils/errors');
const { emailSchema, phoneSchema, paginationSchema, paginate, escapeRegex, objectId } = require('../../utils/common');
const { PERMISSIONS, ROLES, STAFF_ROLES, permissionsFor } = require('../../constants/roles');
const { passwordSchema, clearAuthCookies } = require('../auth/auth.routes');

const prefSchema = z.object({ orders: z.boolean(), support: z.boolean(), marketing: z.boolean() }).partial();

// ------------------------------------------------------------- customer self-service
const me = createRouter({ prefix: '/api/v1/users', tag: 'Users' });

me.get('/me', { summary: 'Current user profile', auth: 'required' }, async (req, res) => {
  const user = await User.findById(req.auth.userId);
  if (!user) throw notFound('User');
  ok(res, { ...user.toSafeJSON(), permissions: permissionsFor(user.role) });
});

me.patch(
  '/me',
  {
    summary: 'Update profile. Changing email/phone resets its verification.',
    auth: 'required',
    body: z.object({ name: z.string().trim().min(2).max(100), email: emailSchema, phone: phoneSchema }).partial(),
  },
  async (req, res) => {
    const user = await User.findById(req.auth.userId);
    if (!user) throw notFound('User');
    const { name, email, phone } = req.body;
    if (name) user.name = name;
    if (email && email !== user.email) {
      user.email = email;
      user.emailVerifiedAt = undefined;
    }
    if (phone && phone !== user.phone) {
      user.phone = phone;
      user.phoneVerifiedAt = undefined;
    }
    await user.save();
    ok(res, user.toSafeJSON(), { message: 'Profile updated' });
  },
);

me.patch(
  '/me/notification-preferences',
  {
    summary: 'Update notification preferences per channel',
    auth: 'required',
    body: z.object({ inApp: prefSchema, email: prefSchema, sms: prefSchema, whatsapp: prefSchema }).partial(),
  },
  async (req, res) => {
    const set = {};
    for (const [channel, prefs] of Object.entries(req.body)) {
      for (const [k, v] of Object.entries(prefs)) set[`notificationPreferences.${channel}.${k}`] = v;
    }
    const user = await User.findByIdAndUpdate(req.auth.userId, { $set: set }, { new: true });
    ok(res, user.notificationPreferences, { message: 'Preferences updated' });
  },
);

me.post(
  '/me/deactivate',
  { summary: 'Deactivate account (log in again to reactivate)', customer: true, body: z.object({ password: z.string().min(1).max(128) }) },
  async (req, res) => {
    if (!(await authService.verifyPassword(req.auth.userId, req.body.password))) throw unauthorized('Password is incorrect', 'INVALID_CREDENTIALS');
    await User.updateOne({ _id: req.auth.userId }, { $set: { status: 'deactivated', deactivatedAt: new Date() } });
    await authService.revokeAllSessions(req.auth.userId, { reason: 'deactivated' });
    await audit.record({ req, action: 'user.deactivate', resource: { type: 'user', id: req.auth.userId } });
    clearAuthCookies(res);
    ok(res, null, { message: 'Account deactivated' });
  },
);

me.post(
  '/me/delete-request',
  {
    summary: 'Request account deletion. Personal data is anonymised after a 14-day grace period; order and tax records are retained as required by law.',
    customer: true,
    body: z.object({ password: z.string().min(1).max(128), reason: z.string().max(500).optional() }),
  },
  async (req, res) => {
    if (!(await authService.verifyPassword(req.auth.userId, req.body.password))) throw unauthorized('Password is incorrect', 'INVALID_CREDENTIALS');
    await User.updateOne({ _id: req.auth.userId }, { $set: { status: 'deletion_requested', deletionRequestedAt: new Date() } });
    await authService.revokeAllSessions(req.auth.userId, { reason: 'deletion_requested' });
    await audit.record({ req, action: 'user.deletion_requested', resource: { type: 'user', id: req.auth.userId }, metadata: { reason: req.body.reason } });
    clearAuthCookies(res);
    ok(res, null, { message: 'Deletion requested. Contact support within 14 days to cancel.' });
  },
);

// ------------------------------------------------------------- admin: customers & staff
const admin = createRouter({ prefix: '/api/v1/admin', tag: 'Admin: Users' });

const listQuery = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'suspended', 'deactivated', 'deletion_requested', 'deleted']).optional(),
});

function searchFilter(q) {
  if (!q) return {};
  const rx = new RegExp(escapeRegex(q), 'i');
  return { $or: [{ name: rx }, { email: rx }, { phone: rx }] };
}

admin.get('/customers', { summary: 'List customers', permission: PERMISSIONS.CUSTOMERS_READ, query: listQuery }, async (req, res) => {
  const { page, limit, q, status } = req.query;
  const filter = { role: ROLES.CUSTOMER, ...searchFilter(q) };
  if (status) filter.status = status;
  const { items, meta } = await paginate(User, filter, { page, limit, select: 'name email phone status stats emailVerifiedAt phoneVerifiedAt createdAt lastLoginAt' });
  ok(res, items, { meta });
});

admin.get('/customers/:id', { summary: 'Customer detail', permission: PERMISSIONS.CUSTOMERS_READ, params: z.object({ id: objectId() }) }, async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: ROLES.CUSTOMER }).lean();
  if (!user) throw notFound('Customer');
  const Address = require('../addresses/address.model');
  const addresses = await Address.find({ user: user._id }).lean();
  await audit.record({ req, action: 'customer.view', resource: { type: 'user', id: user._id } });
  ok(res, { ...user, addresses });
});

admin.patch(
  '/customers/:id/status',
  {
    summary: 'Suspend or reactivate a customer',
    permission: PERMISSIONS.CUSTOMERS_WRITE,
    params: z.object({ id: objectId() }),
    body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().max(500) }),
  },
  async (req, res) => {
    const user = await User.findOneAndUpdate({ _id: req.params.id, role: ROLES.CUSTOMER }, { $set: { status: req.body.status } }, { new: true });
    if (!user) throw notFound('Customer');
    if (req.body.status !== 'active') await authService.revokeAllSessions(user._id, { reason: 'suspended' });
    await audit.record({ req, action: 'customer.status_change', resource: { type: 'user', id: user._id }, metadata: req.body });
    ok(res, user.toSafeJSON(), { message: 'Customer updated' });
  },
);

admin.get('/staff', { summary: 'List staff accounts', permission: PERMISSIONS.STAFF_MANAGE, query: listQuery }, async (req, res) => {
  const { page, limit, q, status } = req.query;
  const filter = { role: { $in: STAFF_ROLES }, ...searchFilter(q) };
  if (status) filter.status = status;
  const { items, meta } = await paginate(User, filter, { page, limit, select: 'name email phone role status lastLoginAt createdAt' });
  ok(res, items, { meta });
});

admin.post(
  '/staff',
  {
    summary: 'Create a staff account (customers can never self-register as staff)',
    permission: PERMISSIONS.STAFF_MANAGE,
    body: z.object({ name: z.string().trim().min(2).max(100), email: emailSchema, phone: phoneSchema.optional(), role: z.enum(STAFF_ROLES), password: passwordSchema }),
  },
  async (req, res) => {
    const user = await User.create({
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      role: req.body.role,
      passwordHash: await authService.hashPassword(req.body.password),
      emailVerifiedAt: new Date(),
      createdBy: req.auth.userId,
    });
    await audit.record({ req, action: 'staff.create', resource: { type: 'user', id: user._id }, metadata: { role: user.role } });
    created(res, user.toSafeJSON(), 'Staff account created');
  },
);

admin.patch(
  '/staff/:id',
  {
    summary: 'Change a staff member role or status (sessions are revoked)',
    permission: PERMISSIONS.STAFF_MANAGE,
    params: z.object({ id: objectId() }),
    body: z.object({ role: z.enum(STAFF_ROLES), status: z.enum(['active', 'suspended']) }).partial(),
  },
  async (req, res) => {
    if (String(req.params.id) === req.auth.userId) throw forbidden('You cannot change your own role or status');
    if (!Object.keys(req.body).length) throw badRequest('Nothing to update');
    const user = await User.findOneAndUpdate({ _id: req.params.id, role: { $in: STAFF_ROLES } }, { $set: req.body }, { new: true });
    if (!user) throw notFound('Staff member');
    await authService.revokeAllSessions(user._id, { reason: 'role_or_status_changed' });
    await audit.record({ req, action: 'staff.update', resource: { type: 'user', id: user._id }, metadata: req.body });
    ok(res, user.toSafeJSON(), { message: 'Staff updated' });
  },
);

module.exports = { routers: [me, admin] };
