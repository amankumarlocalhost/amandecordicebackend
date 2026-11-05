'use strict';

const { z } = require('zod');
const Collection = require('./collection.model');
const Product = require('../products/product.model');
const productService = require('../products/product.service');
const cache = require('../../services/cache');
const sync = require('../../services/sync');
const media = require('../media/media.service');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, slugify, isObjectId } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');

const body = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).max(100).optional(),
  type: z.enum(['curated', 'gift', 'festival', 'brand', 'seasonal', 'space']).default('curated'),
  description: z.string().max(2000).optional(),
  image: z.object({ media: objectId().optional(), url: z.string().url().optional(), alt: z.string().max(160).optional() }).refine((i) => i.media || i.url, 'image needs media or url').nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  seo: z.object({ title: z.string().max(70), description: z.string().max(170), keywords: z.array(z.string().max(40)).max(15) }).partial().optional(),
});

const liveFilter = () => {
  const now = new Date();
  return {
    isActive: true,
    $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }],
  };
};

async function changed(col) {
  await cache.bump(cache.NS.CATALOG);
  sync.changed({ tags: [sync.TAGS.COLLECTIONS, sync.TAGS.CATALOG], events: [{ event: sync.EVENTS.COLLECTION_UPDATED, id: String(col._id), slug: col.slug }] });
}

async function withImage(data, existing) {
  if (data.image) data.image = await media.resolveApprovedImage(data.image, { field: 'image', existing: existing?.image });
  return data;
}

const pub = createRouter({ prefix: '/api/v1/collections', tag: 'Catalog' });

pub.get('/', { summary: 'Live collections (gift sets, festive edits, brand lines)', query: z.object({ type: z.enum(['curated', 'gift', 'festival', 'brand', 'seasonal', 'space']).optional() }) }, async (req, res) => {
  const items = await cache.wrap(cache.NS.CATALOG, `collections:${req.query.type || 'all'}`, 300, () =>
    Collection.find({ ...liveFilter(), ...(req.query.type ? { type: req.query.type } : {}) }).sort({ sortOrder: 1 }).select('-__v').lean(),
  );
  ok(res, items);
});

pub.get('/:slug', { summary: 'Collection with its first page of products', params: z.object({ slug: z.string().max(120) }) }, async (req, res) => {
  const filter = isObjectId(req.params.slug) ? { _id: req.params.slug } : { slug: req.params.slug };
  const col = await Collection.findOne({ ...filter, ...liveFilter() }).lean();
  if (!col) throw notFound('Collection');
  const products = await productService.listProducts({ collection: String(col._id), page: 1, limit: 24, sort: 'popularity' });
  ok(res, { ...col, products: products.items }, { meta: products.meta });
});

const admin = createRouter({ prefix: '/api/v1/admin/collections', tag: 'Admin: Catalog' });

admin.get('/', { summary: 'All collections with product counts', permission: PERMISSIONS.CATALOG_READ }, async (req, res) => {
  const [cols, counts] = await Promise.all([Collection.find().sort({ sortOrder: 1 }).lean(), Product.aggregate([{ $unwind: '$collections' }, { $group: { _id: '$collections', n: { $sum: 1 } } }])]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  ok(res, cols.map((c) => ({ ...c, productCount: byId.get(String(c._id)) || 0 })));
});

admin.post('/', { summary: 'Create collection', permission: PERMISSIONS.CATALOG_WRITE, body }, async (req, res) => {
  await withImage(req.body);
  const col = await Collection.create({ ...req.body, image: req.body.image || undefined, slug: req.body.slug || slugify(req.body.name) });
  await audit.record({ req, action: 'collection.create', resource: { type: 'collection', id: col._id } });
  await changed(col);
  created(res, col);
});

admin.patch('/:id', { summary: 'Update collection', permission: PERMISSIONS.CATALOG_WRITE, params: z.object({ id: objectId() }), body: body.partial() }, async (req, res) => {
  const data = await withImage({ ...req.body }, await Collection.findById(req.params.id).select('image').lean());
  const update = data.image === null ? { $set: { ...data, image: undefined }, $unset: { image: 1 } } : { $set: data };
  if (data.image === null) delete update.$set.image;
  const col = await Collection.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!col) throw notFound('Collection');
  await audit.record({ req, action: 'collection.update', resource: { type: 'collection', id: col._id }, metadata: { fields: Object.keys(req.body) } });
  await changed(col);
  ok(res, col, { message: 'Collection updated' });
});

admin.put(
  '/:id/products',
  { summary: 'Add or remove products from a collection', permission: PERMISSIONS.CATALOG_WRITE, params: z.object({ id: objectId() }), body: z.object({ add: z.array(objectId()).max(200).default([]), remove: z.array(objectId()).max(200).default([]) }) },
  async (req, res) => {
    if (!(await Collection.exists({ _id: req.params.id }))) throw notFound('Collection');
    if (req.body.add.length) await Product.updateMany({ _id: { $in: req.body.add } }, { $addToSet: { collections: req.params.id } });
    if (req.body.remove.length) await Product.updateMany({ _id: { $in: req.body.remove } }, { $pull: { collections: req.params.id } });
    await audit.record({ req, action: 'collection.products', resource: { type: 'collection', id: req.params.id }, metadata: req.body });
    await changed({ _id: req.params.id });
    ok(res, null, { message: 'Collection products updated' });
  },
);

admin.delete('/:id', { summary: 'Delete collection (products are detached)', permission: PERMISSIONS.CATALOG_WRITE, params: z.object({ id: objectId() }) }, async (req, res) => {
  const col = await Collection.findByIdAndDelete(req.params.id);
  if (!col) throw notFound('Collection');
  await Product.updateMany({ collections: col._id }, { $pull: { collections: col._id } });
  await audit.record({ req, action: 'collection.delete', resource: { type: 'collection', id: col._id }, metadata: { name: col.name } });
  await changed(col);
  ok(res, null, { message: 'Collection deleted' });
});

module.exports = { routers: [pub, admin] };
