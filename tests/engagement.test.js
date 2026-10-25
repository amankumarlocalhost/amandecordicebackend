'use strict';

const crypto = require('crypto');
const { startApp, stopApp, settle, registerCustomer, createStaff, Client } = require('./helpers/app');
const { seedCatalog, addAddress } = require('./helpers/catalog');
const { Notification } = require('../src/modules/notifications/notification.models');

let admin;
let seed;
let razorpay;

beforeAll(async () => {
  ({ razorpay } = await startApp());
  admin = await createStaff('super_admin');
  seed = await seedCatalog(admin, { dinnerStock: 20, glassStock: 40 });
  await settle();
});
afterAll(stopApp);

async function placeCod(c, sku = 'GL-BORO-6-CLR', qty = 1) {
  const address = await addAddress(c);
  await c.post('/api/v1/cart/items', { sku, quantity: qty });
  const r = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': crypto.randomUUID() });
  return r.body.data.order;
}

async function deliver(orderId) {
  await admin.post(`/api/v1/admin/orders/${orderId}/status`, { status: 'packed' });
  const sh = await admin.post(`/api/v1/admin/orders/${orderId}/shipments`, { awb: `AWB${crypto.randomBytes(4).toString('hex')}` });
  return sh.body.data;
}

describe('reviews', () => {
  test('only delivered purchasers can review, once; moderation drives the public rating; HTML is stripped', async () => {
    const c = await registerCustomer({ name: 'Meera Iyer' });
    const order = await placeCod(c);
    const early = await c.post(`/api/v1/products/${seed.glass._id}/reviews`, { rating: 5, body: 'Lovely glasses, very sturdy.' });
    expect(early.status).toBe(403);
    const sh = await deliver(order.id);
    await admin.post(`/api/v1/admin/shipments/${sh._id}/events`, { status: 'delivered' });

    const r = await c.post(`/api/v1/products/${seed.glass._id}/reviews`, { rating: 4, title: '<b>Good</b>', body: 'Sturdy glasses <script>alert(1)</script> nice weight.' });
    expect(r.status).toBe(201);
    expect(r.body.data.author).toBe('Meera I.');
    expect(r.body.data.body).not.toMatch(/<script>/);
    expect((await c.post(`/api/v1/products/${seed.glass._id}/reviews`, { rating: 1, body: 'second review attempt' })).status).toBe(409);

    expect((await new Client().get(`/api/v1/products/${seed.glass._id}/reviews`)).body.data).toHaveLength(0); // pending
    expect((await admin.post(`/api/v1/admin/reviews/${r.body.data.id}/moderate`, { status: 'approved' })).status).toBe(200);
    const pub = await new Client().get(`/api/v1/products/${seed.glass._id}/reviews`);
    expect(pub.body.data).toHaveLength(1);
    expect(pub.body.meta.summary).toMatchObject({ average: 4, count: 1 });
    expect(JSON.stringify(pub.body)).not.toMatch(/email|phone|@example/);
  });
});

describe('notifications', () => {
  test('order lifecycle creates in-app notifications, deduplicated, readable only by the owner', async () => {
    const c = await registerCustomer();
    const order = await placeCod(c);
    await deliver(order.id);
    await settle();
    const list = await c.get('/api/v1/notifications');
    const types = list.body.data.map((n) => n.type);
    expect(types).toEqual(expect.arrayContaining(['order_confirmed', 'order_packed', 'order_shipped', 'welcome']));
    expect(types.filter((t) => t === 'order_confirmed')).toHaveLength(1);
    expect(list.body.meta.unread).toBeGreaterThan(0);
    expect((await c.post('/api/v1/notifications/read', { all: true })).body.data.updated).toBeGreaterThan(0);
    const other = await registerCustomer();
    await settle();
    const theirs = await other.get('/api/v1/notifications');
    expect(theirs.body.data.every((n) => n.data?.orderNumber !== order.orderNumber)).toBe(true);
    // External channels were not attempted: no SMTP configured and email unverified.
    const n = await Notification.findOne({ type: 'order_confirmed', 'data.orderNumber': order.orderNumber }).lean();
    expect(n.channels?.email).toBeUndefined();
  });

  test('back-in-stock subscription notifies when stock returns', async () => {
    const c = await registerCustomer();
    await admin.post('/api/v1/admin/inventory/GL-BORO-6-SMK/adjust', { delta: -40, reason: 'sold out' });
    expect((await c.post(`/api/v1/products/${seed.glass._id}/back-in-stock`, { sku: 'GL-BORO-6-SMK' })).status).toBe(200);
    await admin.post('/api/v1/admin/inventory/GL-BORO-6-SMK/adjust', { delta: 5, reason: 'restock' });
    await new Promise((r) => setTimeout(r, 2200)); // debounced refresh bucket
    await settle();
    const list = await c.get('/api/v1/notifications');
    expect(list.body.data.map((x) => x.type)).toContain('back_in_stock');
  });
});

describe('analytics metric definitions', () => {
  test('unpaid COD is GOV but never collected revenue; UPI capture is', async () => {
    const before = (await admin.get('/api/v1/admin/analytics/sales')).body.data.totals;
    const c = await registerCustomer();
    const cod = await placeCod(c, 'DS-IVORY-24', 1);
    const mid = (await admin.get('/api/v1/admin/analytics/sales')).body.data.totals;
    expect(mid.gov - before.gov).toBe(cod.pricing.total);
    expect(mid.collected.total).toBe(before.collected.total);

    const address = await addAddress(c);
    await c.post('/api/v1/cart/items', { sku: 'GL-BORO-6-CLR', quantity: 1 });
    const upi = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'upi' }, { 'Idempotency-Key': crypto.randomUUID() });
    const p = upi.body.data.payment;
    const paid = razorpay.pay(p.razorpayOrderId);
    await c.post('/api/v1/payments/razorpay/verify', { razorpay_order_id: p.razorpayOrderId, razorpay_payment_id: paid.id, razorpay_signature: paid.signature });
    const cache = require('../src/services/cache');
    await cache.bump(cache.NS.REPORTS); // reports are cached for 5 minutes
    const after = (await admin.get('/api/v1/admin/analytics/sales')).body.data.totals;
    expect(after.collected.upi - mid.collected.upi).toBe(upi.body.data.order.pricing.total);
    const cod2 = (await admin.get('/api/v1/admin/analytics/cod')).body.data;
    expect(cod2.outstandingTotal).toBeGreaterThanOrEqual(cod.pricing.total);
  });

  test('reports are permission-gated', async () => {
    const marketing = await createStaff('marketing_manager');
    expect((await marketing.get('/api/v1/admin/analytics/sales')).status).toBe(200);
    expect((await marketing.get('/api/v1/admin/analytics/inventory/valuation')).status).toBe(403);
    expect((await marketing.get('/api/v1/admin/audit-logs')).status).toBe(403);
    const logs = await admin.get('/api/v1/admin/audit-logs', { action: 'product.create' });
    expect(logs.body.data.length).toBeGreaterThan(0);
  });
});
