'use strict';

const { z } = require('zod');
const service = require('./refund.service');
const { Refund } = require('../payments/payment.models');
const Order = require('../orders/order.model');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, paginationSchema, paginate } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { REFUND_STATUS } = require('../../constants/statuses');

const me = createRouter({ prefix: '/api/v1/refunds', tag: 'Refunds' });

me.get('/', { summary: 'My refunds', customer: true, query: paginationSchema }, async (req, res) => {
  const { items, meta } = await paginate(Refund, { user: req.auth.userId }, req.query);
  ok(res, items.map(service.toCustomerView), { meta });
});

me.post(
  '/:id/destination',
  {
    summary: 'Provide UPI ID or bank account for a COD refund',
    customer: true,
    params: z.object({ id: objectId() }),
    body: z.union([
      z.object({ vpa: z.string().trim().toLowerCase().regex(/^[\w.-]{2,256}@[a-z]{2,64}$/, 'Invalid UPI ID') }),
      z.object({ accountName: z.string().trim().min(2).max(100), accountNumber: z.string().regex(/^\d{9,18}$/), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/) }),
    ]),
  },
  async (req, res) => {
    const destination = req.body.vpa
      ? { vpa: req.body.vpa }
      : { accountName: req.body.accountName, accountLast4: req.body.accountNumber.slice(-4), ifsc: req.body.ifsc };
    // Full bank account numbers are never stored; staff confirm the payout details with the customer out-of-band.
    const r = await service.provideDestination(req.params.id, req.auth.userId, destination);
    ok(res, service.toCustomerView(r), { message: 'Payout details saved' });
  },
);

const admin = createRouter({ prefix: '/api/v1/admin/refunds', tag: 'Admin: Refunds' });

admin.get(
  '/',
  { summary: 'Refunds queue', permission: [PERMISSIONS.PAYMENTS_READ, PERMISSIONS.REFUNDS_REQUEST], query: paginationSchema.extend({ status: z.enum(Object.values(REFUND_STATUS)).optional(), order: objectId().optional() }) },
  async (req, res) => {
    const { page, limit, status, order } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (order) filter.order = order;
    const { items, meta } = await paginate(Refund, filter, { page, limit, populate: { path: 'order', select: 'orderNumber paymentMethod pricing.total' } });
    ok(res, items, { meta });
  },
);

admin.post(
  '/',
  {
    summary: 'Request a refund on an order (goodwill / adjustment). Needs approval unless the requester can approve.',
    permission: PERMISSIONS.REFUNDS_REQUEST,
    body: z.object({ orderId: objectId(), amount: z.number().int().min(1), type: z.enum(['goodwill', 'adjustment', 'damage', 'missing_item']), reason: z.string().trim().min(5).max(500) }),
  },
  async (req, res) => {
    const order = await Order.findById(req.body.orderId);
    if (!order) throw notFound('Order');
    const refund = await service.createRefund({
      order,
      amount: req.body.amount,
      type: req.body.type,
      reason: req.body.reason,
      requestedBy: { type: 'staff', id: req.auth.userId },
      autoApprove: false,
      idempotencyKey: `${order._id}:${req.body.type}:${req.get('idempotency-key') || Date.now()}`,
    });
    await audit.record({ req, action: 'refund.request', resource: { type: 'refund', id: refund._id }, metadata: req.body });
    created(res, refund, 'Refund requested');
  },
);

admin.post('/:id/approve', { summary: 'Approve a refund (role limits apply)', permission: [PERMISSIONS.REFUNDS_APPROVE, PERMISSIONS.REFUNDS_APPROVE_LIMITED], params: z.object({ id: objectId() }) }, async (req, res) => {
  ok(res, await service.approve(req.params.id, req), { message: 'Refund approved' });
});

admin.post('/:id/reject', { summary: 'Reject a pending refund', permission: [PERMISSIONS.REFUNDS_APPROVE, PERMISSIONS.REFUNDS_APPROVE_LIMITED], params: z.object({ id: objectId() }), body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async (req, res) => {
  ok(res, await service.reject(req.params.id, req.body.reason, req), { message: 'Refund rejected' });
});

admin.post(
  '/:id/manual-processed',
  { summary: 'Confirm a manual (COD) payout with its bank/UPI reference', permission: [PERMISSIONS.REFUNDS_APPROVE, PERMISSIONS.REFUNDS_APPROVE_LIMITED], params: z.object({ id: objectId() }), body: z.object({ reference: z.string().trim().min(4).max(80) }) },
  async (req, res) => {
    ok(res, await service.markManualProcessed(req.params.id, req.body.reference, req), { message: 'Refund marked processed' });
  },
);

admin.post('/:id/retry', { summary: 'Retry a provider refund that is approved/processing', permission: PERMISSIONS.REFUNDS_APPROVE, params: z.object({ id: objectId() }) }, async (req, res) => {
  await service.processRefund({ refundId: req.params.id });
  ok(res, await Refund.findById(req.params.id).lean(), { message: 'Refund processing attempted' });
});

module.exports = { routers: [me, admin] };
