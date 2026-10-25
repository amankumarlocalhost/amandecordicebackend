'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { startApp, stopApp, settle, registerCustomer, createStaff } = require('./helpers/app');
const { seedCatalog, addAddress } = require('./helpers/catalog');
const { Inventory } = require('../src/modules/inventory/inventory.models');
const Order = require('../src/modules/orders/order.model');
const Replacement = require('../src/modules/replacements/replacement.model');
const { Refund } = require('../src/modules/payments/payment.models');
const { Upload } = require('../src/modules/media/media');
const storage = require('../src/services/storage');

let admin;
let razorpay;

beforeAll(async () => {
  ({ razorpay } = await startApp());
  admin = await createStaff('super_admin');
  await seedCatalog(admin, { dinnerStock: 20, glassStock: 50 });
  await settle();
});
afterAll(async () => {
  for (const u of await Upload.find().lean()) for (const k of [u.key, u.key.replace('.webp', '_m.webp'), u.key.replace('.webp', '_t.webp')]) await storage.remove(k).catch(() => {});
  await stopApp();
});

async function deliveredOrder(items, { method = 'cod', customer } = {}) {
  const c = customer || (await registerCustomer());
  const address = await addAddress(c);
  for (const [sku, quantity] of items) await c.post('/api/v1/cart/items', { sku, quantity });
  const placed = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: method }, { 'Idempotency-Key': crypto.randomUUID() });
  if (placed.status !== 201) throw new Error(JSON.stringify(placed.body));
  const id = placed.body.data.order.id;
  if (method === 'upi') {
    const p = placed.body.data.payment;
    const paid = razorpay.pay(p.razorpayOrderId);
    await c.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: p.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature });
  }
  await admin.post(`/api/v1/admin/orders/${id}/status`, { status: 'packed' });
  const sh = await admin.post(`/api/v1/admin/orders/${id}/shipments`, { awb: `AWB${Date.now()}${Math.random().toString().slice(2, 6)}` });
  await admin.post(`/api/v1/admin/shipments/${sh.body.data._id}/events`, { status: 'delivered' });
  const order = await Order.findById(id).lean();
  return { c, order };
}

async function photo(c) {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c33' } }).png().toBuffer();
  const res = await c.agent.post('/api/v1/uploads').query({ purpose: 'return' }).set('x-csrf-token', c.csrf).attach('files', png, { filename: 'broken.png', contentType: 'image/png' });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data[0].id;
}

const item = (order, sku) => order.items.find((i) => i.sku === sku);

test('uploads reject files that are not real images', async () => {
  const c = await registerCustomer();
  await c.ensureCsrf();
  const res = await c.agent.post('/api/v1/uploads').query({ purpose: 'return' }).set('x-csrf-token', c.csrf).attach('files', Buffer.from('<?php echo 1; ?>'), { filename: 'evil.png', contentType: 'image/png' });
  expect(res.status).toBe(400);
});

test('broken glass → photo → auto-approved replacement with stock allocated', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-CLR', 2]]);
  const before = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
  const photoId = await photo(c);
  const res = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'replacement', reason: 'arrived_broken', description: 'Two glasses shattered in the box', photoIds: [photoId], items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] });
  expect(res.status).toBe(201);
  expect(res.body.data.status).toBe('resolved');
  expect(res.body.data.resolution.type).toBe('replacement');
  const rep = await Replacement.findById(res.body.data.replacement).lean();
  expect(rep.status).toBe('reserved');
  const after = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
  expect(before.onHand - after.onHand).toBe(1);
  expect((await Order.findById(order._id).lean()).status).toBe('replacement_processing');
  await settle();

  // Ship + deliver the replacement → claim closed, order completed. No new charge is created.
  const ship = await admin.post(`/api/v1/admin/replacements/${rep._id}/ship`, { awb: 'RPLAWB0001' });
  expect(ship.status).toBe(200);
  await admin.post(`/api/v1/admin/shipments/${ship.body.data.shipment._id}/events`, { status: 'delivered' });
  expect((await Replacement.findById(rep._id).lean()).status).toBe('delivered');
  expect((await Order.findById(order._id).lean()).status).toBe('completed');
  expect(await Refund.countDocuments({ order: order._id })).toBe(0);
});

test('duplicate claims for the same units are impossible, even concurrently', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-CLR', 1]]);
  const photoId = await photo(c);
  const body = { orderId: order.orderNumber, type: 'replacement', reason: 'arrived_chipped', photoIds: [photoId], items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] };
  const results = await Promise.all([c.post('/api/v1/returns', body), c.post('/api/v1/returns', body), c.post('/api/v1/returns', body)]);
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  expect(await Replacement.countDocuments({ order: order._id })).toBe(1);
});

test('the same Idempotency-Key returns the original request', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-SMK', 2]]);
  const photoId = await photo(c);
  const body = { orderId: order.orderNumber, type: 'replacement', reason: 'arrived_broken', photoIds: [photoId], items: [{ orderItemId: item(order, 'GL-BORO-6-SMK')._id, quantity: 1 }] };
  const a = await c.post('/api/v1/returns', body, { 'Idempotency-Key': 'claim-key-1234567' });
  const b = await c.post('/api/v1/returns', body, { 'Idempotency-Key': 'claim-key-1234567' });
  expect(a.status).toBe(201);
  expect(b.status).toBe(200);
  expect(b.body.data.requestNumber).toBe(a.body.data.requestNumber);
});

test('damage claims need photos', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-CLR', 1]]);
  const r = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'replacement', reason: 'arrived_broken', items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] });
  expect(r.status).toBe(400);
  expect(r.body.error.code).toBe('PHOTOS_REQUIRED');
});

test('expired windows: transit damage after 3 days and returns after 7 days are refused', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-CLR', 1]]);
  const photoId = await photo(c);
  await Order.updateOne({ _id: order._id }, { $set: { deliveredAt: new Date(Date.now() - 5 * 86400000) } });
  const late = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'replacement', reason: 'arrived_broken', photoIds: [photoId], items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] });
  expect(late.status).toBe(409);
  expect(late.body.error.code).toBe('REASON_NOT_ALLOWED');
  const elig = await c.get(`/api/v1/returns/eligibility/${order.orderNumber}`);
  expect(elig.body.data.items[0].allowedReasons).toEqual(expect.arrayContaining(['defective', 'incorrect_product']));
  expect(elig.body.data.items[0].allowedReasons).not.toContain('arrived_broken');

  await Order.updateOne({ _id: order._id }, { $set: { deliveredAt: new Date(Date.now() - 10 * 86400000) } });
  const expired = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'replacement', reason: 'defective', photoIds: [photoId], items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] });
  expect(expired.status).toBe(409);
  expect(expired.body.error.code).toBe('NOT_ELIGIBLE');
});

test('change-of-mind returns follow policy (disabled by default)', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-CLR', 1]]);
  const r = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'return', reason: 'changed_mind', items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] });
  expect(r.status).toBe(409);
});

test('missing piece from a gift set: replacement ships only the missing component', async () => {
  const { c, order } = await deliveredOrder([['GIFT-WEDDING-1', 1]]);
  const line = item(order, 'GIFT-WEDDING-1');
  expect(line.bundleComponents.map((b) => b.sku).sort()).toEqual(['DS-IVORY-24', 'GL-BORO-6-CLR']);
  const r = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'missing_item', reason: 'missing_item', items: [{ orderItemId: line._id, quantity: 1, missingComponents: [{ sku: 'GL-BORO-6-CLR', quantity: 1 }] }] });
  expect(r.status).toBe(201);
  // No photos for a missing item → reviewed manually by policy.
  expect(r.body.data.status).toBe('awaiting_review');
  const review = await admin.post(`/api/v1/admin/returns/${r.body.data.id}/review`, { decision: 'approve', resolution: 'replacement' });
  expect(review.status).toBe(200);
  const rep = await Replacement.findOne({ returnRequest: r.body.data.id }).lean();
  expect(rep.items).toEqual([expect.objectContaining({ sku: 'GL-BORO-6-CLR', quantity: 1 })]);
});

test('high-value claims are routed to manual review; staff limits apply to refunds', async () => {
  const { c, order } = await deliveredOrder([['DS-IVORY-24', 3]], { method: 'upi' });
  const photoId = await photo(c);
  const r = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'return', reason: 'arrived_broken', preferredResolution: 'refund', photoIds: [photoId], items: [{ orderItemId: item(order, 'DS-IVORY-24')._id, quantity: 3 }] });
  expect(r.status).toBe(201);
  expect(r.body.data.status).toBe('awaiting_review');
  await settle();
  // A support agent may approve the claim but cannot approve an ₹8,397 refund: it waits for finance.
  const support = await createStaff('support_agent');
  const rev = await support.post(`/api/v1/admin/returns/${r.body.data.id}/review`, { decision: 'approve', resolution: 'refund' });
  expect(rev.status).toBe(200);
  const refund = await Refund.findOne({ returnRequest: r.body.data.id }).lean();
  expect(refund).toMatchObject({ status: 'pending_approval', amount: 279900 * 3 });
  expect((await admin.post(`/api/v1/admin/refunds/${refund._id}/approve`)).status).toBe(200);
  await settle();
  expect((await Refund.findById(refund._id).lean()).status).toBe('processed');
});

test('UPI damage claim within limits: auto-approved refund processed through Razorpay', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-CLR', 1]], { method: 'upi' });
  const photoId = await photo(c);
  const r = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'return', reason: 'arrived_broken', preferredResolution: 'refund', photoIds: [photoId], items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] });
  expect(r.body.data.status).toBe('resolved');
  await settle();
  const refund = await Refund.findOne({ returnRequest: r.body.data.id }).lean();
  expect(refund).toMatchObject({ status: 'processed', amount: 89900, type: 'damage' });
});

test('wrong colour return: pickup → received (quarantine) → inspection → restock → refund', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-SMK', 1]], { method: 'upi' });
  const photoId = await photo(c);
  const r = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'return', reason: 'wrong_color_or_pattern', preferredResolution: 'refund', photoIds: [photoId], items: [{ orderItemId: item(order, 'GL-BORO-6-SMK')._id, quantity: 1 }] });
  expect(r.body.data.status).toBe('approved'); // pickup required for non-damage returns
  const id = r.body.data.id;
  expect((await admin.post(`/api/v1/admin/returns/${id}/pickup`, { scheduledAt: new Date().toISOString(), instructions: 'Pack in original box' })).status).toBe(200);
  const before = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  expect((await admin.post(`/api/v1/admin/returns/${id}/received`)).status).toBe(200);
  const mid = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  expect(mid.quarantine - before.quarantine).toBe(1);
  expect(mid.onHand).toBe(before.onHand);
  const insp = await admin.post(`/api/v1/admin/returns/${id}/inspection`, { result: 'confirmed', notes: 'Unused, resellable', dispositions: [{ sku: 'GL-BORO-6-SMK', quantity: 1, decision: 'restock' }] });
  expect(insp.status).toBe(200);
  expect(insp.body.data.status).toBe('resolved');
  const after = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  expect(after.onHand - before.onHand).toBe(1);
  expect(after.quarantine).toBe(before.quarantine);
});

test('requests are only possible after delivery and only on your own orders', async () => {
  const c = await registerCustomer();
  const address = await addAddress(c);
  await c.post('/api/v1/cart/items', { sku: 'GL-BORO-6-CLR', quantity: 1 });
  const placed = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': crypto.randomUUID() });
  const o = placed.body.data.order;
  const notDelivered = await c.post('/api/v1/returns', { orderId: o.orderNumber, type: 'replacement', reason: 'defective', items: [{ orderItemId: o.items[0].id, quantity: 1 }] });
  expect(notDelivered.status).toBe(409);
  expect(notDelivered.body.error.code).toBe('NOT_DELIVERED');

  const { order } = await deliveredOrder([['GL-BORO-6-CLR', 1]]);
  const stranger = await registerCustomer();
  const r = await stranger.post('/api/v1/returns', { orderId: order.orderNumber, type: 'replacement', reason: 'defective', items: [{ orderItemId: order.items[0]._id, quantity: 1 }] });
  expect(r.status).toBe(404);
});

test('rejected claim releases the units so a corrected claim can be filed', async () => {
  const { c, order } = await deliveredOrder([['GL-BORO-6-CLR', 1]]);
  const r = await c.post('/api/v1/returns', { orderId: order.orderNumber, type: 'replacement', reason: 'not_as_described', items: [{ orderItemId: item(order, 'GL-BORO-6-CLR')._id, quantity: 1 }] });
  expect(r.body.data.status).toBe('awaiting_review');
  expect((await admin.post(`/api/v1/admin/returns/${r.body.data.id}/review`, { decision: 'reject', note: 'Matches the listing photos' })).status).toBe(200);
  const elig = await c.get(`/api/v1/returns/eligibility/${order.orderNumber}`);
  expect(elig.body.data.items[0].claimableQty).toBe(1);
  expect((await Order.findById(order._id).lean()).status).toBe('delivered');
});
