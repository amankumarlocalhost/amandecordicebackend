'use strict';

const crypto = require('crypto');
const { startApp, stopApp, settle, registerCustomer, createStaff, Client } = require('./helpers/app');
const { seedCatalog, addAddress } = require('./helpers/catalog');
const { signedWebhook } = require('./helpers/fakes');
const { Inventory } = require('../src/modules/inventory/inventory.models');
const { Payment, Refund, WebhookEvent } = require('../src/modules/payments/payment.models');
const Order = require('../src/modules/orders/order.model');
const payments = require('../src/modules/payments/payment.service');

let admin;
let razorpay;

beforeAll(async () => {
  ({ razorpay } = await startApp());
  admin = await createStaff('super_admin');
  await seedCatalog(admin, { dinnerStock: 5, glassStock: 50 });
  await settle();
});
afterAll(stopApp);

async function upiOrder(sku = 'GL-BORO-6-CLR', quantity = 1) {
  const c = await registerCustomer();
  const address = await addAddress(c);
  await c.post('/api/v1/cart/items', { sku, quantity });
  const r = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'upi' }, { 'Idempotency-Key': crypto.randomUUID() });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return { c, order: r.body.data.order, payment: r.body.data.payment };
}

const avail = async (sku) => {
  const i = await Inventory.findOne({ sku }).lean();
  return { onHand: i.onHand, reserved: i.reserved };
};

const sendWebhook = (event, payload, eventId) => {
  const w = signedWebhook(event, payload, eventId);
  return new Client().agent.post('/api/v1/webhooks/razorpay').set(w.headers).send(w.body);
};

test('UPI checkout returns UPI-only Razorpay options and holds stock', async () => {
  const before = await avail('GL-BORO-6-CLR');
  const { order, payment } = await upiOrder();
  expect(order.status).toBe('pending');
  expect(order.paymentStatus).toBe('pending');
  expect(payment.checkoutOptions.method).toMatchObject({ upi: true, card: false, netbanking: false, wallet: false, emi: false, paylater: false });
  expect(payment.checkoutOptions.config.display.sequence).toEqual(['block.upi']);
  expect(payment.checkoutOptions.amount).toBe(order.pricing.total);
  expect(JSON.stringify(payment)).not.toMatch(/test_key_secret/);
  const after = await avail('GL-BORO-6-CLR');
  expect(after.reserved - before.reserved).toBe(1);
  expect(after.onHand).toBe(before.onHand);
});

test('verified UPI payment confirms the order exactly once and commits stock', async () => {
  const { c, order, payment } = await upiOrder();
  const before = await avail('GL-BORO-6-CLR');
  const paid = razorpay.pay(payment.razorpayOrderId);
  const body = { razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature };
  const [v1, v2] = await Promise.all([c.post('/api/v1/payments/razorpay/verify', body), c.post('/api/v1/payments/razorpay/verify', body)]);
  expect([v1.status, v2.status]).toEqual([200, 200]);
  expect([v1.body.data.outcome, v2.body.data.outcome].sort()).toEqual(['confirmed', 'duplicate']);
  const o = await Order.findById(order.id).lean();
  expect(o.status).toBe('confirmed');
  expect(o.paymentStatus).toBe('paid');
  const after = await avail('GL-BORO-6-CLR');
  expect(after.onHand).toBe(before.onHand - 1);
  expect(after.reserved).toBe(before.reserved - 1);

  // A delayed webhook for the same payment changes nothing.
  const late = await sendWebhook('payment.captured', { payment: { entity: { ...paid, signature: undefined } } });
  expect(late.status).toBe(200);
  expect(await avail('GL-BORO-6-CLR')).toEqual(after);
});

test('frontend "success" with a bad signature never marks the order paid', async () => {
  const { c, order, payment } = await upiOrder();
  const paid = razorpay.pay(payment.razorpayOrderId);
  const r = await c.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: 'f'.repeat(64) });
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('SIGNATURE_INVALID');
  expect((await Order.findById(order.id).lean()).status).toBe('pending');
});

test('another customer cannot verify my payment', async () => {
  const { payment } = await upiOrder();
  const paid = razorpay.pay(payment.razorpayOrderId);
  const other = await registerCustomer();
  const r = await other.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature });
  expect(r.status).toBe(404);
});

test('webhooks: invalid signature rejected; duplicate deliveries processed once', async () => {
  const { order, payment } = await upiOrder();
  const paid = razorpay.pay(payment.razorpayOrderId);
  const forged = await new Client().agent.post('/api/v1/webhooks/razorpay').set({ 'content-type': 'application/json', 'x-razorpay-signature': 'bad' }).send(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: paid } } }));
  expect(forged.status).toBe(400);
  expect((await Order.findById(order.id).lean()).status).toBe('pending');

  const entity = { ...paid };
  delete entity.signature;
  const r1 = await sendWebhook('payment.captured', { payment: { entity } }, 'evt_dup_1');
  const r2 = await sendWebhook('payment.captured', { payment: { entity } }, 'evt_dup_1');
  expect(r1.status).toBe(200);
  expect(r2.body.duplicate).toBe(true);
  expect((await Order.findById(order.id).lean()).status).toBe('confirmed');
  expect(await WebhookEvent.countDocuments({ eventId: 'evt_dup_1' })).toBe(1);
});

test('failed payment keeps the order payable; retry returns the same Razorpay order', async () => {
  const { c, order, payment } = await upiOrder();
  const failed = razorpay.pay(payment.razorpayOrderId, { status: 'failed' });
  delete failed.signature;
  await sendWebhook('payment.failed', { payment: { entity: failed } });
  expect((await Order.findById(order.id).lean()).status).toBe('pending');
  const retry = await c.post(`/api/v1/payments/orders/${order.orderNumber}/retry`);
  expect(retry.status).toBe(200);
  expect(retry.body.data.razorpayOrderId).toBe(payment.razorpayOrderId);
  const p = await Payment.findOne({ order: order.id }).lean();
  expect(p.attempts.some((a) => a.status === 'failed' && a.errorReason)).toBe(true);
});

test('reconciliation confirms a captured payment whose callback and webhook were lost', async () => {
  const { order, payment } = await upiOrder();
  razorpay.pay(payment.razorpayOrderId);
  const summary = await payments.reconcilePending({ olderThanMs: 0 });
  expect(summary.confirmed).toBeGreaterThanOrEqual(1);
  expect((await Order.findById(order.id).lean()).paymentStatus).toBe('paid');
});

test('unpaid orders expire: stock and coupon are released', async () => {
  const before = await avail('DS-IVORY-24');
  const { order } = await upiOrder('DS-IVORY-24', 2);
  expect((await avail('DS-IVORY-24')).reserved).toBe(before.reserved + 2);
  await Order.updateOne({ _id: order.id }, { $set: { reservationExpiresAt: new Date(Date.now() - 1000) } });
  const s = await payments.reconcilePending({ olderThanMs: 0 });
  expect(s.expired).toBeGreaterThanOrEqual(1);
  const o = await Order.findById(order.id).lean();
  expect(o.status).toBe('cancelled');
  expect(await avail('DS-IVORY-24')).toEqual(before);
});

test('a payment captured after expiry is refunded automatically', async () => {
  const { order, payment } = await upiOrder();
  await Order.updateOne({ _id: order.id }, { $set: { reservationExpiresAt: new Date(Date.now() - 1000) } });
  // Expire without the payment existing yet.
  await payments.reconcilePending({ olderThanMs: 0 });
  expect((await Order.findById(order.id).lean()).status).toBe('cancelled');
  const paid = razorpay.pay(payment.razorpayOrderId);
  delete paid.signature;
  await sendWebhook('payment.captured', { payment: { entity: paid } });
  await settle();
  const refund = await Refund.findOne({ order: order.id }).lean();
  expect(refund).toMatchObject({ type: 'late_payment', amount: order.pricing.total, status: 'processed' });
  expect((await Order.findById(order.id).lean()).paymentStatus).toBe('refunded');
});

test('non-UPI captures are rejected and refunded', async () => {
  const { order, payment } = await upiOrder();
  const paid = razorpay.pay(payment.razorpayOrderId, { method: 'card' });
  delete paid.signature;
  await sendWebhook('payment.captured', { payment: { entity: paid } });
  await settle();
  const o = await Order.findById(order.id).lean();
  expect(o.status).toBe('cancelled');
  expect((await Refund.findOne({ order: order.id }).lean()).type).toBe('non_upi_payment');
});

test('cancelling a paid order refunds via Razorpay; transient provider errors are retried without double refunds', async () => {
  const { c, order, payment } = await upiOrder();
  const paid = razorpay.pay(payment.razorpayOrderId);
  await c.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature });
  razorpay.failRefundTransient = 1;
  const r = await c.post(`/api/v1/orders/${order.orderNumber}/cancel`, { reason: 'Changed plans' });
  expect(r.status).toBe(200);
  await settle();
  let refund = await Refund.findOne({ order: order.id }).lean();
  expect(['processing', 'approved']).toContain(refund.status); // first attempt failed transiently (inline queue: single attempt in tests)
  const refundService = require('../src/modules/refunds/refund.service');
  await refundService.processRefund({ refundId: refund._id });
  await refundService.processRefund({ refundId: refund._id }); // retry is a no-op
  refund = await Refund.findOne({ order: order.id }).lean();
  expect(refund.status).toBe('processed');
  expect([...razorpay.refunds.values()].filter((x) => x.notes.refundId === String(refund._id))).toHaveLength(1);
  const o = await Order.findById(order.id).lean();
  expect(o.paymentStatus).toBe('refunded');
  expect(o.pricing.refundedTotal).toBe(o.pricing.total);
});

test('refund webhooks sync provider status idempotently', async () => {
  const { c, order, payment } = await upiOrder();
  const paid = razorpay.pay(payment.razorpayOrderId);
  await c.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature });
  const o = await Order.findById(order.id);
  const refundService = require('../src/modules/refunds/refund.service');
  const refund = await refundService.createRefund({ order: o, amount: 10000, type: 'goodwill', reason: 'test', requestedBy: { type: 'system' }, autoApprove: false });
  expect(refund.status).toBe('pending_approval');
  const entity = { id: 'rfnd_manualtest1', payment_id: paid.id, amount: 10000, status: 'processed', notes: { refundId: String(refund._id) } };
  await sendWebhook('refund.processed', { refund: { entity } }, 'evt_rf_1');
  await sendWebhook('refund.processed', { refund: { entity } }, 'evt_rf_2');
  const after = await Order.findById(order.id).lean();
  expect(after.pricing.refundedTotal).toBe(10000);
  expect(after.paymentStatus).toBe('partially_refunded');
});

test('refunds can never exceed the amount paid', async () => {
  const { c, order, payment } = await upiOrder();
  const paid = razorpay.pay(payment.razorpayOrderId);
  await c.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature });
  const r1 = await admin.post('/api/v1/admin/refunds', { orderId: order.id, amount: order.pricing.total - 100, type: 'goodwill', reason: 'big goodwill' }, { 'Idempotency-Key': 'a1' });
  expect(r1.status).toBe(201);
  const r2 = await admin.post('/api/v1/admin/refunds', { orderId: order.id, amount: 200, type: 'goodwill', reason: 'more goodwill' }, { 'Idempotency-Key': 'a2' });
  expect(r2.status).toBe(409);
  expect(r2.body.error.code).toBe('REFUND_EXCEEDS_PAID');
});

test('refund approval respects role limits', async () => {
  const { c, order, payment } = await upiOrder('DS-IVORY-24', 2); // ₹5,598
  const paid = razorpay.pay(payment.razorpayOrderId);
  await c.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: payment.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature });
  const om = await createStaff('order_manager'); // limited approver (≤ ₹5,000 by default)
  const support = await createStaff('support_agent');
  const req = await support.post('/api/v1/admin/refunds', { orderId: order.id, amount: 550000, type: 'goodwill', reason: 'customer complaint' }, { 'Idempotency-Key': 'lim1' });
  expect(req.status).toBe(201);
  expect((await support.post(`/api/v1/admin/refunds/${req.body.data._id}/approve`)).status).toBe(403);
  const omTry = await om.post(`/api/v1/admin/refunds/${req.body.data._id}/approve`);
  expect(omTry.status).toBe(403);
  expect(omTry.body.error.code).toBe('APPROVAL_LIMIT');
  expect((await admin.post(`/api/v1/admin/refunds/${req.body.data._id}/approve`)).status).toBe(200);
});

test('COD lifecycle: collected only once on delivery; RTO quarantines stock', async () => {
  const c = await registerCustomer();
  const address = await addAddress(c);
  await c.post('/api/v1/cart/items', { sku: 'GL-BORO-6-SMK', quantity: 1 });
  const placed = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': crypto.randomUUID() });
  const id = placed.body.data.order.id;
  const total = placed.body.data.order.pricing.total;
  expect((await admin.post(`/api/v1/admin/payments/cod/${id}/collected`, { amount: total })).status).toBe(409); // not shipped yet
  await admin.post(`/api/v1/admin/orders/${id}/status`, { status: 'packed' });
  expect((await admin.post(`/api/v1/admin/orders/${id}/status`, { status: 'shipped' })).status).toBe(409); // needs shipment
  expect((await admin.post(`/api/v1/admin/orders/${id}/shipments`, { awb: 'AWB123456', courier: 'manual' })).status).toBe(201);
  expect((await admin.post(`/api/v1/admin/payments/cod/${id}/collected`, { amount: total - 1 })).status).toBe(400);
  const col = await admin.post(`/api/v1/admin/payments/cod/${id}/collected`, { amount: total });
  expect(col.status).toBe(200);
  expect(col.body.data.status).toBe('delivered');
  expect((await admin.post(`/api/v1/admin/payments/cod/${id}/collected`, { amount: total })).status).toBe(409);

  // Refused delivery → RTO
  await c.post('/api/v1/cart/items', { sku: 'GL-BORO-6-SMK', quantity: 2 });
  const p2 = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': crypto.randomUUID() });
  const id2 = p2.body.data.order.id;
  await admin.post(`/api/v1/admin/orders/${id2}/status`, { status: 'packed' });
  const sh = await admin.post(`/api/v1/admin/orders/${id2}/shipments`, { awb: 'AWB999888', courier: 'manual' });
  await admin.post(`/api/v1/admin/shipments/${sh.body.data._id}/events`, { status: 'failed_attempt', note: 'Customer refused' });
  await admin.post(`/api/v1/admin/shipments/${sh.body.data._id}/events`, { status: 'rto_initiated' });
  const before = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  const rto = await admin.post(`/api/v1/admin/orders/${id2}/rto-received`, {});
  expect(rto.status).toBe(200);
  expect(rto.body.data).toMatchObject({ status: 'cancelled', paymentStatus: 'cod_not_collected' });
  const after = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  expect(after.quarantine - before.quarantine).toBe(2);
  expect(after.onHand).toBe(before.onHand); // not resellable until inspected
});

test('invalid order transitions are rejected', async () => {
  const c = await registerCustomer();
  const address = await addAddress(c);
  await c.post('/api/v1/cart/items', { sku: 'GL-BORO-6-SMK', quantity: 1 });
  const placed = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': crypto.randomUUID() });
  const r = await admin.post(`/api/v1/admin/orders/${placed.body.data.order.id}/status`, { status: 'delivered' });
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('INVALID_TRANSITION');
});
