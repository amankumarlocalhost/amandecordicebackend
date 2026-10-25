'use strict';

const mongoose = require('mongoose');
const { startApp, stopApp, settle, createStaff, Client } = require('./helpers/app');
const { seedCatalog } = require('./helpers/catalog');
const inventory = require('../src/modules/inventory/inventory.service');
const { Inventory, StockReservation } = require('../src/modules/inventory/inventory.models');
const { withTransaction } = require('../src/config/database');

let admin;
let seed;

beforeAll(async () => {
  await startApp();
  admin = await createStaff('super_admin');
  seed = await seedCatalog(admin, { dinnerStock: 1, glassStock: 5 });
  await settle();
});
afterAll(stopApp);

const ref = () => ({ type: 'order', id: new mongoose.Types.ObjectId() });

test('concurrent purchases of the last unit: exactly one succeeds', async () => {
  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, () => withTransaction((session) => inventory.reserve([{ sku: 'DS-IVORY-24', quantity: 1 }], ref(), { session, expiresAt: new Date(Date.now() + 60000) }))),
  );
  const ok = attempts.filter((a) => a.status === 'fulfilled');
  const outOfStock = attempts.filter((a) => a.status === 'rejected' && a.reason.code === 'OUT_OF_STOCK');
  expect(ok).toHaveLength(1);
  expect(outOfStock).toHaveLength(11);
  const inv = await Inventory.findOne({ sku: 'DS-IVORY-24' }).lean();
  expect(inv.reserved).toBe(1);
  expect(inv.onHand).toBe(1);
});

test('multi-SKU reservation is all-or-nothing', async () => {
  await expect(
    withTransaction((session) =>
      inventory.reserve(
        [
          { sku: 'GL-BORO-6-CLR', quantity: 2 },
          { sku: 'DS-IVORY-24', quantity: 1 }, // already fully reserved
        ],
        ref(),
        { session },
      ),
    ),
  ).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
  const glass = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
  expect(glass.reserved).toBe(0);
});

test('release and commit are idempotent', async () => {
  const r = ref();
  await withTransaction((session) => inventory.reserve([{ sku: 'GL-BORO-6-CLR', quantity: 2 }], r, { session }));
  expect(await inventory.releaseReservation(r, 'test')).toBe(true);
  expect(await inventory.releaseReservation(r, 'test')).toBe(false);
  expect(await inventory.commitReservation(r)).toBe(false);
  const glass = await Inventory.findOne({ sku: 'GL-BORO-6-CLR' }).lean();
  expect(glass.reserved).toBe(0);
  expect((await StockReservation.findOne({ 'ref.id': r.id })).status).toBe('released');
});

test('bundles reserve their component stock', async () => {
  const before = await inventory.getAvailability(['GL-BORO-6-SMK']);
  const r = ref();
  await inventory.reserve([{ sku: 'X-BUNDLE', quantity: 2, bundleComponents: [{ sku: 'GL-BORO-6-SMK', quantity: 2 }] }], r);
  const after = await inventory.getAvailability(['GL-BORO-6-SMK']);
  expect(before['GL-BORO-6-SMK'] - after['GL-BORO-6-SMK']).toBe(4);
  await inventory.releaseReservation(r, 'test');
});

test('returned fragile goods are quarantined and need an explicit disposition', async () => {
  const r = ref();
  const before = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  await inventory.quarantine([{ sku: 'GL-BORO-6-SMK', quantity: 2 }], r, { reason: 'return' });
  const q = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  expect(q.onHand).toBe(before.onHand); // not sellable
  expect(q.quarantine).toBe(2);
  const res = await admin.post('/api/v1/admin/inventory/GL-BORO-6-SMK/disposition', { quantity: 1, decision: 'restock', reason: 'inspected OK' });
  expect(res.status).toBe(200);
  const res2 = await admin.post('/api/v1/admin/inventory/GL-BORO-6-SMK/disposition', { quantity: 1, decision: 'damaged', reason: 'chipped rim' });
  expect(res2.status).toBe(200);
  const final = await Inventory.findOne({ sku: 'GL-BORO-6-SMK' }).lean();
  expect(final).toMatchObject({ quarantine: 0, onHand: before.onHand + 1, damaged: 1 });
  const tooMany = await admin.post('/api/v1/admin/inventory/GL-BORO-6-SMK/disposition', { quantity: 1, decision: 'restock', reason: 'x' + 'yz' });
  expect(tooMany.status).toBe(409);
});

test('adjustments cannot drop stock below reserved units and are recorded as movements', async () => {
  const res = await admin.post('/api/v1/admin/inventory/DS-IVORY-24/adjust', { delta: -1, reason: 'cycle count' });
  expect(res.status).toBe(409);
  const hist = await admin.get('/api/v1/admin/inventory/DS-IVORY-24');
  expect(hist.body.data.movements.map((m) => m.type)).toEqual(expect.arrayContaining(['adjustment', 'reserve']));
});

test('product inStock flag follows inventory', async () => {
  await admin.post('/api/v1/admin/inventory/GL-BORO-6-CLR/adjust', { delta: -5, reason: 'sold offline' });
  await admin.post('/api/v1/admin/inventory/GL-BORO-6-SMK/adjust', { delta: -6, reason: 'sold offline' });
  await settle();
  const list = await new Client().get('/api/v1/products', { inStock: 'true' });
  expect(list.body.data.some((p) => p.slug === seed.glass.slug)).toBe(false);
});
