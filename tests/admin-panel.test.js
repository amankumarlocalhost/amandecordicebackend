'use strict';

// Admin panel integration: media review workflow, publishing rules, image replacement, CMS content,
// optimistic concurrency, storefront revalidation webhooks and the public real-time channel.
const REVAL_PORT = 41000 + (process.pid % 15000);
Object.assign(process.env, { FRONTEND_REVALIDATE_URL: `http://127.0.0.1:${REVAL_PORT}/api/revalidate`, REVALIDATE_SECRET: 'test-revalidate-secret-0123456789abcdef' });

const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { io: ioc } = require('socket.io-client');
const { startApp, stopApp, settle, Client, registerCustomer, createStaff } = require('./helpers/app');
const { initSockets } = require('../src/sockets');
const sync = require('../src/services/sync');
const storage = require('../src/services/storage');
const { Upload } = require('../src/modules/media/media.model');

let server;
let ioServer;
let url;
let revalServer;
const revalidations = [];
const events = [];
let unsub;
let superAdmin;
let catalogManager;
let reviewer;
let category;

const png = (w = 800, h = 600, color = '#7a8b6f') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

async function upload(c, buf, { name = 'plate.png', type = 'image/png', query = 'purpose=product' } = {}) {
  await c.ensureCsrf();
  return c.agent.post(`/api/v1/admin/media?${query}`).set('x-csrf-token', c.csrf).attach('files', buf, { filename: name, contentType: type });
}

async function flush() {
  await settle();
  await sync.settle();
  await settle();
  await sync.settle();
}

beforeAll(async () => {
  revalServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const ok = req.headers['x-revalidate-secret'] === process.env.REVALIDATE_SECRET;
      if (ok) revalidations.push({ at: Date.now(), ...JSON.parse(body) });
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => revalServer.listen(REVAL_PORT, '127.0.0.1', r));
  const { app } = await startApp();
  server = http.createServer(app);
  ioServer = await initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
  unsub = sync.subscribe((e) => events.push(e));
  superAdmin = await createStaff('super_admin');
  catalogManager = await createStaff('catalog_manager');
  reviewer = await createStaff('catalog_manager');
  category = (await superAdmin.post('/api/v1/admin/categories', { name: 'Plates', slug: 'plates' })).body.data;
});

afterAll(async () => {
  unsub?.();
  await new Promise((r) => ioServer.close(() => r()));
  await new Promise((r) => revalServer.close(() => r()));
  await stopApp();
});

const product = (sku, extra = {}) => ({ name: `Stoneware Plate ${sku}`, category: category._id, variants: [{ sku, mrp: 99900, price: 79900 }], ...extra });

describe('media review → publish workflow', () => {
  let productId;
  let slug;
  let mediaId;

  test('upload is private and pending; the public cannot see it anywhere', async () => {
    const p = await catalogManager.post('/api/v1/admin/products', product('PLT-A1'));
    expect(p.status).toBe(201);
    productId = p.body.data._id;
    slug = p.body.data.slug;

    const up = await upload(catalogManager, await png(), { query: `purpose=product&targetId=${productId}` });
    expect(up.status).toBe(201);
    const m = up.body.data[0];
    mediaId = m.id;
    expect(m).toMatchObject({ status: 'pending_review', isPrivate: true, url: null, thumbUrl: null, originalName: 'plate.png', target: { type: 'product', id: productId } });
    // Stored outside the public folder; the public /uploads route cannot serve it.
    const doc = await Upload.findById(mediaId).lean();
    expect(fs.existsSync(path.join(storage.LOCAL_PRIVATE_ROOT, doc.key))).toBe(true);
    expect(fs.existsSync(path.join(storage.LOCAL_ROOT, doc.key))).toBe(false);
    expect((await new Client().get(`/uploads/${doc.key}`)).status).toBe(404);

    // Signed preview works for admins' <img> tags; tampering or expiry fails.
    const preview = m.preview.thumb.replace(/^https?:\/\/[^/]+/, '');
    const ok = await new Client().get(preview);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/webp');
    expect((await new Client().get(preview.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(404);
    expect((await new Client().get(preview.replace(/exp=\d+/, 'exp=1000'))).status).toBe(404);
  });

  test('pending images can be attached but block publishing and never reach public APIs', async () => {
    const set = await catalogManager.patch(`/api/v1/admin/products/${productId}/images`, { images: [{ media: mediaId, alt: 'Plate' }] });
    expect(set.status).toBe(200);
    expect(set.body.data[0]).toMatchObject({ pending: true });
    expect(set.body.data[0].url).toBeUndefined();

    const pub = await catalogManager.post(`/api/v1/admin/products/${productId}/status`, { status: 'active' });
    expect(pub.status).toBe(422);
    expect(pub.body.error.code).toBe('PUBLISH_REQUIRES_APPROVED_IMAGE');
    expect((await new Client().get(`/api/v1/products/${slug}`)).status).toBe(404);
  });

  test('uploaders cannot approve their own media; customers cannot review at all', async () => {
    const self = await catalogManager.post(`/api/v1/admin/media/${mediaId}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_REVIEW');
    const cust = await registerCustomer();
    expect((await cust.post(`/api/v1/admin/media/${mediaId}/approve`, {})).status).toBe(403);
    expect((await cust.get('/api/v1/admin/media')).status).toBe(403);
    expect((await new Client().get('/api/v1/admin/media')).status).toBe(401);
  });

  test('approval moves the asset to public storage and fills the gallery entry', async () => {
    const res = await reviewer.post(`/api/v1/admin/media/${mediaId}/approve`, { note: 'Looks good' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', isPrivate: false });
    expect(res.body.data.url).toMatch(/\/uploads\/product\/.+\.webp$/);
    const again = await reviewer.post(`/api/v1/admin/media/${mediaId}/approve`, {});
    expect(again.status).toBe(409);
    const detail = await catalogManager.get(`/api/v1/admin/products/${productId}`);
    expect(detail.body.data.images[0]).toMatchObject({ pending: false, url: res.body.data.url });
    expect(detail.body.data.media[mediaId].status).toBe('approved');
    const media = await reviewer.get(`/api/v1/admin/media/${mediaId}`);
    expect(media.body.data.history.map((h) => h.action)).toEqual(['uploaded', 'approved']);
    expect(media.body.data.references).toEqual([expect.objectContaining({ type: 'product', id: productId })]);
  });

  test('publishing makes the product public, revalidates the storefront and announces it', async () => {
    revalidations.length = 0;
    events.length = 0;
    const pub = await catalogManager.post(`/api/v1/admin/products/${productId}/status`, { status: 'active' });
    expect(pub.status).toBe(200);
    await flush();
    const detail = await new Client().get(`/api/v1/products/${slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.images).toHaveLength(1);
    expect(detail.body.data.images[0]).not.toHaveProperty('media');
    expect(revalidations.flatMap((r) => r.tags)).toEqual(expect.arrayContaining(['catalog', `product:${slug}`]));
    expect(events).toEqual([expect.objectContaining({ event: 'product:published', id: productId, slug })]);
    // Revalidation is sent before the public event is broadcast.
    expect(revalidations[0].at).toBeLessThanOrEqual(Date.now());
  });

  test('edits and unpublishing are synchronised; drafts are never announced', async () => {
    events.length = 0;
    await catalogManager.patch(`/api/v1/admin/products/${productId}`, { name: 'Stoneware Dinner Plate' });
    await flush();
    expect(events.map((e) => e.event)).toEqual(['product:updated']);

    events.length = 0;
    await catalogManager.post(`/api/v1/admin/products/${productId}/status`, { status: 'inactive' });
    await flush();
    expect(events.map((e) => e.event)).toEqual(['product:unpublished']);
    expect((await new Client().get(`/api/v1/products/${slug}`)).status).toBe(404);
    const list = await new Client().get('/api/v1/products', { q: 'Stoneware Dinner' });
    expect(list.body.data.find((p) => p.id === productId)).toBeUndefined();

    events.length = 0;
    await catalogManager.post('/api/v1/admin/products', product('PLT-DRAFT'));
    await catalogManager.patch(`/api/v1/admin/products/${productId}`, { description: 'still unpublished' });
    await flush();
    expect(events).toEqual([]);
  });
});

describe('image replacement keeps the live image until the new one is approved and published', () => {
  let productId;
  let slug;
  let original;
  let imageId;

  beforeAll(async () => {
    const up = await upload(catalogManager, await png(900, 900, '#224433'));
    original = up.body.data[0];
    await reviewer.post(`/api/v1/admin/media/${original.id}/approve`, {});
    const p = await catalogManager.post('/api/v1/admin/products', product('PLT-R1', { images: [{ media: original.id }], status: 'active' }));
    expect(p.status).toBe(201);
    productId = p.body.data._id;
    slug = p.body.data.slug;
    imageId = p.body.data.images[0]._id;
  });

  test('full replacement and rollback', async () => {
    const liveUrl = (await new Client().get(`/api/v1/products/${slug}`)).body.data.images[0].url;
    const rep = await upload(catalogManager, await png(900, 900, '#aa3311'), { query: `purpose=product&targetId=${productId}&replaces=${original.id}` });
    expect(rep.status).toBe(201);
    const replacement = rep.body.data[0];
    expect(replacement.replaces).toBe(original.id);

    let admin = (await catalogManager.get(`/api/v1/admin/products/${productId}`)).body.data;
    expect(admin.images[0].replacement).toMatchObject({ media: replacement.id, ready: false });
    expect((await new Client().get(`/api/v1/products/${slug}`)).body.data.images[0].url).toBe(liveUrl);

    // Cannot publish before approval.
    const early = await catalogManager.post(`/api/v1/admin/products/${productId}/images/${imageId}/replacement/publish`, {});
    expect(early.status).toBe(422);

    await reviewer.post(`/api/v1/admin/media/${replacement.id}/approve`, {});
    admin = (await catalogManager.get(`/api/v1/admin/products/${productId}`)).body.data;
    expect(admin.images[0].replacement).toMatchObject({ ready: true });
    // Approved but not yet published: the storefront still shows the original.
    expect((await new Client().get(`/api/v1/products/${slug}`)).body.data.images[0].url).toBe(liveUrl);

    events.length = 0;
    const published = await catalogManager.post(`/api/v1/admin/products/${productId}/images/${imageId}/replacement/publish`, {});
    expect(published.status).toBe(200);
    await flush();
    const live = (await new Client().get(`/api/v1/products/${slug}`)).body.data.images[0].url;
    expect(live).not.toBe(liveUrl);
    expect(events.map((e) => e.event)).toContain('product:updated');
    expect((await Upload.findById(original.id).lean()).review.status).toBe('superseded');
    // The superseded asset is kept (rollback) and cannot be deleted while referenced.
    expect((await catalogManager.delete(`/api/v1/admin/media/${original.id}`)).status).toBe(409);

    const rolled = await catalogManager.post(`/api/v1/admin/products/${productId}/images/${imageId}/rollback`, {});
    expect(rolled.status).toBe(200);
    expect((await new Client().get(`/api/v1/products/${slug}`)).body.data.images[0].url).toBe(liveUrl);
    expect((await Upload.findById(original.id).lean()).review.status).toBe('approved');
  });
});

describe('upload validation and attachment rules', () => {
  test('non-images, tiny images and oversized files are rejected', async () => {
    const fake = await upload(catalogManager, Buffer.from('MZ\x90\x00 this is an exe'), { name: 'x.png' });
    expect(fake.status).toBe(400);
    const tiny = await upload(catalogManager, await png(50, 50));
    expect(tiny.status).toBe(400);
    expect(tiny.body.error.code).toBe('IMAGE_TOO_SMALL');
    const huge = await upload(catalogManager, Buffer.alloc(16 * 1024 * 1024, 1), { name: 'huge.png' });
    expect(huge.status).toBe(413);
  });

  test('partial batch failures report which files failed', async () => {
    await catalogManager.ensureCsrf();
    const res = await catalogManager.agent
      .post('/api/v1/admin/media?purpose=product')
      .set('x-csrf-token', catalogManager.csrf)
      .attach('files', await png(), { filename: 'good.png', contentType: 'image/png' })
      .attach('files', Buffer.from('not an image'), { filename: 'bad.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.failed).toEqual([expect.objectContaining({ name: 'bad.png' })]);
  });

  test('arbitrary URLs and rejected media cannot be attached; external hosts must be allow-listed', async () => {
    const bad = await catalogManager.post('/api/v1/admin/products', product('PLT-X1', { images: [{ url: 'https://evil.example.net/x.jpg' }] }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('MEDIA_NOT_APPROVED');

    const up = await upload(catalogManager, await png());
    const rej = await reviewer.post(`/api/v1/admin/media/${up.body.data[0].id}/reject`, { reason: 'Blurry photo', requestReplacement: true });
    expect(rej.status).toBe(200);
    expect(rej.body.data.review).toMatchObject({ reason: 'Blurry photo', replacementRequested: true });
    const attach = await catalogManager.post('/api/v1/admin/products', product('PLT-X2', { images: [{ media: up.body.data[0].id }] }));
    expect(attach.status).toBe(400);
    expect(attach.body.error.code).toBe('MEDIA_REJECTED');

    // Category images must be approved.
    const pend = await upload(catalogManager, await png(), { query: 'purpose=category' });
    const cat = await catalogManager.post('/api/v1/admin/categories', { name: 'Bowls', image: { media: pend.body.data[0].id } });
    expect(cat.status).toBe(400);
  });

  test('re-uploading a rejected image re-points draft references to the new pending upload', async () => {
    const first = (await upload(catalogManager, await png())).body.data[0];
    const p = (await catalogManager.post('/api/v1/admin/products', product('PLT-RU1', { images: [{ media: first.id }] }))).body.data;
    await reviewer.post(`/api/v1/admin/media/${first.id}/reject`, { reason: 'Wrong colour' });
    const second = (await upload(catalogManager, await png(), { query: `purpose=product&targetId=${p._id}&replaces=${first.id}` })).body.data[0];
    const detail = (await catalogManager.get(`/api/v1/admin/products/${p._id}`)).body.data;
    expect(String(detail.images[0].media)).toBe(second.id);
    expect(detail.images[0].pending).toBe(true);
  });

  test('bulk review requires confirmation and reports each item', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await upload(catalogManager, await png())).body.data[0].id);
    expect((await reviewer.post('/api/v1/admin/media/review', { ids, decision: 'approve' })).status).toBe(400);
    const res = await reviewer.post('/api/v1/admin/media/review', { ids: [...ids, ids[0]], decision: 'approve', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data.every((r) => r.ok)).toBe(true);
    const q = await reviewer.get('/api/v1/admin/media', { status: 'pending_review' });
    expect(q.body.data.find((m) => ids.includes(m.id))).toBeUndefined();
  });
});

describe('legacy images (created before the review workflow)', () => {
  test('unchanged legacy images can be kept while editing; new arbitrary URLs are still rejected', async () => {
    const Product = require('../src/modules/products/product.model');
    const p = (await catalogManager.post('/api/v1/admin/products', product('PLT-LEG1'))).body.data;
    // Simulate pre-existing data: a live image with a plain URL on a host that is not allow-listed.
    await Product.updateOne({ _id: p._id }, { $set: { images: [{ url: 'https://images.legacy-cdn.example/plate.jpg', alt: 'Legacy' }], status: 'active', publishedAt: new Date() } });
    const detail = (await catalogManager.get(`/api/v1/admin/products/${p._id}`)).body.data;
    const legacy = detail.images[0];
    const keep = await catalogManager.patch(`/api/v1/admin/products/${p._id}`, { description: 'Edited', images: [{ _id: legacy._id, url: legacy.url, alt: 'Legacy plate' }] });
    expect(keep.status).toBe(200);
    expect((await new Client().get(`/api/v1/products/${p.slug}`)).body.data.images[0]).toMatchObject({ url: legacy.url, alt: 'Legacy plate' });
    const swap = await catalogManager.patch(`/api/v1/admin/products/${p._id}`, { images: [{ _id: legacy._id, url: 'https://images.legacy-cdn.example/other.jpg' }] });
    expect(swap.status).toBe(400);
    expect(swap.body.error.code).toBe('MEDIA_NOT_APPROVED');
  });
});

describe('concurrency and bulk actions', () => {
  test('a stale editor gets 409 instead of overwriting a newer edit', async () => {
    const p = (await catalogManager.post('/api/v1/admin/products', product('PLT-C1'))).body.data;
    const loadedAt = p.updatedAt;
    const first = await superAdmin.patch(`/api/v1/admin/products/${p._id}`, { description: 'Edit from tab A', expectedUpdatedAt: loadedAt });
    expect(first.status).toBe(200);
    const second = await catalogManager.patch(`/api/v1/admin/products/${p._id}`, { description: 'Edit from tab B', expectedUpdatedAt: loadedAt });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('STALE_WRITE');
  });

  test('bulk publish validates each product separately', async () => {
    const up = (await upload(catalogManager, await png())).body.data[0];
    await reviewer.post(`/api/v1/admin/media/${up.id}/approve`, {});
    const good = (await catalogManager.post('/api/v1/admin/products', product('PLT-B1', { images: [{ media: up.id }] }))).body.data;
    const noImage = (await catalogManager.post('/api/v1/admin/products', product('PLT-B2'))).body.data;
    const res = await catalogManager.post('/api/v1/admin/products/bulk', { ids: [good._id, noImage._id], action: 'publish', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ id: good._id, ok: true }), expect.objectContaining({ id: noImage._id, ok: false, code: 'PUBLISH_REQUIRES_APPROVED_IMAGE' })]);
  });
});

describe('homepage content management', () => {
  test('draft → preview → publish with approved images only, versioned and synchronised', async () => {
    const marketing = await createStaff('marketing_manager');
    expect((await new Client().get('/api/v1/content/homepage')).body.data.data).toBeNull();

    const pending = (await upload(marketing, await png(1600, 900), { query: 'purpose=content&targetId=homepage' })).body.data[0];
    const blocked = await marketing.put('/api/v1/admin/content/homepage/draft', { baseVersion: 0, data: { hero: { heading: 'Diwali Edit', image: { media: pending.id } } } });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('MEDIA_NOT_APPROVED');

    await reviewer.post(`/api/v1/admin/media/${pending.id}/approve`, {});
    const bad = await marketing.put('/api/v1/admin/content/homepage/draft', { baseVersion: 0, data: { hero: { primaryCta: { label: 'Go', href: 'javascript:alert(1)' } } } });
    expect(bad.status).toBe(400);

    const saved = await marketing.put('/api/v1/admin/content/homepage/draft', {
      baseVersion: 0,
      data: { hero: { heading: 'Diwali Edit', subheading: 'Lights, plates, celebration.', image: { media: pending.id, alt: 'Festive table' }, primaryCta: { label: 'Shop now', href: '/shop' } }, sections: [{ id: 'hero', enabled: true }, { id: 'gallery', enabled: false }] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ draftVersion: 1, publishedVersion: 0, hasUnpublishedChanges: true });
    expect(saved.body.data.draft.hero.image.url).toMatch(/\/uploads\//);
    // Not public until published.
    expect((await new Client().get('/api/v1/content/homepage')).body.data.data).toBeNull();

    const stale = await marketing.put('/api/v1/admin/content/homepage/draft', { baseVersion: 0, data: { hero: { heading: 'Other tab' } } });
    expect(stale.status).toBe(409);

    const token = (await marketing.post('/api/v1/admin/content/homepage/preview-token', {})).body.data.token;
    const preview = await new Client().get('/api/v1/content/homepage/preview', { token });
    expect(preview.body.data.data.hero.heading).toBe('Diwali Edit');
    expect((await new Client().get('/api/v1/content/homepage/preview', { token: `${token}x` })).status).toBe(401);
    expect((await new Client().get('/api/v1/content/footer/preview', { token })).status).toBe(401);

    events.length = 0;
    revalidations.length = 0;
    expect((await marketing.post('/api/v1/admin/content/homepage/publish', { version: 9 })).status).toBe(409);
    const pub = await marketing.post('/api/v1/admin/content/homepage/publish', { version: 1 });
    expect(pub.status).toBe(200);
    await flush();
    const live = await new Client().get('/api/v1/content/homepage');
    expect(live.body.data).toMatchObject({ version: 1, data: { hero: { heading: 'Diwali Edit' } } });
    expect(events).toEqual([expect.objectContaining({ event: 'homepage:updated', key: 'homepage' })]);
    expect(revalidations.flatMap((r) => r.tags)).toContain('content:homepage');

    // Media used by published content cannot be deleted.
    expect((await marketing.delete(`/api/v1/admin/media/${pending.id}`)).status).toBe(409);

    // Rollback re-publishes an earlier version as a new one.
    await marketing.put('/api/v1/admin/content/homepage/draft', { baseVersion: 1, data: { hero: { heading: 'Changed' } } });
    await marketing.post('/api/v1/admin/content/homepage/publish', { version: 2 });
    const rb = await marketing.post('/api/v1/admin/content/homepage/rollback', { version: 1 });
    expect(rb.status).toBe(200);
    expect(rb.body.data.publishedVersion).toBe(3);
    expect((await new Client().get('/api/v1/content/homepage')).body.data.data.hero.heading).toBe('Diwali Edit');
  });

  test('informational pages: draft, publish, unpublish; customers cannot edit', async () => {
    const created = await superAdmin.post('/api/v1/admin/pages', { slug: 'care-guide', title: 'Care Guide', body: '## Washing\nHand wash gold-rimmed pieces.' });
    expect(created.status).toBe(201);
    expect((await new Client().get('/api/v1/pages/care-guide')).status).toBe(404);
    const pub = await superAdmin.post(`/api/v1/admin/pages/${created.body.data.id}/publish`, { version: 1 });
    expect(pub.status).toBe(200);
    expect((await new Client().get('/api/v1/pages/care-guide')).body.data.title).toBe('Care Guide');
    expect((await superAdmin.post('/api/v1/admin/pages', { slug: 'checkout', title: 'Nope' })).status).toBe(400);
    const cust = await registerCustomer();
    expect((await cust.put(`/api/v1/admin/pages/${created.body.data.id}/draft`, { baseVersion: 1, title: 'Hacked' })).status).toBe(403);
    await superAdmin.post(`/api/v1/admin/pages/${created.body.data.id}/unpublish`, {});
    expect((await new Client().get('/api/v1/pages/care-guide')).status).toBe(404);
  });
});

describe('public real-time channel', () => {
  const connect = (ns, opts = {}) =>
    new Promise((resolve, reject) => {
      const s = ioc(`${url}${ns}`, { transports: ['websocket'], reconnection: false, forceNew: true, ...opts });
      s.on('connect', () => resolve(s));
      s.on('connect_error', (e) => {
        s.close();
        reject(e);
      });
    });

  test('anonymous visitors receive publish events within a second; foreign origins are refused; clients cannot emit', async () => {
    await expect(connect('/public', { extraHeaders: { origin: 'https://evil.example' } })).rejects.toThrow('origin_not_allowed');
    const s = await connect('/public');
    try {
      s.emit('product:published', { id: 'fake' }); // ignored
      const up = (await upload(catalogManager, await png())).body.data[0];
      await reviewer.post(`/api/v1/admin/media/${up.id}/approve`, {});
      const p = (await catalogManager.post('/api/v1/admin/products', product('PLT-RT1', { images: [{ media: up.id }] }))).body.data;
      const started = Date.now();
      const got = new Promise((resolve) => s.on('product:published', resolve));
      await catalogManager.post(`/api/v1/admin/products/${p._id}/status`, { status: 'active' });
      const evt = await got;
      const latency = Date.now() - started;
      expect(evt).toMatchObject({ event: 'product:published', id: p._id, slug: p.slug });
      expect(Object.keys(evt).sort()).toEqual(['at', 'event', 'id', 'slug', 'v']); // identifiers only
      expect(latency).toBeLessThan(1000);
    } finally {
      s.close();
    }
  });
});

describe('dashboard overview', () => {
  test('counts are limited to the caller role', async () => {
    const res = await catalogManager.get('/api/v1/admin/overview');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('mediaPendingReview');
    expect(res.body.data).toHaveProperty('products');
    expect(res.body.data).not.toHaveProperty('ordersToFulfil');
    const cust = await registerCustomer();
    expect((await cust.get('/api/v1/admin/overview')).status).toBe(403);
  });
});
