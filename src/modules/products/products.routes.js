'use strict';

const { z } = require('zod');
const Product = require('./product.model');
const service = require('./product.service');
const schemas = require('./product.schemas');
const inventory = require('../inventory/inventory.service');
const { Inventory, BackInStockSubscription } = require('../inventory/inventory.models');
const cache = require('../../services/cache');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { Upload } = require('../media/media.model');
const mediaService = require('../media/media.service');
const { objectId, paginationSchema, paginate, escapeRegex } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');
const { PRODUCT_STATUS } = require('../../constants/statuses');

// ------------------------------------------------------------------ public
const pub = createRouter({ prefix: '/api/v1', tag: 'Catalog' });

pub.get('/products', { summary: 'Browse/filter/sort products', query: schemas.listQuery }, async (req, res) => {
  const { items, meta } = await service.listProducts(req.query);
  ok(res, items, { meta });
});

pub.get('/products/facets', { summary: 'Filter facets (brands, materials, colours, set sizes, price range)', query: schemas.listQuery.pick({ q: true, category: true, collection: true }) }, async (req, res) => {
  ok(res, await service.facets(req.query));
});

pub.get('/products/:slug', { summary: 'Product detail by slug or id (live stock status per variant)', params: z.object({ slug: z.string().max(140) }) }, async (req, res) => {
  ok(res, await service.getPublicProduct(req.params.slug));
});

pub.get('/products/:slug/related', { summary: 'Related products', params: z.object({ slug: z.string().max(140) }) }, async (req, res) => {
  ok(res, await service.relatedProducts(req.params.slug));
});

pub.post(
  '/products/:id/back-in-stock',
  { summary: 'Subscribe to a back-in-stock alert for a SKU', customer: true, params: z.object({ id: objectId() }), body: z.object({ sku: z.string().trim().toUpperCase().max(64) }) },
  async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, status: PRODUCT_STATUS.ACTIVE, 'variants.sku': req.body.sku }).select('_id').lean();
    if (!product) throw notFound('Product variant');
    await BackInStockSubscription.updateOne(
      { user: req.auth.userId, sku: req.body.sku },
      { $set: { product: product._id, notifiedAt: null } },
      { upsert: true },
    );
    ok(res, null, { message: "We'll notify you when it's back in stock" });
  },
);

pub.get('/search', { summary: 'Full-text product search (alias of /products with q)', query: schemas.listQuery.extend({ q: z.string().trim().min(1).max(100) }) }, async (req, res) => {
  const { items, meta } = await service.listProducts(req.query);
  ok(res, items, { meta });
});

pub.get('/search/suggest', { summary: 'Autocomplete suggestions', query: z.object({ q: z.string().trim().min(2).max(60) }) }, async (req, res) => {
  const q = req.query.q.toLowerCase();
  const items = await cache.wrap(cache.NS.CATALOG, `suggest:${q}`, 300, () =>
    Product.find({ status: PRODUCT_STATUS.ACTIVE, name: new RegExp(`(^|\\s)${escapeRegex(q)}`, 'i') })
      .select('name slug images priceMin')
      .sort({ salesCount: -1 })
      .limit(8)
      .lean()
      .then((rows) =>
        rows.map((p) => {
          const img = Product.publicImages(p.images)[0];
          return { name: p.name, slug: p.slug, priceMin: p.priceMin, image: img?.thumbUrl || img?.url };
        }),
      ),
  );
  ok(res, items);
});

// ------------------------------------------------------------------ admin
const admin = createRouter({ prefix: '/api/v1/admin/products', tag: 'Admin: Catalog' });

function stripCost(req, product) {
  if (req.auth.permissions.includes(PERMISSIONS.CATALOG_COST)) return product;
  const p = product.toObject ? product.toObject() : product;
  p.variants = p.variants.map(({ costPrice, ...v }) => v);
  return p;
}

admin.get(
  '/',
  {
    summary: 'List products (all statuses)',
    permission: PERMISSIONS.CATALOG_READ,
    query: paginationSchema.extend({
      q: z.string().max(100).optional(),
      status: z.enum(Object.values(PRODUCT_STATUS)).optional(),
      category: objectId().optional(),
      collection: objectId().optional(),
      inStock: z.enum(['true', 'false']).optional(),
      featured: z.enum(['true', 'false']).optional(),
      type: z.enum(['simple', 'bundle']).optional(),
      pendingMedia: z.enum(['true']).optional(),
      sort: z.enum(['updated', 'newest', 'name', 'price_asc', 'price_desc', 'sales']).default('updated'),
    }),
  },
  async (req, res) => {
    const { page, limit, q, status, category, collection, inStock, featured, type, pendingMedia, sort } = req.query;
    const filter = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: rx }, { 'variants.sku': rx }, { brand: rx }, { slug: rx }];
    }
    if (status) filter.status = status;
    if (category) filter.categoryPath = category;
    if (collection) filter.collections = collection;
    if (inStock) filter.inStock = inStock === 'true';
    if (featured) filter['flags.featured'] = featured === 'true';
    if (type) filter.type = type;
    if (pendingMedia) filter.$and = [{ $or: [{ 'images.pending': true }, { 'images.replacement.media': { $exists: true } }] }];
    const SORTS = { updated: { updatedAt: -1 }, newest: { createdAt: -1 }, name: { name: 1 }, price_asc: { priceMin: 1 }, price_desc: { priceMax: -1 }, sales: { salesCount: -1 } };
    const { items, meta } = await paginate(Product, filter, {
      page,
      limit,
      sort: { ...SORTS[sort], _id: 1 },
      select: 'name slug type status brand category priceMin priceMax inStock salesCount flags variants.sku variants.price variants.mrp variants.costPrice images.thumbUrl images.url images.pending images.sortOrder images.replacement.media updatedAt publishedAt',
      populate: { path: 'category', select: 'name' },
    });
    ok(
      res,
      items.map((p) => {
        const out = stripCost(req, p);
        const thumb = Product.publicImages(p.images)[0];
        return { ...out, thumbUrl: thumb?.thumbUrl || thumb?.url || null, imageCount: p.images?.length || 0, pendingImages: (p.images || []).filter((i) => i.pending).length, stagedReplacements: (p.images || []).filter((i) => i.replacement?.media).length, images: undefined };
      }),
      { meta },
    );
  },
);

admin.get('/counts', { summary: 'Product counts by status', permission: PERMISSIONS.CATALOG_READ }, async (req, res) => {
  const rows = await Product.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  ok(res, Object.fromEntries(Object.values(PRODUCT_STATUS).map((s) => [s, rows.find((r) => r._id === s)?.n || 0])));
});

admin.post(
  '/bulk',
  {
    summary:
      'Bulk action on up to 100 products (publish, unpublish, archive, submit_for_review, feature/unfeature, mark_new/unmark_new, mark_bestseller/unmark_bestseller, assign_category with categoryId, adjust_stock with delta + reason — needs inventory:write, delete — permanent, super admin only). Each product is validated and reported separately.',
    permission: PERMISSIONS.CATALOG_WRITE,
    body: z
      .object({
        ids: z.array(objectId()).min(1).max(100),
        action: z.enum(service.BULK_ACTIONS),
        confirm: z.literal(true),
        categoryId: objectId().optional(),
        delta: z.number().int().min(-100000).max(100000).optional(),
        reason: z.string().trim().min(3).max(300).optional(),
      })
      .refine((b) => b.action !== 'assign_category' || b.categoryId, { message: 'categoryId is required', path: ['categoryId'] })
      .refine((b) => b.action !== 'adjust_stock' || (b.delta && b.reason), { message: 'delta (non-zero) and reason are required', path: ['delta'] }),
  },
  async (req, res) => {
    const { categoryId, delta, reason } = req.body;
    const results = await service.bulkAction([...new Set(req.body.ids)], req.body.action, req, { categoryId, delta, reason });
    ok(res, results, { message: `${results.filter((r) => r.ok).length} of ${results.length} updated` });
  },
);

admin.get('/:id', { summary: 'Product detail with per-SKU inventory', permission: PERMISSIONS.CATALOG_READ, params: z.object({ id: objectId() }) }, async (req, res) => {
  const product = await Product.findById(req.params.id).populate('createdBy', 'name').populate('updatedBy', 'name').lean();
  if (!product) throw notFound('Product');
  const mediaIds = product.images.flatMap((i) => [i.media, i.replacement?.media, i.previous?.media]).filter(Boolean);
  const [stock, availability, uploads] = await Promise.all([
    product.type === 'bundle' ? [] : Inventory.find({ sku: { $in: product.variants.map((v) => v.sku) } }).lean(),
    inventory.productAvailability(product),
    Upload.find({ _id: { $in: mediaIds } }).select('-history').lean(),
  ]);
  // Review state and private previews for every attached/staged asset, so the editor can show pending images.
  const mediaById = Object.fromEntries(uploads.map((u) => [String(u._id), mediaService.adminDto(u)]));
  ok(res, { ...stripCost(req, product), inventory: stock, availability, media: mediaById });
});

admin.post('/', { summary: 'Create product (draft by default)', permission: PERMISSIONS.CATALOG_WRITE, body: schemas.createProduct }, async (req, res) => {
  created(res, stripCost(req, await service.createProduct(req.body, req)));
});

admin.patch('/:id', { summary: 'Update product (send expectedUpdatedAt to get 409 STALE_WRITE instead of overwriting a newer edit)', permission: PERMISSIONS.CATALOG_WRITE, params: z.object({ id: objectId() }), body: schemas.updateProduct }, async (req, res) => {
  ok(res, stripCost(req, await service.updateProduct(req.params.id, req.body, req)), { message: 'Product updated' });
});

admin.post(
  '/:id/status',
  {
    summary: 'Publish (active), unpublish (inactive), submit for review, or archive. Publishing requires at least one approved image.',
    permission: PERMISSIONS.CATALOG_WRITE,
    params: z.object({ id: objectId() }),
    body: z.object({ status: z.enum(Object.values(PRODUCT_STATUS)), expectedUpdatedAt: z.coerce.date().optional() }),
  },
  async (req, res) => {
    ok(res, stripCost(req, await service.setStatus(req.params.id, req.body.status, req, { expectedUpdatedAt: req.body.expectedUpdatedAt })), { message: 'Status updated' });
  },
);

admin.delete('/:id', { summary: 'Archive a product (historical orders keep their snapshot)', permission: PERMISSIONS.CATALOG_WRITE, params: z.object({ id: objectId() }) }, async (req, res) => {
  await service.setStatus(req.params.id, PRODUCT_STATUS.ARCHIVED, req);
  ok(res, null, { message: 'Product archived' });
});

admin.delete(
  '/:id/permanent',
  {
    summary: 'Permanently delete a product, even if published (super admin only). Refused (409) when it is in an order, an active checkout or a bundle — archive those instead.',
    permission: PERMISSIONS.CATALOG_WRITE,
    params: z.object({ id: objectId() }),
  },
  async (req, res) => {
    const result = await service.deleteProductPermanently(req.params.id, req);
    ok(res, result, { message: result.wasPublished ? 'Product deleted and removed from the store' : 'Product deleted' });
  },
);

admin.patch(
  '/:id/images',
  {
    summary: 'Replace the ordered gallery. Entries reference uploads by media id; pending uploads may be attached but stay hidden publicly until approved.',
    permission: PERMISSIONS.CATALOG_WRITE,
    params: z.object({ id: objectId() }),
    body: z.object({ images: z.array(schemas.imageInput).max(15), expectedUpdatedAt: z.coerce.date().optional() }),
  },
  async (req, res) => {
    const product = await service.setImages(req.params.id, req.body.images, req, { expectedUpdatedAt: req.body.expectedUpdatedAt });
    ok(res, product.images, { message: 'Images updated' });
  },
);

const imageParams = z.object({ id: objectId(), imageId: objectId() });

admin.post(
  '/:id/images/:imageId/replacement',
  { summary: 'Stage an uploaded image as the replacement for a live gallery image (live image stays until published)', permission: PERMISSIONS.CATALOG_WRITE, params: imageParams, body: z.object({ media: objectId() }) },
  async (req, res) => {
    const product = await service.stageReplacement(req.params.id, null, req.body.media, req, { imageId: req.params.imageId });
    ok(res, product.images, { message: 'Replacement staged' });
  },
);

admin.post('/:id/images/:imageId/replacement/publish', { summary: 'Swap in the approved replacement (atomic; previous image kept for rollback)', permission: PERMISSIONS.CATALOG_WRITE, params: imageParams }, async (req, res) => {
  const product = await service.publishReplacement(req.params.id, req.params.imageId, req);
  ok(res, product.images, { message: 'Replacement published' });
});

admin.delete('/:id/images/:imageId/replacement', { summary: 'Discard a staged replacement', permission: PERMISSIONS.CATALOG_WRITE, params: imageParams }, async (req, res) => {
  const product = await service.cancelReplacement(req.params.id, req.params.imageId, req);
  ok(res, product.images, { message: 'Replacement discarded' });
});

admin.post('/:id/images/:imageId/rollback', { summary: 'Restore the image that was replaced most recently', permission: PERMISSIONS.CATALOG_WRITE, params: imageParams }, async (req, res) => {
  const product = await service.rollbackImage(req.params.id, req.params.imageId, req);
  ok(res, product.images, { message: 'Image restored' });
});

admin.patch(
  '/:id/videos',
  {
    summary: 'Replace the ordered product video list (approved video uploads only; max 5)',
    permission: PERMISSIONS.CATALOG_WRITE,
    params: z.object({ id: objectId() }),
    body: z.object({ videos: z.array(schemas.videoInput).max(5) }),
  },
  async (req, res) => {
    const product = await service.setVideos(req.params.id, req.body.videos, req);
    ok(res, product.videos, { message: 'Videos updated' });
  },
);

module.exports = { routers: [pub, admin] };
