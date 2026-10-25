'use strict';

const { startApp, stopApp, settle, Client, createStaff } = require('./helpers/app');

let owner;
let reviewer;
let category;
let other;

const photo = (id) => ({
  id,
  width: 4000,
  height: 3000,
  description: 'white ceramic teapot on a wooden table',
  rawUrl: `https://images.unsplash.com/photo-${id}?ixid=abc123&ixlib=rb-4.1.0`,
  pageUrl: `https://unsplash.com/photos/${id}`,
  downloadLocation: `https://api.unsplash.com/photos/${id}/download?ixid=abc123`,
  author: 'Asha Rao',
  authorUrl: 'https://unsplash.com/@asharao',
  tags: [],
});
const verified = { ok: true, contentType: 'image/jpeg', bytes: 12345 };

beforeAll(async () => {
  await startApp();
  owner = await createStaff('super_admin');
  reviewer = await createStaff('super_admin');
  category = (await owner.post('/api/v1/admin/categories', { name: 'Teapots', slug: 'teapots-import' })).body.data;
  other = (await owner.post('/api/v1/admin/categories', { name: 'Coffee Pots', slug: 'coffee-pots-import' })).body.data;
  await settle();
});
afterAll(stopApp);

async function draftWithImportedPhoto(id, sku) {
  const media = require('../src/modules/media/media.service');
  const { upload } = await media.registerUnsplashImage({ photo: photo(id), verification: verified, ownerId: owner.user.id || owner.user._id, query: 'ceramic teapot' });
  const res = await owner.post('/api/v1/admin/products', {
    name: `Imported Teapot ${sku}`,
    category: category._id,
    variants: [{ sku, mrp: 199900, price: 159900 }],
    images: [{ media: String(upload._id), alt: 'Teapot' }],
    status: 'draft',
  });
  expect(res.status).toBe(201);
  return { upload, product: res.body.data };
}

describe('Unsplash catalog import goes through media review', () => {
  test('an imported photo is pending, private and blocks publishing until another reviewer approves it', async () => {
    const { upload, product } = await draftWithImportedPhoto('1111-aaaa', 'IMP-TEA-1');
    expect(upload.review.status).toBe('pending_review');
    expect(upload.url).toBeUndefined();
    expect(product.images[0].pending).toBe(true);
    expect(product.images[0].url).toBeUndefined();

    const publish = await owner.post(`/api/v1/admin/products/${product._id}/status`, { status: 'active' });
    expect(publish.status).toBe(422);

    // Reviewers see the hotlinked preview and the attribution.
    const detail = await reviewer.get(`/api/v1/admin/media/${upload._id}`);
    expect(detail.body.data.source).toMatchObject({ provider: 'unsplash', author: 'Asha Rao' });
    expect(detail.body.data.preview.thumb).toMatch(/^https:\/\/images\.unsplash\.com\/photo-1111-aaaa\?ixid=abc123/);

    const approved = await reviewer.post(`/api/v1/admin/media/${upload._id}/approve`, {});
    expect(approved.status).toBe(200);
    await settle();

    const after = (await owner.get(`/api/v1/admin/products/${product._id}`)).body.data;
    expect(after.images[0].pending).toBe(false);
    expect(after.images[0].url).toContain('ixid=abc123');
    expect(after.images[0].thumbUrl).toContain('w=400');
    expect(after.status).toBe('draft'); // approval never publishes by itself

    expect((await owner.post(`/api/v1/admin/products/${product._id}/status`, { status: 'active' })).status).toBe(200);
    await settle();
    const pub = await new Client().get(`/api/v1/products/${product.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.images[0].credit).toMatchObject({ provider: 'unsplash', author: 'Asha Rao' });
    expect(pub.body.data.images[0].credit.authorUrl).toContain('utm_medium=referral');
  });

  test('registering the same photo twice reuses the upload; unverified photos are refused', async () => {
    const media = require('../src/modules/media/media.service');
    const ownerId = owner.user.id || owner.user._id;
    const a = await media.registerUnsplashImage({ photo: photo('2222-bbbb'), verification: verified, ownerId });
    const b = await media.registerUnsplashImage({ photo: photo('2222-bbbb'), verification: verified, ownerId });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(String(b.upload._id)).toBe(String(a.upload._id));
    await expect(media.registerUnsplashImage({ photo: photo('3333-cccc'), verification: { ok: false, reason: 'HTTP 404' }, ownerId })).rejects.toThrow(/not verified/);
  });
});

describe('bulk catalog operations', () => {
  test('assign_category moves products and rebuilds their category path; adjust_stock records movements', async () => {
    const { product } = await draftWithImportedPhoto('4444-dddd', 'IMP-TEA-2');
    const missing = await owner.post('/api/v1/admin/products/bulk', { ids: [product._id], action: 'assign_category', confirm: true });
    expect(missing.status).toBe(400);

    const moved = await owner.post('/api/v1/admin/products/bulk', { ids: [product._id], action: 'assign_category', categoryId: other._id, confirm: true });
    expect(moved.status).toBe(200);
    expect(moved.body.data[0].ok).toBe(true);
    const p = (await owner.get(`/api/v1/admin/products/${product._id}`)).body.data;
    expect(String(p.category._id || p.category)).toBe(String(other._id));
    expect(p.categoryPath.map(String)).toEqual([String(other._id)]);

    const stock = await owner.post('/api/v1/admin/products/bulk', { ids: [product._id], action: 'adjust_stock', delta: 15, reason: 'new shipment', confirm: true });
    expect(stock.status).toBe(200);
    expect(stock.body.data[0].ok).toBe(true);
    const inv = await owner.get('/api/v1/admin/inventory/IMP-TEA-2');
    expect(inv.body.data.onHand ?? inv.body.data.inventory?.onHand).toBe(15);
  });

  test('admin category list reports direct and total product counts', async () => {
    const list = (await owner.get('/api/v1/admin/categories')).body.data;
    const coffee = list.find((c) => c.slug === 'coffee-pots-import');
    expect(coffee.directProductCount).toBe(1);
    expect(coffee.productCount).toBe(1);
  });
});

describe('catalog seed data', () => {
  const { plan, buildProduct } = require('../scripts/seed-catalog');
  const { createProduct } = require('../src/modules/products/product.schemas');

  test('every category has exactly two distinct products with unique SKUs, and no safety claims', () => {
    const { cats, items, problems } = plan();
    expect(problems).toEqual([]);
    expect(cats.filter((c) => c.level === 0)).toHaveLength(12);
    expect(items).toHaveLength(cats.length * 2);
    for (const { cat, p } of items) {
      const data = buildProduct(cat, p, '0'.repeat(24), { featured: false });
      expect(() => createProduct.parse(data)).not.toThrow();
      expect(Object.values(data.care).every((v) => v === null)).toBe(true);
      expect(data.status).toBe('draft');
      expect(data.variants[0].price).toBeLessThanOrEqual(data.variants[0].mrp);
      expect(`${data.name} ${data.description}`).not.toMatch(/microwave[- ]safe|dishwasher[- ]safe|oven[- ]safe|food[- ]safe|bpa|lead[- ]free|certified/i);
    }
  });
});

describe('permanent product delete', () => {
  const published = async (sku, client = owner) => {
    const res = await client.post('/api/v1/admin/products', {
      name: `Wrong Product ${sku}`,
      category: category._id,
      variants: [{ sku, mrp: 99900, price: 89900 }],
      images: [{ url: `https://cdn.example.com/${sku}.webp`, alt: sku }],
      status: 'active',
    });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  test('a super admin can delete a published product; it disappears from the store and its stock and wishlist entries go too', async () => {
    const p = await published('DEL-PUB-1');
    await settle();
    expect((await new Client().get(`/api/v1/products/${p.slug}`)).status).toBe(200);
    const mongoose = require('mongoose');
    await mongoose.model('WishlistItem').create({ user: owner.user.id || owner.user._id, product: p._id, sku: 'DEL-PUB-1' });

    const del = await owner.delete(`/api/v1/admin/products/${p._id}/permanent`);
    expect(del.status).toBe(200);
    expect(del.body.data.wasPublished).toBe(true);
    await settle();
    expect((await new Client().get(`/api/v1/products/${p.slug}`)).status).toBe(404);
    expect((await owner.get(`/api/v1/admin/products/${p._id}`)).status).toBe(404);
    expect(await mongoose.model('Inventory').exists({ sku: 'DEL-PUB-1' })).toBeNull();
    expect(await mongoose.model('WishlistItem').exists({ product: p._id })).toBeNull();
  });

  test('other staff roles cannot delete, and products in orders are refused', async () => {
    const manager = await createStaff('catalog_manager');
    const p = await published('DEL-PUB-2');
    const denied = await manager.delete(`/api/v1/admin/products/${p._id}/permanent`);
    expect(denied.status).toBe(403);
    const bulkDenied = await manager.post('/api/v1/admin/products/bulk', { ids: [p._id], action: 'delete', confirm: true });
    expect(bulkDenied.status).toBe(403);

    const mongoose = require('mongoose');
    await mongoose.model('Order').collection.insertOne({ items: [{ product: new mongoose.Types.ObjectId(p._id), sku: 'DEL-PUB-2', quantity: 1 }] });
    const refused = await owner.delete(`/api/v1/admin/products/${p._id}/permanent`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PRODUCT_HAS_ORDERS');
    expect((await owner.get(`/api/v1/admin/products/${p._id}`)).status).toBe(200);
  });
});
