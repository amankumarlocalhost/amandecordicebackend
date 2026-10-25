'use strict';

const { z } = require('zod');
const service = require('./payment.service');
const { Payment, WebhookEvent } = require('./payment.models');
const Order = require('../orders/order.model');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { objectId, paginationSchema, paginate, dateFilter } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { PAYMENT_STATUS } = require('../../constants/statuses');
const logger = require('../../config/logger');

// ------------------------------------------------------------------ customer
const me = createRouter({ prefix: '/api/v1/payments', tag: 'Payments' });

me.post(
  '/razorpay/verify',
  {
    summary: 'Verify the Razorpay Checkout callback. The order is confirmed only after signature + server-side payment fetch.',
    customer: true,
    body: z.object({ razorpay_order_id: z.string().max(64), razorpay_payment_id: z.string().max(64), razorpay_signature: z.string().max(256) }),
  },
  async (req, res) => {
    const result = await service.verifyCheckout(req.auth.userId, req.body);
    const message = { confirmed: 'Payment successful', duplicate: 'Payment already recorded', refunding: 'Payment received but the order could not be fulfilled; a full refund has been initiated', failed: 'Payment failed' }[result.outcome] || 'Payment status updated';
    ok(res, result, { message });
  },
);

me.post('/orders/:id/retry', { summary: 'Retry UPI payment for a pending order', customer: true, params: z.object({ id: z.string().min(6).max(40) }) }, async (req, res) => {
  ok(res, await service.retryPayment(req.auth.userId, req.params.id));
});

// ------------------------------------------------------------------ webhook (raw body, signature-authenticated)
const hooks = createRouter({ prefix: '/api/v1/webhooks', tag: 'Webhooks' });

hooks.post('/razorpay', { summary: 'Razorpay webhook (HMAC-SHA256 over the raw body; idempotent by event id)' }, async (req, res) => {
  try {
    const result = await service.handleWebhook(req.body, req.headers);
    res.status(200).json({ success: true, duplicate: result.duplicate });
  } catch (err) {
    if (err.code === 'SIGNATURE_INVALID') return res.status(400).json({ success: false, message: 'Invalid signature' });
    logger.error({ err: err.message }, 'webhook processing failed');
    res.status(500).json({ success: false, message: 'Processing failed; please retry' }); // Razorpay retries
  }
});

// ------------------------------------------------------------------ admin
const admin = createRouter({ prefix: '/api/v1/admin/payments', tag: 'Admin: Payments' });

admin.get(
  '/',
  {
    summary: 'Payment transactions',
    permission: PERMISSIONS.PAYMENTS_READ,
    query: paginationSchema.extend({ status: z.string().max(30).optional(), method: z.enum(['upi', 'cod']).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
  },
  async (req, res) => {
    const { page, limit, status, method, from, to } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (method) filter.method = method;
    const created = dateFilter(from, to);
    if (created) filter.createdAt = created;
    const { items, meta } = await paginate(Payment, filter, { page, limit, populate: { path: 'order', select: 'orderNumber status paymentStatus' } });
    ok(res, items, { meta });
  },
);

admin.get('/reconciliation', { summary: 'Pending/mismatched payments needing attention', permission: PERMISSIONS.PAYMENTS_READ }, async (req, res) => {
  const [pendingUpi, authorized, failedWebhooks, codOutstanding] = await Promise.all([
    Order.find({ paymentMethod: 'upi', status: 'pending' }).select('orderNumber pricing.total createdAt reservationExpiresAt').sort({ createdAt: 1 }).limit(100).lean(),
    Payment.find({ status: 'authorized' }).select('order providerOrderId amount updatedAt').limit(100).lean(),
    WebhookEvent.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(50).lean(),
    Order.aggregate([
      { $match: { paymentMethod: 'cod', paymentStatus: PAYMENT_STATUS.COD_DUE, status: { $nin: ['cancelled'] } } },
      { $group: { _id: '$status', orders: { $sum: 1 }, amount: { $sum: '$pricing.total' } } },
    ]),
  ]);
  ok(res, { pendingUpi, authorized, failedWebhooks, codOutstanding });
});

admin.post('/reconcile', { summary: 'Run UPI reconciliation now', permission: PERMISSIONS.PAYMENTS_READ }, async (req, res) => {
  ok(res, await service.reconcilePending({ olderThanMs: 0 }), { message: 'Reconciliation finished' });
});

admin.post(
  '/cod/:orderId/collected',
  { summary: 'Mark COD cash collected (marks delivered if needed)', permission: PERMISSIONS.PAYMENTS_COD, params: z.object({ orderId: objectId() }), body: z.object({ amount: z.number().int().min(1) }) },
  async (req, res) => {
    ok(res, await service.markCodCollected(req.params.orderId, { amount: req.body.amount, actor: { type: 'staff', id: req.auth.userId }, req }), { message: 'COD collected' });
  },
);

admin.post(
  '/cod/settle',
  { summary: 'Record a courier COD remittance for collected orders', permission: PERMISSIONS.PAYMENTS_COD, body: z.object({ orderIds: z.array(objectId()).min(1).max(500), remittanceRef: z.string().trim().min(3).max(80) }) },
  async (req, res) => {
    ok(res, await service.settleCod(req.body.orderIds, req.body.remittanceRef, req), { message: 'Remittance recorded' });
  },
);

module.exports = { routers: [me, hooks, admin] };
