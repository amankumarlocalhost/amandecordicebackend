'use strict';

const { startApp, stopApp, settle, Client, createStaff } = require('./helpers/app');
const { seedCatalog } = require('./helpers/catalog');

let admin;
let seed;

beforeAll(async () => {
  await startApp();
  admin = await createStaff('super_admin');
  seed = await seedCatalog(admin);
  await settle();
});
afterAll(stopApp);

describe('catalog', () => {
  test('public product detail hides cost price, omits unverified safety claims and shows stock status', async () => {
    const res = await new Client().get(`/api/v1/products/${seed.dinner.slug}`);
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(JSON.stringify(p)).not.toMatch(/costPrice|150000/);
    expect(p.care).toEqual({ microwaveSafe: true, dishwasherSafe: true });
    expect(p.variants[0].stockStatus).toBe('in_stock');
    expect(p.variants[0].discountPercent).toBe(20);
    expect(p.specs.piecesPerSet).toBe(24);
  });

  test('filters by category tree, material, price and set size; sorts by price', async () => {
    const c = new Client();
    const byParent = await c.get('/api/v1/products', { category: 'crockery' });
    expect(byParent.body.data.map((p) => p.slug)).toEqual(expect.arrayContaining([seed.dinner.slug, seed.bundle.slug]));
    expect(byParent.body.data.some((p) => p.slug === seed.glass.slug)).toBe(false);

    const glass = await c.get('/api/v1/products', { material: 'borosilicate_glass', maxPrice: 100000 });
    expect(glass.body.data.map((p) => p.slug)).toEqual([seed.glass.slug]);

    const sixPeople = await c.get('/api/v1/products', { serves: 6, maxPrice: 300000 });
    expect(sixPeople.body.data.map((p) => p.slug)).toEqual([seed.dinner.slug]);

    const sorted = await c.get('/api/v1/products', { sort: 'price_asc' });
    const prices = sorted.body.data.map((p) => p.priceMin);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);

    const bad = await c.get('/api/v1/products', { limit: 1000 });
    expect(bad.status).toBe(400);
  });

  test('text search and SKU prefix search', async () => {
    const c = new Client();
    const text = await c.get('/api/v1/search', { q: 'dinner set' });
    expect(text.body.data[0].slug).toBe(seed.dinner.slug);
    const sku = await c.get('/api/v1/products', { q: 'GL' });
    expect(sku.body.data.map((p) => p.slug)).toContain(seed.glass.slug);
  });

  test('variant validation: price above MRP and duplicate SKUs are rejected', async () => {
    const base = { name: 'Bad Plate', category: seed.categories.dinnerSets._id, images: [{ url: 'https://cdn.example.com/x.webp' }] };
    const overMrp = await admin.post('/api/v1/admin/products', { ...base, variants: [{ sku: 'BAD-1', mrp: 1000, price: 2000 }] });
    expect(overMrp.status).toBe(400);
    const dupInProduct = await admin.post('/api/v1/admin/products', { ...base, variants: [{ sku: 'BAD-2', mrp: 1000, price: 900 }, { sku: 'bad-2', mrp: 1000, price: 900 }] });
    expect(dupInProduct.status).toBe(400);
    const dupGlobal = await admin.post('/api/v1/admin/products', { ...base, variants: [{ sku: 'DS-IVORY-24', mrp: 1000, price: 900 }] });
    expect(dupGlobal.status).toBe(400);
  });

  test('catalog manager can edit products but cannot touch cost prices; admin edits keep historical-safe ids', async () => {
    const cm = await createStaff('catalog_manager');
    const view = await cm.get(`/api/v1/admin/products/${seed.dinner._id}`);
    expect(view.body.data.variants[0].costPrice).toBeUndefined();
    const denied = await cm.patch(`/api/v1/admin/products/${seed.dinner._id}`, { variants: [{ sku: 'DS-IVORY-24', mrp: 349900, price: 279900, costPrice: 1 }] });
    expect(denied.status).toBe(403);
    const okEdit = await cm.patch(`/api/v1/admin/products/${seed.dinner._id}`, { highlights: ['Serves six', 'Microwave safe'] });
    expect(okEdit.status).toBe(200);
    const full = await admin.get(`/api/v1/admin/products/${seed.dinner._id}`);
    expect(full.body.data.variants[0].costPrice).toBe(150000); // preserved
  });

  test('bundle availability is the minimum over its components', async () => {
    const res = await new Client().get(`/api/v1/products/${seed.bundle.slug}`);
    expect(res.body.data.variants[0].stockStatus).toBe('in_stock');
    expect(res.body.data.variants[0].maxOrderQuantity).toBe(10); // dinner stock 10 < glass stock 20
  });

  test('category tree and facets', async () => {
    const c = new Client();
    const tree = await c.get('/api/v1/categories');
    expect(tree.body.data.find((x) => x.slug === 'crockery').children[0].slug).toBe('dinner-sets');
    const facets = await c.get('/api/v1/products/facets');
    expect(facets.body.data.materials.map((m) => m.value)).toEqual(expect.arrayContaining(['ceramic', 'borosilicate_glass']));
  });

  test('archived products disappear from the storefront', async () => {
    const tmp = await admin.post('/api/v1/admin/products', { name: 'Temp Mug', category: seed.categories.dinnerSets._id, images: [{ url: 'https://cdn.example.com/m.webp' }], variants: [{ sku: 'MUG-TMP', mrp: 50000, price: 40000 }], status: 'active' });
    expect((await new Client().get(`/api/v1/products/${tmp.body.data.slug}`)).status).toBe(200);
    await admin.delete(`/api/v1/admin/products/${tmp.body.data._id}`);
    expect((await new Client().get(`/api/v1/products/${tmp.body.data.slug}`)).status).toBe(404);
  });
});
