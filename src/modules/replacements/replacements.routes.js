'use strict';

const { z } = require('zod');
const Replacement = require('./replacement.model');
const service = require('./replacement.service');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, paginationSchema, paginate } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { REPLACEMENT_STATUS } = require('../../constants/statuses');

const me = createRouter({ prefix: '/api/v1/replacements', tag: 'Returns & Replacements' });

me.get('/', { summary: 'My replacements', customer: true, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(Replacement, { user: req.auth.userId }, { ...req.query, select: 'replacementNumber orderNumber items status shippedAt deliveredAt createdAt timeline' });
  ok(res, items, { meta });
});

me.get('/:id', { summary: 'Replacement detail with tracking', customer: true, params: z.object({ id: objectId() }) }, async (req, res) => {
  const r = await Replacement.findOne({ _id: req.params.id, user: req.auth.userId }).populate('shipment', 'courier awb trackingUrl status events').lean();
  if (!r) throw notFound('Replacement');
  ok(res, r);
});

const admin = createRouter({ prefix: '/api/v1/admin/replacements', tag: 'Admin: Returns' });

admin.get('/', { summary: 'Replacement queue', permission: PERMISSIONS.RETURNS_READ, query: paginationSchema.extend({ status: z.enum(Object.values(REPLACEMENT_STATUS)).optional() }) }, async (req, res) => {
  const { page, limit, status } = req.query;
  const { items, meta } = await paginate(Replacement, status ? { status } : {}, { page, limit, sort: { createdAt: 1 } });
  ok(res, items, { meta });
});

admin.post(
  '/:id/ship',
  { summary: 'Ship a replacement (no customer charge)', permission: PERMISSIONS.SHIPMENTS_WRITE, params: z.object({ id: objectId() }), body: z.object({ courier: z.string().max(40).default('manual'), awb: z.string().trim().min(4).max(40), trackingUrl: z.string().url().optional() }) },
  async (req, res) => {
    const result = await service.ship(req.params.id, req.body, { type: 'staff', id: req.auth.userId });
    await audit.record({ req, action: 'replacement.ship', resource: { type: 'replacement', id: req.params.id }, metadata: { awb: req.body.awb } });
    ok(res, result, { message: 'Replacement shipped' });
  },
);

admin.post('/:id/cancel', { summary: 'Cancel an unshipped replacement (allocated stock returns to shelf)', permission: PERMISSIONS.RETURNS_WRITE, params: z.object({ id: objectId() }), body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async (req, res) => {
  const r = await service.cancel(req.params.id, req.body.reason, { type: 'staff', id: req.auth.userId });
  await audit.record({ req, action: 'replacement.cancel', resource: { type: 'replacement', id: req.params.id }, metadata: req.body });
  ok(res, r, { message: 'Replacement cancelled' });
});

admin.post('/allocate', { summary: 'Retry stock allocation for back-ordered replacements', permission: PERMISSIONS.RETURNS_WRITE }, async (req, res) => {
  await service.allocateAwaitingStock();
  ok(res, null, { message: 'Allocation run complete' });
});

module.exports = { routers: [me, admin] };
