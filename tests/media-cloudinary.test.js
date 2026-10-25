'use strict';

// This suite runs with the Cloudinary driver against an in-memory fake (no network).
Object.assign(process.env, { STORAGE_DRIVER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'testcloud', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', MEDIA_MAX_VIDEO_SECONDS: '60' });

const sharp = require('sharp');
const { startApp, stopApp, registerCustomer, createStaff } = require('./helpers/app');
const cloudinary = require('../src/services/cloudinary');
const { Upload } = require('../src/modules/media/media');

const uploads = [];
const destroyed = [];
const renamed = [];
let nextDuration = 12.4;
const fake = {
  uploader: {
    upload_stream(opts, cb) {
      return {
        end(buf) {
          uploads.push({ opts, bytes: buf.length, head: buf.subarray(0, 12) });
          const isVideo = opts.resource_type === 'video';
          setImmediate(() => cb(null, { public_id: `${opts.folder}/${opts.public_id}`, version: 1700000000, width: 640, height: 480, bytes: buf.length, format: isVideo ? 'mp4' : 'webp', ...(isVideo ? { duration: nextDuration } : {}) }));
        },
      };
    },
    async rename(from, to, opts) {
      renamed.push({ from, to, ...opts });
      return { public_id: to, version: 1700000099, type: opts.to_type };
    },
    async destroy(publicId, opts) {
      destroyed.push({ publicId, ...opts });
      return { result: 'ok' };
    },
  },
  url: (id, o = {}) => `https://res.cloudinary.com/testcloud/${o.resource_type || 'image'}/upload/${(o.transformation || []).map((t) => `w_${t.width}`).join(',')}/v${o.version}/${id}${o.format ? `.${o.format}` : ''}`,
};

beforeAll(async () => {
  await startApp();
  cloudinary.setClient(fake);
});
afterAll(stopApp);

const mp4 = (size = 4096) => {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'ascii');
  return b;
};

async function send(c, url, buf, filename, contentType) {
  await c.ensureCsrf();
  return c.agent.post(url).set('x-csrf-token', c.csrf).attach('files', buf, { filename, contentType });
}

test('images are sanitised by Sharp, uploaded once to Cloudinary, and served via transformations', async () => {
  const c = await registerCustomer();
  const jpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#d44' } }).withMetadata({ exif: { IFD0: { Copyright: 'gps-secret' } } }).jpeg().toBuffer();
  const res = await send(c, '/api/v1/uploads?purpose=return', jpeg, 'broken.jpg', 'image/jpeg');
  expect(res.status).toBe(201);
  const dto = res.body.data[0];
  expect(dto.kind).toBe('image');
  expect(dto.url).toMatch(/^https:\/\/res\.cloudinary\.com\/testcloud\/image\/upload\/w_1600/);
  expect(dto.thumbUrl).toMatch(/w_300/);
  const sent = uploads.at(-1);
  expect(sent.opts).toMatchObject({ resource_type: 'image', overwrite: false });
  expect(sent.opts.folder).toMatch(/^crockery\/return\/\d{4}-\d{2}$/);
  expect(sent.head.toString('ascii', 8, 12)).toBe('WEBP'); // re-encoded master, not the original bytes
  const doc = await Upload.findById(dto.id).lean();
  expect(doc).toMatchObject({ provider: 'cloudinary', kind: 'image' });
});

test('videos are uploaded as Cloudinary video assets with a poster image', async () => {
  const c = await registerCustomer();
  nextDuration = 12.4;
  const res = await send(c, '/api/v1/uploads?purpose=return', mp4(), 'unboxing.mp4', 'video/mp4');
  expect(res.status).toBe(201);
  const v = res.body.data[0];
  expect(v).toMatchObject({ kind: 'video', durationSec: 12.4 });
  expect(v.url).toMatch(/\/video\/upload\/.*\.mp4$/);
  expect(v.posterUrl).toMatch(/\/video\/upload\/.*\.jpg$/);
  expect(uploads.at(-1).opts.resource_type).toBe('video');
});

test('fake videos, disallowed types and over-long videos are rejected (and cleaned up)', async () => {
  const c = await registerCustomer();
  expect((await send(c, '/api/v1/uploads?purpose=chat', Buffer.from('MZ\x90\x00 not a video at all'), 'evil.mp4', 'video/mp4')).status).toBe(400);
  expect((await send(c, '/api/v1/uploads?purpose=chat', Buffer.from('%PDF-1.7'), 'doc.pdf', 'application/pdf')).status).toBe(400);
  nextDuration = 95;
  const long = await send(c, '/api/v1/uploads?purpose=chat', mp4(), 'long.mp4', 'video/mp4');
  expect(long.status).toBe(400);
  expect(long.body.error.code).toBe('VIDEO_TOO_LONG');
  expect(destroyed.at(-1)).toMatchObject({ resource_type: 'video', invalidate: true });
  nextDuration = 12.4;
});

test('admins attach videos to products; storefront shows them; delete removes from Cloudinary', async () => {
  const admin = await createStaff('super_admin');
  const vid = await send(admin, '/api/v1/admin/media?purpose=product', mp4(), 'demo.mp4', 'video/mp4');
  expect(vid.status).toBe(201);
  expect(vid.body.data[0]).toMatchObject({ status: 'pending_review', url: null, isPrivate: true });
  expect(uploads.at(-1).opts.type).toBe('authenticated'); // stored privately until approved
  const approved = await admin.post(`/api/v1/admin/media/${vid.body.data[0].id}/approve`, {});
  expect(approved.status).toBe(200);
  expect(renamed.at(-1)).toMatchObject({ type: 'authenticated', to_type: 'upload', resource_type: 'video' });
  const v = approved.body.data;
  const cat = await admin.post('/api/v1/admin/categories', { name: 'Mugs', slug: 'mugs' });
  const p = await admin.post('/api/v1/admin/products', {
    name: 'Video Mug',
    category: cat.body.data._id,
    images: [{ url: 'https://cdn.example.com/m.webp' }],
    variants: [{ sku: 'VID-MUG', mrp: 50000, price: 40000 }],
    status: 'active',
  });
  const set = await admin.patch(`/api/v1/admin/products/${p.body.data._id}/videos`, { videos: [{ media: v.id, title: 'Close-up' }] });
  expect(set.status).toBe(200);
  const pub = await registerCustomer();
  const detail = await pub.get(`/api/v1/products/${p.body.data.slug}`);
  expect(detail.body.data.videos[0]).toMatchObject({ title: 'Close-up', durationSec: 12.4 });
  expect((await admin.delete(`/api/v1/admin/media/${v.id}`)).status).toBe(409); // still attached to a product
  await admin.patch(`/api/v1/admin/products/${p.body.data._id}/videos`, { videos: [] });
  const del = await admin.delete(`/api/v1/admin/media/${v.id}`);
  expect(del.status).toBe(200);
  expect(destroyed.at(-1).resource_type).toBe('video');
});
