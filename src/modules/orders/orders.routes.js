'use strict';

const { z } = require('zod');
const Order = require('./order.model');
const service = require('./order.service');
const { Shipment } = require('../shipping/shipping.models');
const { Payment, Refund } = require('../payments/payment.models');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, paginationSchema, paginate, escapeRegex, dateFilter } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { ORDER_STATUS, PAYMENT_STATUS } = require('../../constants/statuses');
const { getSettings } = require('../settings/settings');

const ref = z.object({ id: z.string().min(6).max(40) });

// ------------------------------------------------------------------ customer
const me = createRouter({ prefix: '/api/v1/orders', tag: 'Orders' });

me.get('/', { summary: 'My order history', customer: true, query: paginationSchema.extend({ status: z.enum(Object.values(ORDER_STATUS)).optional() }) }, async (req, res) => {
  const { page, limit, status } = req.query;
  const filter = { user: req.auth.userId, ...(status ? { status } : {}) };
  const { items, meta } = await paginate(Order, filter, { page, limit, select: 'orderNumber status paymentMethod paymentStatus pricing.total items.name items.image items.quantity items.sku createdAt deliveredAt estimatedDeliveryDate' });
  ok(res, items.map((o) => ({ id: o._id, orderNumber: o.orderNumber, status: o.status, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, total: o.pricing.total, items: o.items, createdAt: o.createdAt, deliveredAt: o.deliveredAt, estimatedDeliveryDate: o.estimatedDeliveryDate })), { meta });
});

me.get('/:id', { summary: 'Order detail (by id or order number)', customer: true, params: ref }, async (req, res) => {
  const order = await service.findOwned(req.auth.userId, req.params.id, { lean: true });
  const refunds = await Refund.find({ order: order._id }).sort({ createdAt: -1 }).lean();
  const { toCustomerView: refundView } = require('../refunds/refund.service');
  ok(res, { ...service.toCustomerView(order), refunds: refunds.map(refundView) });
});

me.get('/:id/tracking', { summary: 'Shipment tracking', customer: true, params: ref }, async (req, res) => {
  const order = await service.findOwned(req.auth.userId, req.params.id, { lean: true });
  const shipments = await Shipment.find({ $or: [{ order: order._id }] }).select('kind courier awb trackingUrl status events deliveredAt createdAt').sort({ createdAt: 1 }).lean();
  ok(res, { orderNumber: order.orderNumber, status: order.status, estimatedDeliveryDate: order.estimatedDeliveryDate, timeline: service.toCustomerView(order).timeline, shipments });
});

me.post('/:id/cancel', { summary: 'Cancel an order (before it is packed)', customer: true, params: ref, body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async (req, res) => {
  const { order, refund } = await service.cancelOrder(req.params.id, { actor: { type: 'customer', id: req.auth.userId }, reason: req.body.reason, customerId: req.auth.userId });
  ok(res, { order: service.toCustomerView(order.toObject ? order.toObject() : order), refund: refund ? { refundNumber: refund.refundNumber, amount: refund.amount, status: refund.status } : null }, { message: 'Order cancelled' });
});

me.get('/:id/invoice', { summary: 'Tax invoice data (GST-inclusive breakdown)', customer: true, params: ref }, async (req, res) => {
  const order = await service.findOwned(req.auth.userId, req.params.id, { lean: true });
  const settings = await getSettings();
  ok(res, {
    seller: { name: settings.store.name, gstin: settings.store.gstin },
    invoiceNumber: `INV-${order.orderNumber}`,
    orderNumber: order.orderNumber,
    date: order.confirmedAt || order.createdAt,
    billTo: order.shippingAddress,
    lines: order.items.map((i) => ({ description: i.name, sku: i.sku, hsn: i.hsnCode, quantity: i.quantity, gross: i.total, gstRateBps: i.gstRateBps, taxAmount: i.taxAmount, taxable: i.total - i.taxAmount })),
    charges: { shipping: order.pricing.shippingFee, codFee: order.pricing.codFee, giftWrap: order.pricing.giftWrapFee },
    taxTotal: order.pricing.taxTotal,
    total: order.pricing.total,
    note: 'All prices are inclusive of GST.',
  });
});

// ------------------------------------------------------------------ admin
const admin = createRouter({ prefix: '/api/v1/admin/orders', tag: 'Admin: Orders' });

admin.get(
  '/',
  {
    summary: 'Search orders',
    permission: PERMISSIONS.ORDERS_READ,
    query: paginationSchema.extend({
      q: z.string().trim().max(60).optional(),
      status: z.enum(Object.values(ORDER_STATUS)).optional(),
      paymentStatus: z.enum(Object.values(PAYMENT_STATUS)).optional(),
      paymentMethod: z.enum(['upi', 'cod']).optional(),
      customer: objectId().optional(),
      sku: z.string().max(64).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }),
  },
  async (req, res) => {
    const { page, limit, q, status, paymentStatus, paymentMethod, customer, sku, from, to } = req.query;
    const filter = {};
    if (q) filter.$or = [{ orderNumber: new RegExp(`^${escapeRegex(q.toUpperCase())}`) }, { 'shippingAddress.phone': new RegExp(escapeRegex(q)) }];
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (paymentMethod) filter.paymentMethod = paymentMethod;
    if (customer) filter.user = customer;
    if (sku) filter['items.sku'] = sku.toUpperCase();
    const created = dateFilter(from, to);
    if (created) filter.createdAt = created;
    const { items, meta } = await paginate(Order, filter, { page, limit, select: 'orderNumber user status paymentMethod paymentStatus pricing.total shippingAddress.fullName shippingAddress.city shippingAddress.pincode items.sku items.quantity createdAt flags', populate: { path: 'user', select: 'name email phone' } });
    ok(res, items, { meta });
  },
);

admin.get('/:id', { summary: 'Order detail with payment, shipments and refunds', permission: PERMISSIONS.ORDERS_READ, params: z.object({ id: objectId() }) }, async (req, res) => {
  const order = await Order.findById(req.params.id).populate('user', 'name email phone stats').lean();
  if (!order) throw notFound('Order');
  const [payment, shipments, refunds] = await Promise.all([
    Payment.findOne({ order: order._id }).lean(),
    Shipment.find({ order: order._id }).lean(),
    Refund.find({ order: order._id }).lean(),
  ]);
  ok(res, { ...order, payment, shipments, refunds });
});

admin.post(
  '/:id/status',
  {
    summary: 'Move an order through fulfilment (validated state machine)',
    permission: PERMISSIONS.ORDERS_WRITE,
    params: z.object({ id: objectId() }),
    body: z.object({ status: z.enum([ORDER_STATUS.PROCESSING, ORDER_STATUS.PACKED, ORDER_STATUS.SHIPPED, ORDER_STATUS.OUT_FOR_DELIVERY, ORDER_STATUS.DELIVERED, ORDER_STATUS.DELIVERY_FAILED, ORDER_STATUS.RTO, ORDER_STATUS.CANCELLED, ORDER_STATUS.COMPLETED]), note: z.string().max(300).optional() }),
  },
  async (req, res) => {
    const actor = { type: 'staff', id: req.auth.userId };
    ok(res, await service.staffTransition(req.params.id, req.body.status, { actor, note: req.body.note, req }), { message: 'Order updated' });
  },
);

admin.post('/:id/rto-received', { summary: 'RTO parcel received: units to quarantine, order cancelled, prepaid amount refunded', permission: PERMISSIONS.ORDERS_WRITE, params: z.object({ id: objectId() }), body: z.object({ note: z.string().max(300).optional() }) }, async (req, res) => {
  ok(res, await service.receiveRto(req.params.id, { actor: { type: 'staff', id: req.auth.userId }, note: req.body.note, req }), { message: 'RTO recorded' });
});

admin.post('/:id/notes', { summary: 'Add an internal note', permission: PERMISSIONS.ORDERS_WRITE, params: z.object({ id: objectId() }), body: z.object({ note: z.string().trim().min(1).max(1000) }) }, async (req, res) => {
  const order = await Order.findByIdAndUpdate(req.params.id, { $push: { adminNotes: { note: req.body.note, by: req.auth.userId } } }, { new: true }).select('adminNotes');
  if (!order) throw notFound('Order');
  await audit.record({ req, action: 'order.note', resource: { type: 'order', id: req.params.id } });
  ok(res, order.adminNotes);
});

module.exports = { routers: [me, admin] };
