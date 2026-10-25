'use strict';

const crypto = require('crypto');
const { startApp, stopApp, settle, registerCustomer, createStaff } = require('./helpers/app');
const { seedCatalog, addAddress } = require('./helpers/catalog');
const { Inventory } = require('../src/modules/inventory/inventory.models');
const Order = require('../src/modules/orders/order.model');

let admin;
let seed;

beforeAll(async () => {
  await startApp();
  admin = await createStaff('super_admin');
  seed = await seedCatalog(admin, { dinnerStock: 10, glassStock: 20 });
  await settle();
});
afterAll(stopApp);

const key = () => crypto.randomUUID();
const day = 86400000;

async function customerWithCart(items, { verifyPhone = true } = {}) {
  const c = await registerCustomer({ verifyPhone });
  const address = await addAddress(c);
  for (const [sku, quantity] of items) {
    const r = await c.post('/api/v1/cart/items', { sku, quantity });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }
  return { c, address };
}

describe('guest cart', () => {
  test("a new guest's first add returns the cart containing the item", async () => {
    const { Client } = require('./helpers/app');
    const guest = new Client();
    const r = await guest.post('/api/v1/cart/items', { sku: 'DS-IVORY-24', quantity: 1 });
    expect(r.status).toBe(200);
    expect(r.body.data.items).toHaveLength(1);
    expect(r.body.data.quote.lines[0].sku).toBe('DS-IVORY-24');
    const again = await guest.get('/api/v1/cart');
    expect(again.body.data.items).toHaveLength(1);
  });
});

describe('cart validation', () => {
  test('rejects invalid quantities, unknown SKUs and quantities above stock', async () => {
    const c = await registerCustomer();
    expect((await c.post('/api/v1/cart/items', { sku: 'DS-IVORY-24', quantity: 0 })).status).toBe(400);
    expect((await c.post('/api/v1/cart/items', { sku: 'DS-IVORY-24', quantity: -2 })).status).toBe(400);
    expect((await c.post('/api/v1/cart/items', { sku: 'DS-IVORY-24', quantity: 1.5 })).status).toBe(400);
    expect((await c.post('/api/v1/cart/items', { sku: 'NOPE-123', quantity: 1 })).status).toBe(404);
    const tooMany = await c.post('/api/v1/cart/items', { sku: 'DS-IVORY-24', quantity: 11 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('OUT_OF_STOCK');
  });

  test('client-supplied prices are ignored', async () => {
    const c = await registerCustomer();
    await c.post('/api/v1/cart/items', { sku: 'GL-BORO-6-CLR', quantity: 1, price: 1 });
    const cart = await c.get('/api/v1/cart');
    expect(cart.body.data.quote.lines[0].unitPrice).toBe(89900);
  });
});

describe('pricing engine', () => {
  test('COD order totals: GST-inclusive tax, weight + fragile shipping, COD fee', async () => {
    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 1]]);
    const q = await c.post('/api/v1/checkout/quote', { addressId: address._id, paymentMethod: 'cod' });
    expect(q.status).toBe(200);
    const t = q.body.data.totals;
    expect(t.subtotal).toBe(89900);
    expect(t.shippingFee).toBe(4900 + 2500 + 3000); // base + 1 kg over included weight + fragile surcharge
    expect(t.codFee).toBe(4900);
    expect(t.total).toBe(89900 + 10400 + 4900);
    expect(t.taxTotal).toBe(Math.round((89900 * 1800) / 11800) + Math.round((15300 * 1800) / 11800));
    expect(q.body.data.paymentOptions.cod.available).toBe(true);
    expect(q.body.data.paymentOptions.upi.available).toBe(true);
  });

  test('free shipping above threshold; 12% GST on ceramic', async () => {
    const { c, address } = await customerWithCart([['DS-IVORY-24', 1]]);
    const q = await c.post('/api/v1/checkout/quote', { addressId: address._id, paymentMethod: 'upi' });
    expect(q.body.data.totals.shippingFee).toBe(0);
    expect(q.body.data.totals.taxTotal).toBe(Math.round((279900 * 1200) / 11200));
    expect(q.body.data.totals.total).toBe(279900);
  });

  test('coupon caps, minimum cart value and invalid codes', async () => {
    const now = Date.now();
    expect(
      (
        await admin.post('/api/v1/admin/coupons', { code: 'WELCOME10', discountType: 'percentage', value: 1000, maxDiscount: 20000, minCartValue: 50000, startsAt: new Date(now - day).toISOString(), endsAt: new Date(now + day).toISOString(), isActive: true })
      ).status,
    ).toBe(201);
    const { c, address } = await customerWithCart([['DS-IVORY-24', 1]]);
    expect((await c.post('/api/v1/cart/coupon', { code: 'NOTREAL' })).status).toBe(400);
    const applied = await c.post('/api/v1/cart/coupon', { code: 'welcome10' });
    expect(applied.status).toBe(200);
    const q = await c.post('/api/v1/checkout/quote', { addressId: address._id, paymentMethod: 'upi' });
    expect(q.body.data.totals.couponDiscount).toBe(20000); // 10% = 27990, capped at 20000
    expect(q.body.data.totals.total).toBe(259900);

    const small = await customerWithCart([['GL-BORO-6-CLR', 1]]);
    await admin.post('/api/v1/admin/coupons', { code: 'BIGSPEND', discountType: 'fixed', value: 50000, minCartValue: 500000, startsAt: new Date(now - day).toISOString(), endsAt: new Date(now + day).toISOString(), isActive: true });
    const minCart = await small.c.post('/api/v1/cart/coupon', { code: 'BIGSPEND' });
    expect(minCart.status).toBe(400);
    expect(minCart.body.error.details.reason).toBe('MIN_CART');
  });

  test('automatic festival promotion applies best offer per line and blocks non-stackable coupons', async () => {
    const now = Date.now();
    const camp = await admin.post('/api/v1/admin/campaigns', { name: 'Diwali Glassware Sale', festival: 'diwali', startsAt: new Date(now - day).toISOString(), endsAt: new Date(now + day).toISOString(), isActive: true });
    expect(camp.status).toBe(201);
    const promo = await admin.post('/api/v1/admin/promotions', {
      name: 'Diwali 15% off glassware',
      campaign: camp.body.data._id,
      discountType: 'percentage',
      value: 1500,
      scope: { appliesTo: 'categories', categories: [seed.categories.glassware._id] },
      startsAt: new Date(now - day).toISOString(),
      endsAt: new Date(now + day).toISOString(),
      isActive: true,
      stackableWithCoupons: false,
    });
    expect(promo.status).toBe(201);
    await admin.post('/api/v1/admin/coupons', { code: 'ALL5', discountType: 'percentage', value: 500, startsAt: new Date(now - day).toISOString(), endsAt: new Date(now + day).toISOString(), isActive: true, stackableWithPromotions: true });

    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 2], ['DS-IVORY-24', 1]]);
    await c.post('/api/v1/cart/coupon', { code: 'ALL5' });
    const q = (await c.post('/api/v1/checkout/quote', { addressId: address._id, paymentMethod: 'upi' })).body.data;
    const glassLine = q.lines.find((l) => l.sku === 'GL-BORO-6-CLR');
    const dinnerLine = q.lines.find((l) => l.sku === 'DS-IVORY-24');
    expect(glassLine.promotionDiscount).toBe(Math.round(179800 * 0.15));
    expect(glassLine.couponDiscount).toBe(0); // promotion is not stackable with coupons
    expect(dinnerLine.promotionDiscount).toBe(0);
    expect(dinnerLine.couponDiscount).toBe(Math.round(279900 * 0.05));
    expect(q.appliedPromotions[0].campaign).toBe('Diwali Glassware Sale');

    // Pausing the campaign switches the promotion off without touching the promotion itself.
    await admin.post(`/api/v1/admin/campaigns/${camp.body.data._id}/pause`);
    const q2 = (await c.post('/api/v1/checkout/quote', { addressId: address._id, paymentMethod: 'upi' })).body.data;
    expect(q2.totals.promotionDiscount).toBe(0);
  });
});

describe('placing orders', () => {
  test('only UPI and COD are accepted', async () => {
    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 1]]);
    for (const method of ['card', 'netbanking', 'wallet']) {
      const r = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: method }, { 'Idempotency-Key': key() });
      expect(r.status).toBe(400);
    }
  });

  test('an Idempotency-Key is required and duplicate submissions return the same order', async () => {
    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 2]]);
    expect((await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' })).status).toBe(400);
    const k = key();
    const before = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
    const [a, b] = await Promise.all([
      c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': k }),
      c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': k }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBeLessThan(300);
    const ids = [a, b].filter((r) => r.status < 300).map((r) => r.body.data.order.id);
    expect(new Set(ids).size).toBe(1);
    const after = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
    expect(before.onHand - after.onHand).toBe(2); // committed once
    expect(await Order.countDocuments({ checkoutKey: k })).toBe(1);
  });

  test('COD order is confirmed, stock committed, cart cleared, totals snapshotted', async () => {
    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 1]]);
    const quote = (await c.post('/api/v1/checkout/quote', { addressId: address._id, paymentMethod: 'cod' })).body.data;
    const r = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod', expectedTotal: quote.totals.total }, { 'Idempotency-Key': key() });
    expect(r.status).toBe(201);
    const order = r.body.data.order;
    expect(order.status).toBe('confirmed');
    expect(order.paymentStatus).toBe('cod_due');
    expect(order.pricing.total).toBe(quote.totals.total);
    expect((await c.get('/api/v1/cart')).body.data.items).toHaveLength(0);

    // Changing the product price later does not alter the order.
    await admin.patch(`/api/v1/admin/products/${seed.glass._id}`, { variants: [{ sku: 'GL-BORO-6-CLR', title: 'Clear', mrp: 119900, price: 79900 }, { sku: 'GL-BORO-6-SMK', title: 'Smoke', mrp: 129900, price: 99900 }] });
    const stored = await c.get(`/api/v1/orders/${order.orderNumber}`);
    expect(stored.body.data.items[0].unitPrice).toBe(89900);
    await admin.patch(`/api/v1/admin/products/${seed.glass._id}`, { variants: [{ sku: 'GL-BORO-6-CLR', title: 'Clear', mrp: 119900, price: 89900 }, { sku: 'GL-BORO-6-SMK', title: 'Smoke', mrp: 129900, price: 99900 }] });
  });

  test('stale prices are detected with expectedTotal', async () => {
    const { c, address } = await customerWithCart([['GL-BORO-6-SMK', 1]]);
    const quote = (await c.post('/api/v1/checkout/quote', { addressId: address._id, paymentMethod: 'cod' })).body.data;
    await admin.patch(`/api/v1/admin/products/${seed.glass._id}`, { variants: [{ sku: 'GL-BORO-6-CLR', title: 'Clear', mrp: 119900, price: 89900 }, { sku: 'GL-BORO-6-SMK', title: 'Smoke', mrp: 129900, price: 109900 }] });
    const r = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod', expectedTotal: quote.totals.total }, { 'Idempotency-Key': key() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PRICE_CHANGED');
    expect(r.body.error.details.quote.totals.subtotal).toBe(109900);
  });

  test('out-of-stock items block checkout', async () => {
    const { c, address } = await customerWithCart([['DS-IVORY-24', 2]]);
    // Another channel sells stock after the item was carted: leave exactly 1 unit available.
    const inv = await Inventory.findOne({ sku: 'DS-IVORY-24' }).lean();
    const sellable = inv.onHand - inv.reserved;
    expect((await admin.post('/api/v1/admin/inventory/DS-IVORY-24/damage', { quantity: sellable - 1, reason: 'pallet dropped' })).status).toBe(200);
    const r = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': key() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CHECKOUT_BLOCKED');
    expect(r.body.error.details.issues[0]).toMatchObject({ code: 'INSUFFICIENT_STOCK', available: 1 });
    await admin.post('/api/v1/admin/inventory/DS-IVORY-24/adjust', { delta: 20, reason: 'restock' });
  });

  test('COD requires a verified phone', async () => {
    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 1]], { verifyPhone: false });
    const r = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': key() });
    expect(r.status).toBe(409);
    expect(r.body.error.details.issues.map((i) => i.code)).toContain('PAYMENT_METHOD_UNAVAILABLE');
  });

  test('a coupon with one use left cannot be redeemed twice concurrently', async () => {
    const now = Date.now();
    await admin.post('/api/v1/admin/coupons', { code: 'ONLYONE', discountType: 'fixed', value: 10000, usageLimit: 1, startsAt: new Date(now - day).toISOString(), endsAt: new Date(now + day).toISOString(), isActive: true });
    const a = await customerWithCart([['GL-BORO-6-CLR', 1]]);
    const b = await customerWithCart([['GL-BORO-6-CLR', 1]]);
    await a.c.post('/api/v1/cart/coupon', { code: 'ONLYONE' });
    await b.c.post('/api/v1/cart/coupon', { code: 'ONLYONE' });
    const results = await Promise.all([
      a.c.post('/api/v1/checkout/place-order', { addressId: a.address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': key() }),
      b.c.post('/api/v1/checkout/place-order', { addressId: b.address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': key() }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(['COUPON_EXHAUSTED', 'CHECKOUT_BLOCKED']).toContain(loser.body.error.code);
  });

  test('customer cancellation restocks and releases the coupon use', async () => {
    const now = Date.now();
    await admin.post('/api/v1/admin/coupons', { code: 'CANCELME', discountType: 'fixed', value: 5000, usageLimit: 1, startsAt: new Date(now - day).toISOString(), endsAt: new Date(now + day).toISOString(), isActive: true });
    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 3]]);
    await c.post('/api/v1/cart/coupon', { code: 'CANCELME' });
    const before = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
    const placed = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': key() });
    expect(placed.status).toBe(201);
    const cancel = await c.post(`/api/v1/orders/${placed.body.data.order.orderNumber}/cancel`, { reason: 'Ordered by mistake' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.order.status).toBe('cancelled');
    const after = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
    expect(after.onHand).toBe(before.onHand);
    const { Coupon } = require('../src/modules/promotions/promotion.models');
    expect((await Coupon.findOne({ code: 'CANCELME' })).usedCount).toBe(0);
    expect((await c.post(`/api/v1/orders/${placed.body.data.order.orderNumber}/cancel`, { reason: 'again' })).status).toBe(409);
  });

  test('customers cannot read other customers orders', async () => {
    const { c, address } = await customerWithCart([['GL-BORO-6-CLR', 1]]);
    const placed = await c.post('/api/v1/checkout/place-order', { addressId: address._id, paymentMethod: 'cod' }, { 'Idempotency-Key': key() });
    const other = await registerCustomer();
    expect((await other.get(`/api/v1/orders/${placed.body.data.order.orderNumber}`)).status).toBe(404);
    expect((await other.post(`/api/v1/orders/${placed.body.data.order.id}/cancel`, { reason: 'malicious' })).status).toBe(404);
  });
});
