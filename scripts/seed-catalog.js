'use strict';

/**
 * Catalog seed: the category hierarchy in scripts/catalog/taxonomy.js and exactly two products per
 * category from scripts/catalog/products.js, plus (optionally) verified Unsplash photos.
 *
 * Safe by design:
 *  - dry-run unless --apply; refuses NODE_ENV=production without --allow-production
 *  - additive only: never deletes, never overwrites an existing category or product
 *  - idempotent: categories are matched by slug, products by SKU (deterministic from the name)
 *  - resumable: every record is independent, so a rerun continues where a failure stopped
 *  - products are created as drafts through the product service (same validation as the admin API);
 *    imported photos enter media review as pending and are never auto-approved or published
 *
 *   node scripts/seed-catalog.js                 # dry-run: show what would change
 *   node scripts/seed-catalog.js --apply         # create missing categories and products
 *   node scripts/seed-catalog.js --apply --images [--wait]   # also import photos (UNSPLASH_ACCESS_KEY)
 *   node scripts/seed-catalog.js --audit         # read-only verification report
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bootstrap, arg, done } = require('./lib');
const { flatten } = require('./catalog/taxonomy');
const { PRODUCTS } = require('./catalog/products');

const OPENING_STOCK_REASON = 'catalog seed opening stock';
const REPORT_PATH = path.join(__dirname, '..', 'logs', 'catalog-seed-report.json');
const CACHE_PATH = path.join(__dirname, 'catalog', '.unsplash-cache.json');
const BLOCKED_WORDS = /\b(woman|women|man|men|girl|boy|person|people|model|fashion|shoe|shoes|dress|clothing|portrait|selfie|face|wearing|lingerie|bikini)\b/i;

const hash6 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6).toUpperCase();
const rupees = (n) => Math.round(n * 100);

function skuFor(cat, product) {
  return `AT-${cat.code}-${hash6(product.n)}`;
}

/** Product payload in the shape the admin API accepts (validated with the same zod schema). */
function buildProduct(cat, p, categoryId, { featured }) {
  const { slugify } = require('../src/utils/common');
  const fragile = !['fabric', 'stainless_steel', 'wood', 'bamboo', 'brass', 'acrylic', 'other'].includes(p.m);
  const glass = /glass/.test(p.m);
  const highlights = [
    p.pcs > 1 ? `${p.pcs}-piece set${p.sv ? ` · serves ${p.sv}` : ''}` : null,
    p.ml ? `${p.ml} ml capacity` : null,
    `${p.f.charAt(0).toUpperCase()}${p.f.slice(1)} ${p.c} finish`,
    p.ds ? `Design: ${p.ds}` : null,
  ].filter(Boolean);
  const composition = p.comp?.map(([item, count]) => `${count} × ${item}`).join(', ');
  const description = [
    p.b,
    composition ? `In the set: ${composition}.` : null,
    'Care, heat and food-contact guidance is provided with the product; please follow the care card supplied.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const sku = skuFor(cat, p);
  const keywords = [...new Set([cat.name.toLowerCase(), p.c, p.m.replace(/_/g, ' '), ...(p.q || '').split(' ')])].filter((k) => k && k.length <= 40).slice(0, 10);
  return {
    name: p.n,
    slug: slugify(p.n).slice(0, 120),
    type: 'simple',
    description,
    highlights,
    category: String(categoryId),
    brand: 'Decor Dice',
    tags: [...new Set([cat.slug, cat.rootSlug, p.m.replace(/_/g, '-'), ...p.c.split(/\s+and\s+|\s+/).filter((w) => w.length > 2)])].map((t) => t.toLowerCase().slice(0, 40)).slice(0, 12),
    variants: [
      {
        sku,
        title: p.pcs > 1 ? `Set of ${p.pcs}` : 'Standard',
        attributes: { color: p.c.slice(0, 40), ...(p.pa ? { pattern: p.pa } : {}), ...(p.ml ? { capacityMl: p.ml } : {}), ...(p.pcs ? { setSize: p.pcs } : {}) },
        mrp: rupees(p.mrp),
        price: rupees(p.p),
        isDefault: true,
      },
    ],
    specs: {
      material: p.m,
      ...(p.ms ? { materials: p.ms } : {}),
      color: p.c.slice(0, 40),
      ...(p.pa ? { pattern: p.pa } : {}),
      finish: p.f,
      ...(p.ds ? { design: p.ds } : {}),
      ...(p.ml ? { capacityMl: p.ml } : {}),
      ...(p.dim ? { dimensions: p.dim } : {}),
      ...(p.pcs ? { piecesPerSet: p.pcs } : {}),
      ...(p.sv ? { serves: p.sv } : {}),
      ...(p.comp ? { setComposition: p.comp.map(([item, count]) => ({ item, count })) } : {}),
    },
    // Safety attributes stay unknown (null) until verified with the supplier; unknowns are never shown.
    care: { foodSafe: null, dishwasherSafe: null, microwaveSafe: null, ovenSafe: null, freezerSafe: null },
    // The schema defaults the origin to India; it is not verified, so it is left blank (hidden).
    manufacturer: { countryOfOrigin: '' },
    isFragile: fragile,
    packaging: { requirements: fragile ? ['fragile_label', 'bubble_wrap', 'multi_layer_box', ...(glass ? ['separate_glass_packing'] : [])] : ['protective_wrapping'] },
    seo: {
      title: `${p.n}`.slice(0, 70),
      description: p.b.slice(0, 170),
      keywords,
    },
    flags: { featured, newArrival: false, bestseller: false },
    status: 'draft',
  };
}

function plan() {
  const cats = flatten();
  const problems = [];
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  if (bySlug.size !== cats.length) problems.push('duplicate category slugs in taxonomy');
  for (const c of cats) {
    const list = PRODUCTS[c.slug];
    if (!list) problems.push(`no products defined for ${c.slug}`);
    else if (list.length !== 2) problems.push(`${c.slug} has ${list.length} products (expected 2)`);
  }
  for (const slug of Object.keys(PRODUCTS)) if (!bySlug.has(slug)) problems.push(`products defined for unknown category ${slug}`);
  const items = cats.flatMap((c) => (PRODUCTS[c.slug] || []).map((p, i) => ({ cat: c, p, sku: skuFor(c, p), featured: c.level === 0 && i === 0 })));
  const skus = new Set(items.map((x) => x.sku));
  if (skus.size !== items.length) problems.push('SKU collision in seed data');
  const names = new Set(items.map((x) => x.p.n.toLowerCase()));
  if (names.size !== items.length) problems.push('duplicate product names in seed data');
  return { cats, items, problems };
}

function redactUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

// ------------------------------------------------------------------ images

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function score(photo, cat, p) {
  const text = `${photo.description} ${photo.tags.join(' ')}`.toLowerCase();
  if (BLOCKED_WORDS.test(text)) return -1;
  if (Math.min(photo.width, photo.height) < 1200) return -1;
  let s = 0;
  for (const k of cat.keywords) if (text.includes(k)) s += 2;
  for (const w of p.q.split(' ')) if (w.length > 2 && text.includes(w)) s += 3;
  if (text.includes(p.c.split(' ')[0])) s += 1;
  return s;
}

async function importImages({ items, apply, wait, req, report }) {
  const unsplash = require('../src/services/unsplash');
  const media = require('../src/modules/media/media.service');
  const productService = require('../src/modules/products/product.service');
  const Product = require('../src/modules/products/product.model');
  const { Upload } = require('../src/modules/media/media.model');
  if (!unsplash.isConfigured()) {
    report.images.blocked = 'UNSPLASH_ACCESS_KEY is not set — no photos were searched, verified or attached';
    return;
  }
  const cache = loadCache();
  const used = new Set((await Upload.find({ 'source.provider': 'unsplash' }).select('source.photoId').lean()).map((u) => u.source.photoId));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const searchCached = async (q) => {
    if (cache[q]) return cache[q];
    for (;;) {
      try {
        cache[q] = await unsplash.search(q, { perPage: 30 });
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
        return cache[q];
      } catch (err) {
        if (!err.rateLimited || !wait) throw err;
        console.log('  Unsplash rate limit reached; waiting 10 minutes…');
        await sleep(600000);
      }
    }
  };

  for (const { cat, p, sku } of items) {
    const product = await Product.findOne({ 'variants.sku': sku }).select('_id images name updatedAt').lean();
    if (!product) continue;
    if (product.images?.length) {
      report.images.skippedHasImages++;
      continue;
    }
    try {
      let candidates = await searchCached(p.q);
      let ranked = candidates.filter((x) => !used.has(x.id)).map((x) => ({ x, s: score(x, cat, p) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s);
      if (!ranked.length) {
        candidates = await searchCached(`${cat.name} ${p.m.replace(/_/g, ' ')}`);
        ranked = candidates.filter((x) => !used.has(x.id)).map((x) => ({ x, s: score(x, cat, p) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s);
      }
      let chosen = null;
      let verification = null;
      for (const { x } of ranked.slice(0, 5)) {
        verification = await unsplash.verify(x.rawUrl);
        if (verification.ok) {
          chosen = x;
          break;
        }
        report.images.broken.push({ sku, photoId: x.id, reason: verification.reason });
      }
      if (!chosen) {
        report.images.unmatched.push({ sku, name: p.n, query: p.q });
        continue;
      }
      used.add(chosen.id);
      report.images.verified++;
      if (!apply) continue;
      const { upload, created } = await media.registerUnsplashImage({ photo: chosen, verification, ownerId: req.auth.userId, target: { type: 'product', id: String(product._id) }, query: p.q, alt: p.n });
      if (created) {
        await unsplash.trackDownload(chosen.downloadLocation).then(
          () => Upload.updateOne({ _id: upload._id }, { $set: { 'source.downloadTrackedAt': new Date() } }),
          (err) => report.images.trackingFailed.push({ photoId: chosen.id, reason: err.message }),
        );
      }
      await productService.setImages(String(product._id), [{ media: String(upload._id), alt: p.n.slice(0, 160) }], req, { expectedUpdatedAt: product.updatedAt });
      report.images.attachedPending++;
    } catch (err) {
      if (err.rateLimited) {
        report.images.stoppedEarly = 'Unsplash rate limit reached; rerun later (progress is kept)';
        break;
      }
      report.images.failed.push({ sku, reason: err.message });
    }
  }
}

// ------------------------------------------------------------------ audit

async function audit() {
  const Category = require('../src/modules/categories/category.model');
  const Product = require('../src/modules/products/product.model');
  const { Upload } = require('../src/modules/media/media.model');
  const Inventory = require('mongoose').model('Inventory');
  const { cats, items } = plan();
  const dbCats = await Category.find({ slug: { $in: cats.map((c) => c.slug) } }).lean();
  const catBySlug = new Map(dbCats.map((c) => [c.slug, c]));
  const products = await Product.find({ 'variants.sku': { $in: items.map((i) => i.sku) } }).lean();
  const direct = await Product.aggregate([{ $match: { category: { $in: dbCats.map((c) => c._id) } } }, { $group: { _id: '$category', n: { $sum: 1 } } }]);
  const directById = new Map(direct.map((d) => [String(d._id), d.n]));
  const perCategory = cats.map((c) => {
    const db = catBySlug.get(c.slug);
    const parentOk = db ? (c.parentSlug ? String(db.parent) === String(catBySlug.get(c.parentSlug)?._id) : !db.parent) : false;
    return { slug: c.slug, level: c.level, exists: Boolean(db), parentOk, expected: 2, direct: db ? directById.get(String(db._id)) || 0 : 0 };
  });
  const badPaths = products.filter((p) => {
    const c = dbCats.find((x) => String(x._id) === String(p.category));
    return !c || String([...c.ancestors, c._id]) !== String(p.categoryPath);
  });
  const mediaIds = products.flatMap((p) => p.images.map((i) => i.media)).filter(Boolean);
  const uploads = await Upload.find({ _id: { $in: mediaIds } }).select('review.status source.verifiedAt').lean();
  const stock = await Inventory.find({ sku: { $in: items.map((i) => i.sku) } }).select('sku onHand').lean();
  const allProducts = await Product.countDocuments();
  const dupSlugs = await Product.aggregate([{ $group: { _id: '$slug', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  const dupCatSlugs = await Category.aggregate([{ $group: { _id: '$slug', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  return {
    parents: perCategory.filter((c) => c.level === 0 && c.exists).length,
    subcategories: perCategory.filter((c) => c.level === 1 && c.exists).length,
    categoriesTotal: perCategory.filter((c) => c.exists).length,
    categoriesWithWrongParent: perCategory.filter((c) => c.exists && !c.parentOk).map((c) => c.slug),
    categoriesNotExactlyTwo: perCategory.filter((c) => c.direct !== 2).map((c) => `${c.slug}: ${c.direct}`),
    expectedProducts: items.length,
    seededProductsFound: products.length,
    productsInDatabase: allProducts,
    productsWithInvalidCategoryPath: badPaths.map((p) => p.slug),
    byStatus: products.reduce((a, p) => ({ ...a, [p.status]: (a[p.status] || 0) + 1 }), {}),
    productsWithImages: products.filter((p) => p.images.length).length,
    productsWithoutImages: products.filter((p) => !p.images.length).length,
    imagesPendingReview: uploads.filter((u) => u.review?.status === 'pending_review').length,
    imagesApproved: uploads.filter((u) => u.review?.status === 'approved').length,
    imagesVerified: uploads.filter((u) => u.source?.verifiedAt).length,
    skusWithStock: stock.filter((s) => s.onHand > 0).length,
    duplicateProductSlugs: dupSlugs.length,
    duplicateCategorySlugs: dupCatSlugs.length,
    perCategory,
  };
}

// ------------------------------------------------------------------ main

async function main() {
  const apply = Boolean(arg('apply'));
  const env = await bootstrap();
  console.log(`Target database: ${redactUri(env.MONGODB_URI)} (NODE_ENV=${env.NODE_ENV})`);
  if (env.isProd && !arg('allow-production')) {
    console.error('Refusing to seed a production environment without --allow-production.');
    return done(1);
  }

  if (arg('audit')) {
    const r = await audit();
    const { perCategory, ...summary } = r;
    console.log(JSON.stringify(summary, null, 2));
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH.replace('.json', '-audit.json'), JSON.stringify(r, null, 2));
    return done(0);
  }

  const { cats, items, problems } = plan();
  if (problems.length) {
    console.error('Seed data is invalid:\n - ' + problems.join('\n - '));
    return done(1);
  }
  console.log(`Plan: ${cats.filter((c) => !c.parentSlug).length} parent categories, ${cats.filter((c) => c.parentSlug).length} sub-categories, ${items.length} products${apply ? '' : ' (DRY RUN — nothing is written)'}`);

  const Category = require('../src/modules/categories/category.model');
  const Product = require('../src/modules/products/product.model');
  const User = require('../src/modules/users/user.model');
  const productService = require('../src/modules/products/product.service');
  const { createProduct: createSchema } = require('../src/modules/products/product.schemas');
  const inventory = require('../src/modules/inventory/inventory.service');
  const cache = require('../src/services/cache');
  const sync = require('../src/services/sync');
  const { permissionsFor } = require('../src/constants/roles');
  const InventoryMovement = require('mongoose').model('InventoryMovement');

  const admin = await User.findOne({ role: 'super_admin' }).select('_id email').lean();
  if (!admin) {
    console.error('No super_admin user exists to own the seeded records. Run `npm run create-admin` first.');
    return done(1);
  }
  const req = { auth: { userId: admin._id, role: 'super_admin', isStaff: true, permissions: permissionsFor('super_admin') }, ip: '127.0.0.1', headers: { 'user-agent': 'seed-catalog' }, get: () => 'seed-catalog' };

  const report = {
    startedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    categories: { created: [], reused: [], manualReview: [] },
    products: { created: [], reused: [], manualReview: [], failed: [] },
    stock: { set: 0, skipped: 0, failed: [] },
    images: { verified: 0, attachedPending: 0, skippedHasImages: 0, broken: [], unmatched: [], failed: [], trackingFailed: [] },
  };

  // Categories: parents first, so children can resolve their parent.
  const catBySlug = new Map((await Category.find({ slug: { $in: cats.map((c) => c.slug) } }).lean()).map((c) => [c.slug, c]));
  for (const c of cats) {
    const parent = c.parentSlug ? catBySlug.get(c.parentSlug) : null;
    const existing = catBySlug.get(c.slug);
    if (existing) {
      const parentMatches = c.parentSlug ? parent && String(existing.parent) === String(parent._id) : !existing.parent;
      (parentMatches ? report.categories.reused : report.categories.manualReview).push(parentMatches ? c.slug : `${c.slug} (exists under a different parent — left unchanged)`);
      continue;
    }
    if (c.parentSlug && !parent) {
      report.categories.manualReview.push(`${c.slug} (parent ${c.parentSlug} missing)`);
      continue;
    }
    report.categories.created.push(c.slug);
    if (!apply) {
      catBySlug.set(c.slug, { _id: `dry:${c.slug}`, slug: c.slug, ancestors: parent ? [...(parent.ancestors || []), parent._id] : [], parent: parent?._id || null });
      continue;
    }
    const doc = await Category.create({
      name: c.name,
      slug: c.slug,
      parent: parent?._id || null,
      ancestors: parent ? [...parent.ancestors, parent._id] : [],
      level: parent ? parent.level + 1 : 0,
      description: c.description,
      sortOrder: c.sortOrder,
      isActive: true,
      seo: { title: `${c.name} | Decor Dice`.slice(0, 70), description: c.description.slice(0, 170) },
    });
    catBySlug.set(c.slug, doc.toObject());
  }
  if (apply && report.categories.created.length) {
    await cache.bump(cache.NS.CATEGORIES, cache.NS.CATALOG);
    sync.changed({ tags: [sync.TAGS.CATEGORIES, sync.TAGS.CATALOG], events: [{ event: sync.EVENTS.CATEGORY_UPDATED }] });
  }

  // Products: matched by SKU; a slug taken by a different product is left for manual review.
  for (const { cat, p, sku, featured } of items) {
    const category = catBySlug.get(cat.slug);
    try {
      const bySku = await Product.findOne({ 'variants.sku': sku }).select('_id slug').lean();
      if (bySku) {
        report.products.reused.push(sku);
        continue;
      }
      const data = buildProduct(cat, p, category._id, { featured });
      const slugOwner = await Product.findOne({ slug: data.slug }).select('_id').lean();
      if (slugOwner) {
        report.products.manualReview.push(`${sku} (slug ${data.slug} already used by another product)`);
        continue;
      }
      if (!apply) {
        createSchema.parse({ ...data, category: '0'.repeat(24) });
        report.products.created.push(sku);
        continue;
      }
      const product = await productService.createProduct(createSchema.parse(data), req);
      report.products.created.push(sku);
      const stockQty = 12 + (parseInt(hash6(sku), 16) % 29);
      try {
        if (!(await InventoryMovement.exists({ sku, reason: OPENING_STOCK_REASON }))) {
          await inventory.adjust(product.variants[0].sku, stockQty, OPENING_STOCK_REASON, { type: 'system', id: admin._id });
          report.stock.set++;
        } else report.stock.skipped++;
      } catch (err) {
        report.stock.failed.push({ sku, reason: err.message });
      }
    } catch (err) {
      report.products.failed.push({ sku, name: p.n, reason: err.issues ? JSON.stringify(err.issues).slice(0, 300) : err.message });
    }
  }

  // Stock refreshes are normally queued for the worker; a script has none, so derive inStock directly.
  if (apply) await inventory.refreshStock({ skus: items.map((i) => i.sku) });

  if (arg('images')) await importImages({ items, apply, wait: Boolean(arg('wait')), req, report });

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(apply ? REPORT_PATH : REPORT_PATH.replace('.json', '-dryrun.json'), JSON.stringify(report, null, 2));
  const n = (a) => (Array.isArray(a) ? a.length : a);
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        categories: { created: n(report.categories.created), reused: n(report.categories.reused), manualReview: report.categories.manualReview },
        products: { created: n(report.products.created), reused: n(report.products.reused), manualReview: report.products.manualReview, failed: report.products.failed },
        stock: { set: report.stock.set, skipped: report.stock.skipped, failed: report.stock.failed },
        images: { ...report.images, broken: n(report.images.broken), unmatched: report.images.unmatched.length, failed: report.images.failed },
      },
      null,
      2,
    ),
  );
  return done(report.products.failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    done(1);
  });
}

module.exports = { plan, buildProduct, skuFor, score };
