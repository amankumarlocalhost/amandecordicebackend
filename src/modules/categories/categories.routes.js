'use strict';

const { z } = require('zod');
const Category = require('./category.model');
const Product = require('../products/product.model');
const cache = require('../../services/cache');
const sync = require('../../services/sync');
const media = require('../media/media.service');
const audit = require('../audit/audit');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, badRequest, conflict } = require('../../utils/errors');
const { objectId, slugify, isObjectId } = require('../../utils/common');
const { PERMISSIONS } = require('../../constants/roles');

const body = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).max(100).optional(),
  parent: objectId().nullable().optional(),
  description: z.string().max(2000).optional(),
  // An approved upload (media id) or an allow-listed external URL; null removes the image.
  image: z.object({ media: objectId().optional(), url: z.string().url().optional(), alt: z.string().max(160).optional() }).refine((i) => i.media || i.url, 'image needs media or url').nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  seo: z.object({ title: z.string().max(70), description: z.string().max(170), keywords: z.array(z.string().max(40)).max(15) }).partial().optional(),
});

function buildTree(categories) {
  const byId = new Map(categories.map((c) => [String(c._id), { ...c, children: [] }]));
  const roots = [];
  for (const c of byId.values()) {
    if (c.parent && byId.has(String(c.parent))) byId.get(String(c.parent)).children.push(c);
    else if (!c.parent) roots.push(c);
  }
  const sort = (arr) => arr.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).forEach((c) => sort(c.children));
  sort(roots);
  return roots;
}

async function resolveParent(parentId) {
  if (!parentId) return { parent: null, ancestors: [], level: 0 };
  const parent = await Category.findById(parentId).lean();
  if (!parent) throw badRequest('Parent category not found');
  if (parent.level >= 3) throw badRequest('Categories can be nested at most 4 levels deep');
  return { parent: parent._id, ancestors: [...parent.ancestors, parent._id], level: parent.level + 1 };
}

async function invalidate(cat) {
  await cache.bump(cache.NS.CATEGORIES, cache.NS.CATALOG);
  sync.changed({ tags: [sync.TAGS.CATEGORIES, sync.TAGS.CATALOG], events: [{ event: sync.EVENTS.CATEGORY_UPDATED, id: cat ? String(cat._id) : undefined, slug: cat?.slug }] });
}

async function withImage(data, existing) {
  if (data.image) data.image = await media.resolveApprovedImage(data.image, { field: 'image', existing: existing?.image });
  return data;
}

const pub = createRouter({ prefix: '/api/v1/categories', tag: 'Catalog' });

pub.get('/', { summary: 'Category tree (active categories)' }, async (req, res) => {
  const tree = await cache.wrap(cache.NS.CATEGORIES, 'tree', 600, async () => {
    const cats = await Category.find({ isActive: true }).select('name slug parent level image sortOrder description isFeatured').lean();
    return buildTree(cats);
  });
  ok(res, tree);
});

pub.get('/:slug', { summary: 'Category by slug or id, with breadcrumb', params: z.object({ slug: z.string().max(120) }) }, async (req, res) => {
  const filter = isObjectId(req.params.slug) ? { _id: req.params.slug } : { slug: req.params.slug };
  const cat = await Category.findOne({ ...filter, isActive: true }).lean();
  if (!cat) throw notFound('Category');
  const [breadcrumb, children] = await Promise.all([
    Category.find({ _id: { $in: cat.ancestors } }).select('name slug level').sort({ level: 1 }).lean(),
    Category.find({ parent: cat._id, isActive: true }).select('name slug image sortOrder description').sort({ sortOrder: 1 }).lean(),
  ]);
  ok(res, { ...cat, breadcrumb, children });
});

const admin = createRouter({ prefix: '/api/v1/admin/categories', tag: 'Admin: Catalog' });

admin.get('/', { summary: 'All categories (flat, incl. inactive) with product counts (incl. sub-categories) and direct product counts', permission: PERMISSIONS.CATALOG_READ }, async (req, res) => {
  const [cats, counts, direct] = await Promise.all([
    Category.find().sort({ level: 1, sortOrder: 1 }).lean(),
    Product.aggregate([{ $unwind: '$categoryPath' }, { $group: { _id: '$categoryPath', n: { $sum: 1 } } }]),
    Product.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  const directById = new Map(direct.map((c) => [String(c._id), c.n]));
  // productCount includes sub-categories; directProductCount is products assigned to this category itself.
  ok(res, cats.map((c) => ({ ...c, productCount: byId.get(String(c._id)) || 0, directProductCount: directById.get(String(c._id)) || 0 })));
});

admin.post('/', { summary: 'Create category', permission: PERMISSIONS.CATALOG_WRITE, body }, async (req, res) => {
  const tree = await resolveParent(req.body.parent);
  await withImage(req.body);
  const cat = await Category.create({ ...req.body, image: req.body.image || undefined, ...tree, slug: req.body.slug || slugify(req.body.name) });
  await audit.record({ req, action: 'category.create', resource: { type: 'category', id: cat._id } });
  await invalidate(cat);
  created(res, cat);
});

admin.patch('/:id', { summary: 'Update category (moving re-parents descendants)', permission: PERMISSIONS.CATALOG_WRITE, params: z.object({ id: objectId() }), body: body.partial() }, async (req, res) => {
  const cat = await Category.findById(req.params.id);
  if (!cat) throw notFound('Category');
  const data = await withImage({ ...req.body }, cat.toObject());
  if (data.image === null) data.image = undefined;
  if (data.parent !== undefined && String(data.parent) !== String(cat.parent)) {
    if (data.parent && (String(data.parent) === String(cat._id) || (await Category.exists({ _id: data.parent, ancestors: cat._id })))) {
      throw badRequest('A category cannot be moved under itself');
    }
    Object.assign(data, await resolveParent(data.parent));
    cat.set(data);
    await cat.save();
    // Rebuild ancestors of descendants and product category paths.
    const descendants = await Category.find({ ancestors: cat._id }).sort({ level: 1 });
    for (const d of descendants) {
      const parent = await Category.findById(d.parent).lean();
      d.ancestors = [...parent.ancestors, parent._id];
      d.level = parent.level + 1;
      await d.save();
    }
    for (const c of [cat, ...descendants]) await Product.updateMany({ category: c._id }, { $set: { categoryPath: [...c.ancestors, c._id] } });
  } else {
    delete data.parent;
    cat.set(data);
    await cat.save();
  }
  await audit.record({ req, action: 'category.update', resource: { type: 'category', id: cat._id }, metadata: { fields: Object.keys(req.body) } });
  await invalidate(cat);
  ok(res, cat, { message: 'Category updated' });
});

admin.delete('/:id', { summary: 'Delete an empty category (else deactivate it)', permission: PERMISSIONS.CATALOG_WRITE, params: z.object({ id: objectId() }) }, async (req, res) => {
  const [children, products] = await Promise.all([Category.exists({ parent: req.params.id }), Product.exists({ categoryPath: req.params.id })]);
  if (children || products) throw conflict('Category has sub-categories or products. Deactivate it instead.', 'CATEGORY_IN_USE');
  const cat = await Category.findByIdAndDelete(req.params.id);
  if (!cat) throw notFound('Category');
  await audit.record({ req, action: 'category.delete', resource: { type: 'category', id: cat._id }, metadata: { name: cat.name } });
  await invalidate(cat);
  ok(res, null, { message: 'Category deleted' });
});

module.exports = { routers: [pub, admin], buildTree };
