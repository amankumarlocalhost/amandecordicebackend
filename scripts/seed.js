'use strict';

/**
 * Additive, idempotent seed: categories by slug, products by SKU, collections by slug, a sample
 * Diwali campaign (inactive) and a first-order coupon (inactive). Never deletes anything.
 *
 *   npm run seed                       # development
 *   npm run seed -- --with-stock       # also set opening stock for new SKUs
 *   NODE_ENV=production npm run seed -- --allow-production   # explicit opt-in
 */
const { bootstrap, arg, done } = require('./lib');
const { CATEGORY_TREE, PRODUCTS, BUNDLES, COLLECTIONS, img } = require('./seed-data');
const { slugify } = require('../src/utils/common');

async function runSeed({ withStock = Boolean(arg('with-stock')) } = {}) {
  const Category = require('../src/modules/categories/category.model');
  const Collection = require('../src/modules/collections/collection.model');
  const Product = require('../src/modules/products/product.model');
  const User = require('../src/modules/users/user.model');
  const productService = require('../src/modules/products/product.service');
  const inventory = require('../src/modules/inventory/inventory.service');
  const { Campaign, Coupon } = require('../src/modules/promotions/promotion.models');
  const { permissionsFor } = require('../src/constants/roles');

  let systemUser = await User.findOne({ role: 'super_admin' }).select('_id').lean();
  if (!systemUser) systemUser = { _id: undefined };
  const req = { auth: { userId: systemUser._id, role: 'super_admin', isStaff: true, permissions: permissionsFor('super_admin') } };

  const catBySlug = {};
  for (const [i, root] of CATEGORY_TREE.entries()) {
    const parent = await Category.findOneAndUpdate({ slug: root.slug }, { $setOnInsert: { name: root.name, slug: root.slug, parent: null, ancestors: [], level: 0, sortOrder: i } }, { upsert: true, new: true });
    catBySlug[parent.slug] = parent;
    for (const [j, name] of root.children.entries()) {
      const slug = slugify(name);
      const child = await Category.findOneAndUpdate({ slug }, { $setOnInsert: { name, slug, parent: parent._id, ancestors: [parent._id], level: 1, sortOrder: j } }, { upsert: true, new: true });
      catBySlug[slug] = child;
    }
  }
  console.log(`categories: ${Object.keys(catBySlug).length}`);

  let created = 0;
  for (const p of PRODUCTS) {
    const sku = p.variants[0].sku;
    if (await Product.exists({ 'variants.sku': sku })) continue;
    const { category, stock, ...data } = p;
    const product = await productService.createProduct({ ...data, category: String(catBySlug[category]._id), images: img(slugify(p.name)), status: 'active' }, req);
    created++;
    if (withStock && stock) for (const v of product.variants) await inventory.adjust(v.sku, stock, 'seed opening stock', { type: 'system' });
  }
  for (const b of BUNDLES) {
    if (await Product.exists({ 'variants.sku': b.variants[0].sku })) continue;
    const items = [];
    for (const bi of b.bundleItems) {
      const comp = await Product.findOne({ 'variants.sku': bi.sku }).select('_id').lean();
      items.push({ product: String(comp._id), sku: bi.sku, quantity: bi.quantity });
    }
    const { category, ...data } = b;
    await productService.createProduct({ ...data, bundleItems: items, category: String(catBySlug[category]._id), images: img(slugify(b.name)), status: 'active' }, req);
    created++;
  }
  console.log(`products created: ${created}`);

  for (const c of COLLECTIONS) {
    const col = await Collection.findOneAndUpdate({ slug: c.slug }, { $setOnInsert: { name: c.name, slug: c.slug, type: c.type, isActive: true } }, { upsert: true, new: true });
    await Product.updateMany({ 'variants.sku': { $in: c.skus } }, { $addToSet: { collections: col._id } });
  }

  const year = new Date().getFullYear();
  await Campaign.updateOne(
    { slug: `diwali-crockery-sale-${year}` },
    { $setOnInsert: { name: `Diwali Crockery Sale ${year}`, slug: `diwali-crockery-sale-${year}`, festival: 'diwali', description: 'Festive offers on dinner sets and glassware', startsAt: new Date(`${year}-10-25T00:00:00+05:30`), endsAt: new Date(`${year}-11-05T23:59:59+05:30`), timezone: 'Asia/Kolkata', isActive: false } },
    { upsert: true },
  );
  await Coupon.updateOne(
    { code: 'FIRSTORDER10' },
    { $setOnInsert: { code: 'FIRSTORDER10', description: '10% off your first order (max ₹500)', discountType: 'percentage', value: 1000, maxDiscount: 50000, minCartValue: 99900, firstOrderOnly: true, perCustomerLimit: 1, startsAt: new Date(), endsAt: new Date(Date.now() + 365 * 86400000), isActive: false, isPublic: true } },
    { upsert: true },
  );
  const cache = require('../src/services/cache');
  await cache.bump(cache.NS.CATALOG, cache.NS.CATEGORIES, cache.NS.PROMOTIONS);
  console.log('seed complete (campaign and coupon are inactive until you activate them)');
}

async function main() {
  const env = await bootstrap();
  if (env.isProd && !arg('allow-production')) throw new Error('Refusing to seed production without --allow-production');
  await runSeed();
}

if (require.main === module) {
  main()
    .then(() => done(0))
    .catch((err) => {
      console.error(err.message);
      done(1);
    });
}

module.exports = { runSeed };
