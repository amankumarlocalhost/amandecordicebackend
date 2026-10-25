'use strict';

const { z } = require('zod');
const { Notification, NotificationTemplate } = require('./notification.models');
const { DEFAULTS } = require('./notification.service');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { objectId, paginationSchema, paginate } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');

const me = createRouter({ prefix: '/api/v1/notifications', tag: 'Notifications' });

me.get('/', { summary: 'My notifications', auth: 'required', query: paginationSchema.extend({ unread: z.enum(['true']).optional() }) }, async (req, res) => {
  const filter = { user: req.auth.userId, ...(req.query.unread ? { readAt: null } : {}) };
  const [{ items, meta }, unread] = await Promise.all([
    paginate(Notification, filter, { page: req.query.page, limit: req.query.limit, select: 'type category title body data readAt createdAt' }),
    Notification.countDocuments({ user: req.auth.userId, readAt: null }),
  ]);
  ok(res, items, { meta: { ...meta, unread } });
});

me.get('/unread-count', { summary: 'Unread notification count', auth: 'required' }, async (req, res) => {
  ok(res, { unread: await Notification.countDocuments({ user: req.auth.userId, readAt: null }) });
});

me.post('/read', { summary: 'Mark notifications read (ids, or all)', auth: 'required', body: z.object({ ids: z.array(objectId()).max(200).optional(), all: z.boolean().optional() }) }, async (req, res) => {
  const filter = { user: req.auth.userId, readAt: null };
  if (!req.body.all) filter._id = { $in: req.body.ids || [] };
  const r = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  ok(res, { updated: r.modifiedCount });
});

const admin = createRouter({ prefix: '/api/v1/admin/notification-templates', tag: 'Admin: Notifications' });

admin.get('/', { summary: 'Templates (defaults + overrides)', permission: PERMISSIONS.NOTIFICATIONS_MANAGE }, async (req, res) => {
  const overrides = await NotificationTemplate.find().lean();
  ok(res, { defaults: DEFAULTS, overrides });
});

admin.put(
  '/:type/:channel',
  {
    summary: 'Override a template. Placeholders use {{name}} syntax.',
    permission: PERMISSIONS.NOTIFICATIONS_MANAGE,
    params: z.object({ type: z.enum(Object.keys(DEFAULTS)), channel: z.enum(['inApp', 'email', 'sms', 'whatsapp']) }),
    body: z.object({ subject: z.string().max(200).optional(), body: z.string().min(1).max(5000), isActive: z.boolean().default(true) }),
  },
  async (req, res) => {
    const t = await NotificationTemplate.findOneAndUpdate({ type: req.params.type, channel: req.params.channel }, { $set: { ...req.body, updatedBy: req.auth.userId } }, { upsert: true, new: true });
    await audit.record({ req, action: 'notification_template.update', resource: { type: 'template', id: `${req.params.type}:${req.params.channel}` } });
    ok(res, t, { message: 'Template saved' });
  },
);

module.exports = { routers: [me, admin] };
