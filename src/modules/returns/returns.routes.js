'use strict';

const { z } = require('zod');
const ReturnRequest = require('./return.model');
const service = require('./return.service');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, paginationSchema, paginate } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { RETURN_STATUS, RETURN_REASONS } = require('../../constants/statuses');

const createBody = z.object({
  orderId: z.string().min(6).max(40),
  type: z.enum(['return', 'replacement', 'missing_item']),
  reason: z.enum(Object.values(RETURN_REASONS)),
  preferredResolution: z.enum(['refund', 'replacement']).optional(),
  description: z.string().trim().max(2000).optional(),
  photoIds: z.array(objectId()).max(8).default([]),
  items: z
    .array(
      z.object({
        orderItemId: objectId(),
        quantity: z.number().int().min(1).max(500),
        reason: z.enum(Object.values(RETURN_REASONS)).optional(),
        missingComponents: z.array(z.object({ sku: z.string().trim().toUpperCase().max(64), quantity: z.number().int().min(1).max(500) })).max(20).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const me = createRouter({ prefix: '/api/v1/returns', tag: 'Returns & Replacements' });

me.get('/eligibility/:orderId', { summary: 'What can be returned/replaced on an order, until when, and for which reasons', customer: true, params: z.object({ orderId: z.string().min(6).max(40) }) }, async (req, res) => {
  ok(res, await service.eligibility(req.auth.userId, req.params.orderId));
});

me.post('/', { summary: 'Create a return, replacement or missing-item request (photos via POST /uploads?purpose=return)', customer: true, body: createBody }, async (req, res) => {
  const { request, duplicate } = await service.createRequest(req.auth.userId, { ...req.body, idempotencyKey: req.get('idempotency-key') || undefined }, { source: 'customer' });
  const view = service.toCustomerView(request);
  if (duplicate) return ok(res, view, { message: 'Request already submitted' });
  created(res, view, request.status === 'awaiting_review' ? 'Request submitted for review' : 'Request approved');
});

me.get('/', { summary: 'My return & replacement requests', customer: true, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(ReturnRequest, { user: req.auth.userId }, req.query);
  ok(res, items.map(service.toCustomerView), { meta });
});

me.get('/:id', { summary: 'Request detail', customer: true, params: z.object({ id: objectId() }) }, async (req, res) => {
  const r = await ReturnRequest.findOne({ _id: req.params.id, user: req.auth.userId }).lean();
  if (!r) throw notFound('Request');
  ok(res, service.toCustomerView(r));
});

me.post('/:id/cancel', { summary: 'Cancel a request still under review', customer: true, params: z.object({ id: objectId() }) }, async (req, res) => {
  ok(res, service.toCustomerView(await service.cancelByCustomer(req.auth.userId, req.params.id)), { message: 'Request cancelled' });
});

// ------------------------------------------------------------------ admin
const admin = createRouter({ prefix: '/api/v1/admin/returns', tag: 'Admin: Returns' });
const idParam = z.object({ id: objectId() });

admin.get(
  '/',
  {
    summary: 'Return/replacement queue',
    permission: PERMISSIONS.RETURNS_READ,
    query: paginationSchema.extend({ status: z.enum(Object.values(RETURN_STATUS)).optional(), reason: z.enum(Object.values(RETURN_REASONS)).optional(), type: z.enum(['return', 'replacement', 'missing_item']).optional(), sku: z.string().max(64).optional() }),
  },
  async (req, res) => {
    const { page, limit, status, reason, type, sku } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (reason) filter.reason = reason;
    if (type) filter.type = type;
    if (sku) filter['items.sku'] = sku.toUpperCase();
    const { items, meta } = await paginate(ReturnRequest, filter, { page, limit, sort: { createdAt: 1 }, populate: { path: 'user', select: 'name phone email' } });
    ok(res, items, { meta });
  },
);

admin.get('/:id', { summary: 'Request detail', permission: PERMISSIONS.RETURNS_READ, params: idParam }, async (req, res) => {
  const r = await ReturnRequest.findById(req.params.id).populate('user', 'name email phone stats').populate('order', 'orderNumber status pricing deliveredAt paymentMethod paymentStatus').lean();
  if (!r) throw notFound('Request');
  ok(res, r);
});

admin.post(
  '/:id/review',
  {
    summary: 'Approve (with resolution) or reject a request',
    permission: PERMISSIONS.RETURNS_WRITE,
    params: idParam,
    body: z.discriminatedUnion('decision', [
      z.object({ decision: z.literal('approve'), resolution: z.enum(['refund', 'replacement']).optional(), amount: z.number().int().min(1).optional(), note: z.string().max(500).optional() }),
      z.object({ decision: z.literal('reject'), note: z.string().trim().min(5).max(500) }),
    ]),
  },
  async (req, res) => {
    ok(res, await service.review(req.params.id, req.body, req), { message: 'Request reviewed' });
  },
);

admin.post(
  '/:id/pickup',
  { summary: 'Schedule a reverse pickup', permission: PERMISSIONS.RETURNS_WRITE, params: idParam, body: z.object({ scheduledAt: z.coerce.date(), courier: z.string().max(40).optional(), awb: z.string().max(40).optional(), instructions: z.string().max(500).optional() }) },
  async (req, res) => {
    ok(res, await service.schedulePickup(req.params.id, req.body, req), { message: 'Pickup scheduled' });
  },
);

admin.post('/:id/received', { summary: 'Returned parcel received (units go to quarantine)', permission: PERMISSIONS.RETURNS_WRITE, params: idParam }, async (req, res) => {
  ok(res, await service.markReceived(req.params.id, req), { message: 'Marked received' });
});

admin.post(
  '/:id/inspection',
  {
    summary: 'Record inspection, stock dispositions and resolve',
    permission: [PERMISSIONS.RETURNS_WRITE],
    params: idParam,
    body: z.object({
      result: z.enum(['confirmed', 'partially_confirmed', 'not_confirmed']),
      notes: z.string().max(1000).optional(),
      dispositions: z.array(z.object({ sku: z.string().toUpperCase().max(64), quantity: z.number().int().min(1), decision: z.enum(['restock', 'damaged', 'unusable']) })).max(50).default([]),
      resolution: z.enum(['refund', 'replacement']).optional(),
      amount: z.number().int().min(1).optional(),
    }),
  },
  async (req, res) => {
    ok(res, await service.inspect(req.params.id, req.body, req), { message: 'Inspection recorded' });
  },
);

admin.post('/:id/close', { summary: 'Close a resolved/rejected request', permission: PERMISSIONS.RETURNS_WRITE, params: idParam }, async (req, res) => {
  ok(res, await service.close(req.params.id, req), { message: 'Request closed' });
});

module.exports = { routers: [me, admin], createBody };
