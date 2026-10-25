'use strict';

const crypto = require('crypto');
const Product = require('./product.model');
const Category = require('../categories/category.model');
const Collection = require('../collections/collection.model');
const inventory = require('../inventory/inventory.service');
const cache = require('../../services/cache');
const audit = require('../audit/audit');
const bus = require('../../events/bus');
const sync = require('../../services/sync');
const media = require('../media/media.service');
const { Upload } = require('../media/media.model');
const { getSettings } = require('../settings/settings');
const { slugify, escapeRegex, isObjectId, pageMeta } = require('../../utils/common');
const { badRequest, notFound, forbidden, conflict, unprocessable } = require('../../utils/errors');
const { PERMISSIONS, ROLES } = require('../../constants/roles');
const { PRODUCT_STATUS, MEDIA_STATUS } = require('../../constants/statuses');

const LOW_STOCK_DISPLAY = 5;

// ------------------------------------------------------------------ derived fields & validation

function computeDerived(p) {
  const active = p.variants.filter((v) => v.status !== 'inactive');
  const prices = (active.length ? active : p.variants).map((v) => v.price);
  p.priceMin = Math.min(...prices);
  p.priceMax = Math.max(...prices);
  p.maxDiscountBps = Math.max(0, ...p.variants.map((v) => (v.mrp > 0 ? Math.floor(((v.mrp - v.price) * 10000) / v.mrp) : 0)));
  if (!p.variants.some((v) => v.isDefault)) p.variants[0].isDefault = true;
  return p;
}

async function validateAndResolve(data, existing) {
  const variants = data.variants || existing?.variants || [];
  const skus = variants.map((v) => v.sku.toUpperCase());
  if (new Set(skus).size !== skus.length) throw badRequest('Variant SKUs must be unique within a product');
  for (const v of variants) {
    if (v.price > v.mrp) throw badRequest(`Selling price exceeds MRP for ${v.sku}`);
  }
  if (variants.filter((v) => v.isDefault).length > 1) throw badRequest('Only one variant can be the default');
  if (data.variants) {
    const live = new Set((existing?.variants || []).flatMap((v) => v.images || []));
    for (const v of data.variants) {
      for (const url of v.images || []) {
        if (!live.has(url) && !(await media.isPublicSafeUrl(url))) throw badRequest(`Variant ${v.sku}: images must be approved uploads`, undefined, 'MEDIA_NOT_APPROVED');
      }
    }
  }

  // SKUs must be globally unique across products (the unique index enforces it; this gives a clear error).
  const clash = await Product.findOne({ 'variants.sku': { $in: skus }, ...(existing ? { _id: { $ne: existing._id } } : {}) }).select('name').lean();
  if (clash) throw badRequest(`SKU already used by product "${clash.name}"`);

  if (data.category) {
    const cat = await Category.findById(data.category).lean();
    if (!cat) throw badRequest('Category not found');
    data.categoryPath = [...cat.ancestors, cat._id];
  }
  if (data.collections?.length) {
    const n = await Collection.countDocuments({ _id: { $in: data.collections } });
    if (n !== new Set(data.collections.map(String)).size) throw badRequest('One or more collections not found');
  }

  const type = data.type || existing?.type || 'simple';
  if (type === 'bundle') {
    const items = data.bundleItems || existing?.bundleItems || [];
    if (!items.length) throw badRequest('A bundle needs at least one component');
    if (variants.length !== 1) throw badRequest('A bundle has exactly one variant (its own SKU and price)');
    const comps = await Product.find({ _id: { $in: items.map((i) => i.product) } }).select('name type variants.sku').lean();
    for (const item of items) {
      const comp = comps.find((c) => String(c._id) === String(item.product));
      if (!comp) throw badRequest(`Bundle component product ${item.product} not found`);
      if (comp.type === 'bundle') throw badRequest('Bundles cannot contain other bundles');
      if (!comp.variants.some((v) => v.sku === item.sku)) throw badRequest(`SKU ${item.sku} does not belong to ${comp.name}`);
      item.name = comp.name;
    }
    data.bundleItems = items;
  }
  return data;
}

async function uniqueSlug(base, excludeId) {
  const root = slugify(base) || 'product';
  let slug = root;
  for (let i = 2; await Product.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }); i++) slug = `${root}-${i}`;
  return slug;
}

function assertFieldPermissions(req, data, existing) {
  const perms = req.auth.permissions;
  const touchesCost = (data.variants || []).some((v) => v.costPrice !== undefined);
  if (touchesCost && !perms.includes(PERMISSIONS.CATALOG_COST)) throw forbidden('Changing cost price requires the catalog:cost permission');
  if (existing && data.variants) {
    const changed = data.variants.some((v) => {
      const old = existing.variants.find((o) => o.sku === v.sku.toUpperCase());
      return old && (old.price !== v.price || old.mrp !== v.mrp);
    });
    if (changed && !perms.includes(PERMISSIONS.PRICING_WRITE)) throw forbidden('Changing prices requires the pricing:write permission');
  }
}

/** Keeps cost prices the caller is not allowed to see/edit. */
function preserveCost(req, data, existing) {
  if (!existing || !data.variants || req.auth.permissions.includes(PERMISSIONS.CATALOG_COST)) return;
  for (const v of data.variants) {
    const old = existing.variants.find((o) => o.sku === v.sku.toUpperCase());
    if (old?.costPrice !== undefined) v.costPrice = old.costPrice;
  }
}

async function invalidate() {
  await cache.bump(cache.NS.CATALOG);
  bus.publish(bus.EVENTS.CATALOG_CHANGED, {});
}

/**
 * Storefront sync for one product. Drafts and other non-public states are never announced; a product
 * that leaves `active` is announced as unpublished so open pages drop it.
 */
function syncProduct(product, { wasActive, oldSlug } = {}) {
  const isActive = product.status === PRODUCT_STATUS.ACTIVE;
  if (!wasActive && !isActive) return;
  const event = isActive && !wasActive ? sync.EVENTS.PRODUCT_PUBLISHED : !isActive ? sync.EVENTS.PRODUCT_UNPUBLISHED : sync.EVENTS.PRODUCT_UPDATED;
  const tags = [sync.TAGS.CATALOG, sync.TAGS.product(product.slug), sync.TAGS.product(String(product._id))];
  if (oldSlug && oldSlug !== product.slug) tags.push(sync.TAGS.product(oldSlug));
  sync.changed({ tags, events: [{ event, id: String(product._id), slug: product.slug }] });
}

/** A product can only be published with at least one approved (publicly servable) image. */
function assertPublishable(product) {
  if (!Product.publicImages(product.images).length) {
    const pending = (product.images || []).some((i) => i.pending);
    throw unprocessable(
      pending ? "This product's images are still pending review. Approve at least one image before publishing." : 'Add at least one approved image before publishing',
      'PUBLISH_REQUIRES_APPROVED_IMAGE',
    );
  }
}

function assertFresh(product, expectedUpdatedAt) {
  if (expectedUpdatedAt && product.updatedAt && Math.abs(product.updatedAt.getTime() - new Date(expectedUpdatedAt).getTime()) > 1) {
    throw conflict('This product was changed by someone else since you opened it. Reload to see the latest version.', 'STALE_WRITE', { updatedAt: product.updatedAt, updatedBy: product.updatedBy });
  }
}

// ------------------------------------------------------------------ admin writes

async function createProduct(data, req) {
  assertFieldPermissions(req, data);
  await validateAndResolve(data);
  data.slug = await uniqueSlug(data.slug || data.name);
  if (data.images) data.images = await media.resolveGallery(data.images);
  if (data.videos) data.videos = await media.resolveVideos(data.videos);
  const product = new Product({ ...data, createdBy: req.auth.userId, updatedBy: req.auth.userId });
  computeDerived(product);
  if (product.status === PRODUCT_STATUS.ACTIVE) {
    assertPublishable(product);
    product.publishedAt = new Date();
  }
  await product.save();
  await inventory.ensureInventory(product);
  inventory.refreshStock({ skus: product.variants.map((v) => v.sku) }).catch(() => {});
  await audit.record({ req, action: 'product.create', resource: { type: 'product', id: product._id }, metadata: { name: product.name, skus: product.variants.map((v) => v.sku) } });
  await invalidate();
  syncProduct(product, { wasActive: false });
  return product;
}

async function updateProduct(id, input, req) {
  const { expectedUpdatedAt, ...data } = input;
  const product = await Product.findById(id);
  if (!product) throw notFound('Product');
  assertFresh(product, expectedUpdatedAt);
  const wasActive = product.status === PRODUCT_STATUS.ACTIVE;
  const oldSlug = product.slug;
  assertFieldPermissions(req, data, product);
  preserveCost(req, data, product);
  await validateAndResolve(data, product);
  if (data.slug && data.slug !== product.slug) data.slug = await uniqueSlug(data.slug, product._id);
  if (data.images) data.images = await media.resolveGallery(data.images, product.images);
  if (data.videos) data.videos = await media.resolveVideos(data.videos);

  const before = { status: product.status, prices: product.variants.map((v) => ({ sku: v.sku, mrp: v.mrp, price: v.price })) };
  if (data.variants) {
    // Keep sub-document ids stable for existing SKUs so carts/orders referencing variantId remain valid.
    data.variants = data.variants.map((v) => {
      const old = product.variants.find((o) => o.sku === v.sku.toUpperCase());
      return old ? { ...v, _id: old._id } : v;
    });
  }
  product.set({ ...data, updatedBy: req.auth.userId });
  computeDerived(product);
  if (product.status === PRODUCT_STATUS.ACTIVE) {
    assertPublishable(product);
    if (!product.publishedAt) product.publishedAt = new Date();
  }
  await product.save();
  await inventory.ensureInventory(product);
  inventory.refreshStock({ skus: product.variants.map((v) => v.sku) }).catch(() => {});
  await audit.record({
    req,
    action: 'product.update',
    resource: { type: 'product', id: product._id },
    metadata: { fields: Object.keys(data), before, after: { status: product.status, prices: product.variants.map((v) => ({ sku: v.sku, mrp: v.mrp, price: v.price })) } },
  });
  await invalidate();
  syncProduct(product, { wasActive, oldSlug });
  return product;
}

async function setStatus(id, status, req, { expectedUpdatedAt } = {}) {
  const product = await Product.findById(id);
  if (!product) throw notFound('Product');
  assertFresh(product, expectedUpdatedAt);
  if (status === PRODUCT_STATUS.ACTIVE) {
    assertPublishable(product);
    if (!product.publishedAt) product.publishedAt = new Date();
  }
  const from = product.status;
  product.status = status;
  product.updatedBy = req.auth.userId;
  await product.save();
  await audit.record({ req, action: 'product.status', resource: { type: 'product', id: product._id }, metadata: { from, to: status } });
  await invalidate();
  syncProduct(product, { wasActive: from === PRODUCT_STATUS.ACTIVE });
  return product;
}

// ------------------------------------------------------------------ gallery, replacement & rollback

async function setImages(id, images, req, { expectedUpdatedAt } = {}) {
  const product = await Product.findById(id);
  if (!product) throw notFound('Product');
  assertFresh(product, expectedUpdatedAt);
  const resolved = await media.resolveGallery(images, product.images);
  if (product.status === PRODUCT_STATUS.ACTIVE && !Product.publicImages(resolved).length) {
    throw unprocessable('A published product must keep at least one approved image. Unpublish it first, or keep an approved image.', 'PUBLISH_REQUIRES_APPROVED_IMAGE');
  }
  product.images = resolved;
  product.updatedBy = req.auth.userId;
  await product.save();
  await audit.record({ req, action: 'product.images', resource: { type: 'product', id: product._id }, metadata: { count: resolved.length, pending: resolved.filter((i) => i.pending).length } });
  await invalidate();
  syncProduct(product, { wasActive: product.status === PRODUCT_STATUS.ACTIVE });
  return product;
}

async function setVideos(id, videos, req) {
  const product = await Product.findById(id);
  if (!product) throw notFound('Product');
  product.videos = await media.resolveVideos(videos);
  product.updatedBy = req.auth.userId;
  await product.save();
  await audit.record({ req, action: 'product.videos', resource: { type: 'product', id: product._id }, metadata: { count: product.videos.length } });
  await invalidate();
  syncProduct(product, { wasActive: product.status === PRODUCT_STATUS.ACTIVE });
  return product;
}

function findImage(product, { imageId, mediaId }) {
  return product.images.find((i) => (imageId ? String(i._id) === String(imageId) : String(i.media) === String(mediaId)));
}

/**
 * Stages a replacement for a live gallery image. The live image keeps showing until the replacement is
 * approved in review AND published with publishReplacement().
 */
async function stageReplacement(productId, oldMediaId, newMediaId, req, { imageId } = {}) {
  const product = await Product.findById(productId);
  if (!product) throw notFound('Product');
  const img = findImage(product, { imageId, mediaId: oldMediaId });
  if (!img) throw badRequest("That image is not in this product's gallery");
  const u = await Upload.findById(newMediaId).lean();
  if (!u || u.kind !== 'image') throw badRequest('Replacement media not found');
  if (u.review?.status === MEDIA_STATUS.REJECTED) throw badRequest('This image was rejected in review', undefined, 'MEDIA_REJECTED');
  const ready = u.review?.status === MEDIA_STATUS.APPROVED;
  img.replacement = { media: u._id, ready, at: new Date(), by: req.auth.userId, ...(ready ? { url: u.url, thumbUrl: u.thumbUrl, mediumUrl: u.mediumUrl } : {}) };
  product.updatedBy = req.auth.userId;
  await product.save();
  await audit.record({ req, action: 'product.image.replacement_staged', resource: { type: 'product', id: product._id }, metadata: { imageId: img._id, from: img.media, to: u._id } });
  return product;
}

/** Marks an asset superseded (kept for rollback until cleanup) when nothing live uses it any more. */
async function markSuperseded(mediaId, req) {
  if (!mediaId) return;
  const stillLive = await Product.exists({ images: { $elemMatch: { media: mediaId, pending: { $ne: true } } } });
  if (stillLive) return;
  await Upload.updateOne(
    { _id: mediaId, 'review.status': MEDIA_STATUS.APPROVED },
    { $set: { 'review.status': MEDIA_STATUS.SUPERSEDED, supersededAt: new Date() }, $push: { history: { action: 'superseded', by: req.auth.userId, at: new Date() } } },
  );
}

/**
 * Atomically swaps a gallery image for its approved replacement. The conditional update guarantees the
 * swap happens exactly once and only if nobody changed that image meanwhile.
 */
async function publishReplacement(productId, imageId, req) {
  const product = await Product.findById(productId);
  if (!product) throw notFound('Product');
  const img = findImage(product, { imageId });
  if (!img?.replacement?.media) throw badRequest('This image has no staged replacement');
  const u = await Upload.findById(img.replacement.media).lean();
  if (u?.review?.status !== MEDIA_STATUS.APPROVED) throw unprocessable('The replacement has not been approved yet', 'MEDIA_NOT_APPROVED');
  const previous = { media: img.media, url: img.url, thumbUrl: img.thumbUrl, mediumUrl: img.mediumUrl, at: new Date(), by: req.auth.userId };
  const credit = media.creditFor(u);
  const res = await Product.updateOne(
    { _id: product._id, images: { $elemMatch: { _id: img._id, 'replacement.media': u._id } } },
    {
      $set: { 'images.$.media': u._id, 'images.$.url': u.url, 'images.$.thumbUrl': u.thumbUrl, 'images.$.mediumUrl': u.mediumUrl, 'images.$.pending': false, 'images.$.previous': previous, ...(credit ? { 'images.$.credit': credit } : {}), updatedBy: req.auth.userId },
      $unset: { 'images.$.replacement': 1, 'images.$.key': 1, ...(credit ? {} : { 'images.$.credit': 1 }) },
    },
  );
  if (!res.modifiedCount) throw conflict('The image changed while publishing. Reload and try again.', 'STALE_WRITE');
  await Upload.updateOne({ _id: u._id }, { $push: { history: { action: 'published', by: req.auth.userId, at: new Date(), note: String(product._id) } } });
  if (previous.media) await Upload.updateOne({ _id: previous.media }, { $set: { replacedBy: u._id } });
  await markSuperseded(previous.media, req);
  await audit.record({ req, action: 'product.image.replacement_published', resource: { type: 'product', id: product._id }, metadata: { imageId: img._id, from: previous.media, to: u._id } });
  await invalidate();
  const fresh = await Product.findById(product._id);
  syncProduct(fresh, { wasActive: fresh.status === PRODUCT_STATUS.ACTIVE });
  return fresh;
}

async function cancelReplacement(productId, imageId, req) {
  const res = await Product.updateOne({ _id: productId, 'images._id': imageId }, { $unset: { 'images.$.replacement': 1 }, $set: { updatedBy: req.auth.userId } });
  if (!res.matchedCount) throw notFound('Image');
  await audit.record({ req, action: 'product.image.replacement_cancelled', resource: { type: 'product', id: productId }, metadata: { imageId } });
  return Product.findById(productId);
}

/** Restores the previous asset of a replaced image (while it has not been cleaned up). */
async function rollbackImage(productId, imageId, req) {
  const product = await Product.findById(productId);
  if (!product) throw notFound('Product');
  const img = findImage(product, { imageId });
  if (!img?.previous?.url) throw badRequest('Nothing to roll back for this image');
  let old = null;
  if (img.previous.media) {
    old = await Upload.findById(img.previous.media).lean();
    if (!old || ![MEDIA_STATUS.APPROVED, MEDIA_STATUS.SUPERSEDED].includes(old.review?.status)) throw unprocessable('The previous image is no longer available', 'ROLLBACK_UNAVAILABLE');
  }
  const credit = old ? media.creditFor(old) : null;
  const current = { media: img.media, url: img.url, thumbUrl: img.thumbUrl, mediumUrl: img.mediumUrl, at: new Date(), by: req.auth.userId };
  const res = await Product.updateOne(
    { _id: product._id, images: { $elemMatch: { _id: img._id, media: img.media } } },
    {
      $set: { 'images.$.media': img.previous.media, 'images.$.url': img.previous.url, 'images.$.thumbUrl': img.previous.thumbUrl, 'images.$.mediumUrl': img.previous.mediumUrl, 'images.$.pending': false, 'images.$.previous': current, ...(credit ? { 'images.$.credit': credit } : {}), updatedBy: req.auth.userId },
      ...(credit ? {} : { $unset: { 'images.$.credit': 1 } }),
    },
  );
  if (!res.modifiedCount) throw conflict('The image changed meanwhile. Reload and try again.', 'STALE_WRITE');
  if (img.previous.media) {
    await Upload.updateOne(
      { _id: img.previous.media, 'review.status': MEDIA_STATUS.SUPERSEDED },
      { $set: { 'review.status': MEDIA_STATUS.APPROVED }, $unset: { supersededAt: 1 }, $push: { history: { action: 'restored', by: req.auth.userId, at: new Date() } } },
    );
  }
  await markSuperseded(current.media, req);
  await audit.record({ req, action: 'product.image.rollback', resource: { type: 'product', id: product._id }, metadata: { imageId: img._id, restored: img.previous.media, from: current.media } });
  await invalidate();
  const fresh = await Product.findById(product._id);
  syncProduct(fresh, { wasActive: fresh.status === PRODUCT_STATUS.ACTIVE });
  return fresh;
}

// ------------------------------------------------------------------ permanent delete

/**
 * Permanently deletes a product (any status, including published). Super admins only. Refused while
 * the product is part of an order, held in an active checkout reservation, or used inside a bundle —
 * those keep history consistent and should be archived instead. Carts, wishlists, stock alerts,
 * Q&A and promotion scopes are cleaned up; stock movement history and media are kept.
 */
async function deleteProductPermanently(id, req) {
  if (req.auth.role !== ROLES.SUPER_ADMIN) throw forbidden('Only a super admin can permanently delete products', 'SUPER_ADMIN_ONLY');
  const mongoose = require('mongoose');
  const product = await Product.findById(id).lean();
  if (!product) throw notFound('Product');
  const skus = product.variants.map((v) => v.sku);
  const { Inventory, StockReservation, BackInStockSubscription } = require('../inventory/inventory.models');
  const [inOrder, reserved, inBundle] = await Promise.all([
    mongoose.model('Order').exists({ 'items.product': product._id }),
    StockReservation.exists({ status: 'active', 'items.sku': { $in: skus } }),
    Product.exists({ _id: { $ne: product._id }, 'bundleItems.product': product._id }),
  ]);
  if (inOrder) throw conflict('This product is part of customer orders, so it cannot be deleted. Archive it instead — it disappears from the store and past orders keep their details.', 'PRODUCT_HAS_ORDERS');
  if (reserved) throw conflict('A customer is checking out with this product right now. Unpublish it and try again in a few minutes.', 'PRODUCT_RESERVED');
  if (inBundle) throw conflict('This product is a component of a bundle. Remove it from the bundle first.', 'PRODUCT_IN_BUNDLE');

  const wasActive = product.status === PRODUCT_STATUS.ACTIVE;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Product.deleteOne({ _id: product._id }, { session });
      await Inventory.deleteMany({ product: product._id }, { session });
      await BackInStockSubscription.deleteMany({ product: product._id }, { session });
      await mongoose.model('Cart').updateMany({ 'items.product': product._id }, { $pull: { items: { product: product._id } } }, { session });
      await mongoose.model('WishlistItem').deleteMany({ product: product._id }, { session });
      await mongoose.model('ProductQuestion').deleteMany({ product: product._id }, { session });
      const reviews = await mongoose.model('Review').find({ product: product._id }).select('_id').session(session).lean();
      if (reviews.length) {
        await mongoose.model('ReviewVote').deleteMany({ review: { $in: reviews.map((r) => r._id) } }, { session });
        await mongoose.model('Review').deleteMany({ product: product._id }, { session });
      }
      for (const name of ['Coupon', 'Campaign', 'Promotion']) {
        if (!mongoose.modelNames().includes(name)) continue;
        await mongoose.model(name).updateMany({ $or: [{ 'scope.products': product._id }, { 'scope.excludeProducts': product._id }] }, { $pull: { 'scope.products': product._id, 'scope.excludeProducts': product._id } }, { session });
      }
    });
  } finally {
    await session.endSession();
  }
  await audit.record({ req, action: 'product.delete', resource: { type: 'product', id: product._id }, metadata: { name: product.name, slug: product.slug, skus, status: product.status } });
  await invalidate();
  // Announce removal so open storefront pages and admin lists drop it straight away.
  syncProduct({ ...product, status: PRODUCT_STATUS.ARCHIVED }, { wasActive, oldSlug: product.slug });
  return { id: product._id, name: product.name, wasPublished: wasActive };
}

// ------------------------------------------------------------------ bulk

const BULK = {
  publish: { status: PRODUCT_STATUS.ACTIVE },
  unpublish: { status: PRODUCT_STATUS.INACTIVE },
  archive: { status: PRODUCT_STATUS.ARCHIVED },
  submit_for_review: { status: PRODUCT_STATUS.PENDING_REVIEW },
  feature: { set: { 'flags.featured': true } },
  unfeature: { set: { 'flags.featured': false } },
  mark_new: { set: { 'flags.newArrival': true } },
  unmark_new: { set: { 'flags.newArrival': false } },
  mark_bestseller: { set: { 'flags.bestseller': true } },
  unmark_bestseller: { set: { 'flags.bestseller': false } },
  assign_category: { category: true }, // params.categoryId
  adjust_stock: { stock: true }, // params.delta + params.reason, applied to every active SKU
  delete: { remove: true }, // permanent; super admins only
};

/** Applies one safe action to many products; each product is validated and reported separately. */
async function bulkAction(ids, action, req, params = {}) {
  const op = BULK[action];
  if (op.category) {
    if (!params.categoryId || !(await Category.exists({ _id: params.categoryId }))) throw badRequest('Choose an existing category to move the products to');
  }
  if (op.remove && req.auth.role !== ROLES.SUPER_ADMIN) throw forbidden('Only a super admin can permanently delete products', 'SUPER_ADMIN_ONLY');
  if (op.stock) {
    if (!req.auth.permissions?.includes(PERMISSIONS.INVENTORY_WRITE)) throw forbidden('Changing stock needs the inventory:write permission');
    if (!Number.isInteger(params.delta) || params.delta === 0 || !params.reason) throw badRequest('Stock changes need a non-zero quantity and a reason');
  }
  const results = [];
  for (const id of ids) {
    try {
      if (op.status) await setStatus(id, op.status, req);
      else if (op.remove) await deleteProductPermanently(id, req);
      else if (op.category) await updateProduct(id, { category: params.categoryId }, req);
      else if (op.stock) {
        const p = await Product.findById(id).select('type variants.sku variants.status').lean();
        if (!p) throw notFound('Product');
        if (p.type === 'bundle') throw badRequest('Bundles have no stock of their own; adjust their components');
        for (const v of p.variants.filter((x) => x.status !== 'inactive')) await inventory.adjust(v.sku, params.delta, params.reason, { type: 'staff', id: req.auth.userId });
      } else {
        const p = await Product.findByIdAndUpdate(id, { $set: { ...op.set, updatedBy: req.auth.userId } }, { new: true });
        if (!p) throw notFound('Product');
        syncProduct(p, { wasActive: p.status === PRODUCT_STATUS.ACTIVE });
      }
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, code: err.code || 'ERROR', message: err.expose ? err.message : 'Failed' });
    }
  }
  await audit.record({ req, action: 'product.bulk', resource: { type: 'product', id: 'bulk' }, metadata: { action, count: ids.length, ok: results.filter((r) => r.ok).length, ...(op.category ? { categoryId: params.categoryId } : {}), ...(op.stock ? { delta: params.delta, reason: params.reason } : {}) } });
  await invalidate();
  return results;
}

// ------------------------------------------------------------------ public reads

function stockStatus(available) {
  if (available <= 0) return 'out_of_stock';
  if (available <= LOW_STOCK_DISPLAY) return 'low_stock';
  return 'in_stock';
}

function cleanCare(care = {}) {
  const out = {};
  for (const k of ['foodSafe', 'dishwasherSafe', 'microwaveSafe', 'ovenSafe', 'freezerSafe']) if (typeof care[k] === 'boolean') out[k] = care[k];
  if (care.notes) out.notes = care.notes;
  return out;
}

/** Public shape: no cost prices, no supplier, unverified safety claims omitted, stock shown coarsely. */
function serializePublic(p, availability, { maxQty = 20 } = {}) {
  const variants = p.variants
    .filter((v) => v.status !== 'inactive')
    .map((v) => {
      const available = availability ? availability[v.sku] ?? 0 : undefined;
      return {
        id: v._id,
        sku: v.sku,
        title: v.title,
        attributes: v.attributes,
        mrp: v.mrp,
        price: v.price,
        discountPercent: v.mrp > v.price ? Math.floor(((v.mrp - v.price) * 100) / v.mrp) : 0,
        weightGrams: v.weightGrams,
        dimensions: v.dimensions,
        images: v.images,
        isDefault: v.isDefault,
        ...(availability
          ? { stockStatus: stockStatus(available), maxOrderQuantity: Math.min(available, maxQty), ...(available > 0 && available <= LOW_STOCK_DISPLAY ? { onlyLeft: available } : {}) }
          : {}),
      };
    });
  return {
    id: p._id,
    name: p.name,
    slug: p.slug,
    type: p.type,
    description: p.description,
    highlights: p.highlights,
    category: p.category,
    categoryPath: p.categoryPath,
    brand: p.brand,
    collections: p.collections,
    tags: p.tags,
    images: Product.publicImages(p.images),
    videos: [...(p.videos || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map(({ url, posterUrl, thumbUrl, durationSec, title }) => ({ url, posterUrl, thumbUrl, durationSec, title })),
    variants,
    bundleItems: p.type === 'bundle' ? p.bundleItems?.map((b) => ({ product: b.product, sku: b.sku, quantity: b.quantity, name: b.name })) : undefined,
    specs: p.specs,
    care: cleanCare(p.care),
    manufacturer: p.manufacturer,
    isFragile: p.isFragile,
    giftWrapAvailable: p.giftWrapAvailable,
    returnPolicy: p.returnPolicy,
    seo: p.seo,
    rating: p.rating,
    flags: p.flags,
    priceMin: p.priceMin,
    priceMax: p.priceMax,
    inStock: p.inStock,
  };
}

function listCard(p) {
  const def = p.variants.find((v) => v.isDefault) || p.variants[0];
  return {
    id: p._id,
    name: p.name,
    slug: p.slug,
    type: p.type,
    brand: p.brand,
    image: Product.publicImages(p.images)[0] || null,
    priceMin: p.priceMin,
    priceMax: p.priceMax,
    mrp: def?.mrp,
    price: def?.price,
    defaultSku: def?.sku,
    discountPercent: Math.floor((p.maxDiscountBps || 0) / 100),
    rating: { average: p.rating?.average, count: p.rating?.count },
    inStock: p.inStock,
    flags: p.flags,
    material: p.specs?.material,
    piecesPerSet: p.specs?.piecesPerSet,
    capacityMl: p.specs?.capacityMl,
  };
}

async function resolveCategory(ref) {
  if (!ref) return null;
  const cat = isObjectId(ref) ? await Category.findById(ref).select('_id').lean() : await Category.findOne({ slug: ref }).select('_id').lean();
  return cat?._id || 'none';
}
async function resolveCollection(ref) {
  if (!ref) return null;
  const c = isObjectId(ref) ? await Collection.findById(ref).select('_id').lean() : await Collection.findOne({ slug: ref }).select('_id').lean();
  return c?._id || 'none';
}

const SORTS = {
  price_asc: { priceMin: 1, _id: 1 },
  price_desc: { priceMax: -1, _id: 1 },
  newest: { publishedAt: -1, _id: 1 },
  popularity: { salesCount: -1, _id: 1 },
  rating: { 'rating.average': -1, 'rating.count': -1, _id: 1 },
  discount: { maxDiscountBps: -1, _id: 1 },
};

async function buildFilter(q, { includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { status: PRODUCT_STATUS.ACTIVE };
  const and = [];
  if (q.q) {
    if (q.q.length >= 3 || /\s/.test(q.q)) filter.$text = { $search: q.q };
    else {
      const rx = new RegExp(`^${escapeRegex(q.q)}`, 'i');
      and.push({ $or: [{ name: rx }, { brand: rx }, { 'variants.sku': rx }] });
    }
  }
  const cat = await resolveCategory(q.category);
  if (cat) filter.categoryPath = cat;
  const col = await resolveCollection(q.collection);
  if (col) filter.collections = col;
  if (q.brand?.length) filter.brand = { $in: q.brand.map((b) => new RegExp(`^${escapeRegex(b)}$`, 'i')) };
  if (q.material?.length) and.push({ $or: [{ 'specs.material': { $in: q.material } }, { 'specs.materials': { $in: q.material } }] });
  if (q.color?.length) and.push({ $or: [{ 'specs.color': { $in: q.color } }, { 'variants.attributes.color': { $in: q.color } }] });
  if (q.pattern?.length) and.push({ $or: [{ 'specs.pattern': { $in: q.pattern } }, { 'variants.attributes.pattern': { $in: q.pattern } }] });
  if (q.minPrice !== undefined || q.maxPrice !== undefined) {
    filter.priceMin = {};
    if (q.minPrice !== undefined) filter.priceMin.$gte = q.minPrice;
    if (q.maxPrice !== undefined) filter.priceMin.$lte = q.maxPrice;
  }
  if (q.minCapacityMl !== undefined || q.maxCapacityMl !== undefined) {
    const range = {};
    if (q.minCapacityMl !== undefined) range.$gte = q.minCapacityMl;
    if (q.maxCapacityMl !== undefined) range.$lte = q.maxCapacityMl;
    and.push({ $or: [{ 'specs.capacityMl': range }, { 'variants.attributes.capacityMl': range }] });
  }
  if (q.setSize) and.push({ $or: [{ 'specs.piecesPerSet': q.setSize }, { 'variants.attributes.setSize': q.setSize }] });
  if (q.minPieces) filter['specs.piecesPerSet'] = { $gte: q.minPieces };
  if (q.serves) filter['specs.serves'] = { $gte: q.serves };
  if (q.inStock === 'true') filter.inStock = true;
  if (q.inStock === 'false') filter.inStock = false;
  if (q.featured) filter['flags.featured'] = true;
  if (q.bestseller) filter['flags.bestseller'] = true;
  if (q.newArrival) filter['flags.newArrival'] = true;
  if (q.discounted) filter.maxDiscountBps = { $gt: 0 };
  if (q.microwaveSafe) filter['care.microwaveSafe'] = true;
  if (q.dishwasherSafe) filter['care.dishwasherSafe'] = true;
  if (q.giftWrap) filter.giftWrapAvailable = true;
  if (q.type) filter.type = q.type;
  if (and.length) filter.$and = and;
  return filter;
}

async function listProducts(q) {
  const key = crypto.createHash('sha1').update(JSON.stringify(q)).digest('hex');
  return cache.wrap(cache.NS.CATALOG, `list:${key}`, 60, async () => {
    const filter = await buildFilter(q);
    let sort = SORTS[q.sort];
    let projection = 'name slug type brand images priceMin priceMax maxDiscountBps variants.sku variants.mrp variants.price variants.isDefault rating inStock flags specs.material specs.piecesPerSet specs.capacityMl';
    let query;
    if (filter.$text && (!sort || q.sort === 'relevance')) {
      query = Product.find(filter, { score: { $meta: 'textScore' } }).sort({ score: { $meta: 'textScore' }, salesCount: -1 });
    } else {
      sort = sort || { 'flags.featured': -1, salesCount: -1, _id: 1 };
      query = Product.find(filter).sort(sort);
    }
    const [items, total] = await Promise.all([
      query.select(projection).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      Product.countDocuments(filter),
    ]);
    return { items: items.map(listCard), meta: pageMeta(q.page, q.limit, total) };
  });
}

async function getPublicProduct(slugOrId) {
  const cacheKey = `detail:${slugOrId}`;
  const product = await cache.wrap(cache.NS.CATALOG, cacheKey, 120, async () => {
    const filter = isObjectId(slugOrId) ? { _id: slugOrId } : { slug: String(slugOrId).toLowerCase() };
    return (await Product.findOne({ ...filter, status: PRODUCT_STATUS.ACTIVE }).select(Product.PUBLIC_PROJECTION).lean()) || null;
  });
  if (!product) throw notFound('Product');
  const [availability, settings] = await Promise.all([inventory.productAvailability(product), getSettings()]);
  return serializePublic(product, availability, { maxQty: settings.checkout.maxQuantityPerItem });
}

async function relatedProducts(slugOrId, limit = 8) {
  const filter = isObjectId(slugOrId) ? { _id: slugOrId } : { slug: slugOrId };
  const p = await Product.findOne(filter).select('category collections').lean();
  if (!p) throw notFound('Product');
  return cache.wrap(cache.NS.CATALOG, `related:${p._id}`, 300, async () => {
    const items = await Product.find({ _id: { $ne: p._id }, status: PRODUCT_STATUS.ACTIVE, inStock: true, $or: [{ category: p.category }, { collections: { $in: p.collections || [] } }] })
      .sort({ salesCount: -1 })
      .limit(limit)
      .select('name slug type brand images priceMin priceMax maxDiscountBps variants.sku variants.mrp variants.price variants.isDefault rating inStock flags specs')
      .lean();
    return items.map(listCard);
  });
}

/** Facet values for the filter sidebar, scoped to the current base filter. */
async function facets(q) {
  const key = crypto.createHash('sha1').update(JSON.stringify({ c: q.category, col: q.collection, q: q.q })).digest('hex');
  return cache.wrap(cache.NS.CATALOG, `facets:${key}`, 300, async () => {
    const filter = await buildFilter({ q: q.q, category: q.category, collection: q.collection });
    if (filter.$text) delete filter.$text; // $text cannot be used inside $facet; facets ignore the free-text term
    const [res] = await Product.aggregate([
      { $match: filter },
      {
        $facet: {
          brands: [{ $match: { brand: { $type: 'string' } } }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 30 }],
          materials: [{ $match: { 'specs.material': { $type: 'string' } } }, { $group: { _id: '$specs.material', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          colors: [{ $unwind: '$variants' }, { $match: { 'variants.attributes.color': { $type: 'string' } } }, { $group: { _id: '$variants.attributes.color', products: { $addToSet: '$_id' } } }, { $project: { count: { $size: '$products' } } }, { $sort: { count: -1 } }, { $limit: 30 }],
          setSizes: [{ $match: { 'specs.piecesPerSet': { $type: 'number' } } }, { $group: { _id: '$specs.piecesPerSet', count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
          price: [{ $group: { _id: null, min: { $min: '$priceMin' }, max: { $max: '$priceMax' } } }],
        },
      },
    ]);
    return {
      brands: res.brands.map((b) => ({ value: b._id, count: b.count })),
      materials: res.materials.map((b) => ({ value: b._id, count: b.count })),
      colors: res.colors.map((b) => ({ value: b._id, count: b.count })),
      setSizes: res.setSizes.map((b) => ({ value: b._id, count: b.count })),
      price: res.price[0] ? { min: res.price[0].min, max: res.price[0].max } : null,
    };
  });
}

module.exports = {
  deleteProductPermanently,
  computeDerived,
  assertPublishable,
  syncProduct,
  setImages,
  setVideos,
  stageReplacement,
  publishReplacement,
  cancelReplacement,
  rollbackImage,
  bulkAction,
  BULK_ACTIONS: Object.keys(BULK),
  createProduct,
  updateProduct,
  setStatus,
  serializePublic,
  listCard,
  buildFilter,
  listProducts,
  getPublicProduct,
  relatedProducts,
  facets,
  stockStatus,
  invalidate,
};
