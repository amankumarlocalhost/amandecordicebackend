'use strict';

/**
 * Home décor catalog seed: 10 parent categories, 73 sub-categories, 146 products (two per
 * sub-category) and six "Shop by Space" collections, plus verified Unsplash photography.
 *
 * Safe by design (same guarantees as scripts/seed-catalog.js, which it sits beside):
 *  - dry-run unless --apply; refuses NODE_ENV=production without --allow-production
 *  - additive only: never deletes or resets anything; existing categories, products, users, orders
 *    and payments are not modified (the crockery catalog stays exactly as it is)
 *  - idempotent: categories and collections are matched by slug, products by SKU (deterministic
 *    from the product name), photos by Unsplash photo id — rerunning never creates duplicates
 *  - each parent category and its sub-categories are written in one MongoDB transaction
 *  - products are created through the product service (the admin API's validation and slug rules)
 *    as drafts; photos enter media review as pending and are never auto-approved
 *
 *   node src/scripts/seedHomeDecorCatalog.js                    # dry-run report
 *   node src/scripts/seedHomeDecorCatalog.js --apply            # create categories, spaces, products, stock
 *   node src/scripts/seedHomeDecorCatalog.js --apply --images [--wait] [--per-product 2]
 *                                                             # import verified Unsplash photos (needs UNSPLASH_ACCESS_KEY)
 *   node src/scripts/seedHomeDecorCatalog.js --apply --attach   # after review: put approved photos on categories/spaces
 *   node src/scripts/seedHomeDecorCatalog.js --apply --publish  # publish décor drafts that have an approved photo
 *   node src/scripts/seedHomeDecorCatalog.js --audit            # read-only verification report
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bootstrap, arg, done } = require('../../scripts/lib');
const { flattenDecor, SPACES } = require('./catalog/homeDecorTaxonomy');
const { PRODUCTS } = require('./catalog/homeDecorProducts');

const BRAND = 'Decor Dice';
const OPENING_STOCK_REASON = 'home decor seed opening stock';
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const REPORT_PATH = path.join(LOG_DIR, 'home-decor-seed-report.json');
const CACHE_PATH = path.join(__dirname, 'catalog', '.unsplash-decor-cache.json');
// Photos showing people or fashion are never used for décor products.
const BLOCKED_WORDS = /\b(woman|women|man|men|girl|boy|person|people|model|fashion|shoe|shoes|dress|clothing|portrait|selfie|face|wearing|lingerie|bikini|food|pizza|burger|meat)\b/i;
const CARE_BY_MATERIAL = {
  ceramic: 'Wipe with a soft damp cloth; avoid abrasive cleaners to protect the glaze.',
  stoneware: 'Wipe with a soft damp cloth. Glazes are applied by hand, so slight variations are part of the piece.',
  terracotta: 'Natural clay is porous: dust regularly and keep a saucer beneath if used with plants.',
  glass: 'Clean with a lint-free cloth and mild soapy water. Handle with care.',
  crystal_glass: 'Hand-wash with mild soap and dry immediately with a lint-free cloth.',
  brass: 'Dust with a dry cloth. To restore shine, use a brass polish sparingly; brass naturally develops a patina over time.',
  copper: 'Dust with a dry cloth; copper develops a warm patina outdoors.',
  metal: 'Dust with a dry, soft cloth. Avoid moisture and abrasive cleaners.',
  iron: 'Dust with a dry cloth. Keep indoor pieces away from moisture to protect the finish.',
  aluminium: 'Wipe with a soft dry cloth.',
  wood: 'Dust with a dry cloth. Keep away from direct sunlight and moisture; wood grain and tone vary naturally.',
  bamboo: 'Wipe clean with a damp cloth and dry thoroughly.',
  mdf: 'Wipe with a soft dry cloth; keep away from water.',
  marble: 'Wipe with a soft damp cloth; avoid acidic cleaners. Natural veining makes every piece unique.',
  concrete: 'Wipe with a damp cloth. Small pits and colour variations are natural to cast concrete.',
  rattan: 'Dust with a soft brush; keep dry and away from direct heat.',
  jute: 'Shake or brush off dust; spot-clean only and keep dry.',
  fabric: 'Spot-clean or gently hand-wash in cold water; dry flat in shade.',
  acrylic: 'Clean with a microfibre cloth; avoid alcohol-based cleaners.',
  resin: 'Dust with a soft dry cloth.',
  other: 'Dust with a soft, dry cloth.',
};
const STYLE_BY_ROOT = {
  kitchen: 'Pair it with natural wood and linen for a warm, lived-in kitchen.',
  gardening: 'Group pots of different heights and textures for a layered, natural look.',
  'wall-hanging': 'Hang at eye level — around 145 cm to the centre — or above a console for a focal point.',
  'table-decor': 'Style in odd numbers and vary heights for a balanced tablescape.',
  'wall-decor': 'Leave a hand-span of space between pieces when grouping on a wall.',
  glass: 'Place near a window or lamp so light can pass through the glass.',
  vases: 'Fill with fresh blooms, dried stems or leave it empty as a sculptural accent.',
  'photo-frames': 'Mix frame sizes on a shelf or build a gallery wall around a central piece.',
  'candle-stand': 'Never leave a burning candle unattended; keep away from curtains and drafts.',
  'key-holder': 'Mount near the door at about 120–150 cm so keys are always within reach.',
};
const FRAGILE = new Set(['ceramic', 'stoneware', 'terracotta', 'glass', 'crystal_glass', 'marble', 'concrete', 'resin', 'acrylic']);

const hash6 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6).toUpperCase();
const rupees = (n) => Math.round(n * 100);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const label = (m) => m.replace(/_/g, ' ');

/** "30x10x8" → l/w/h, "d12x30" → diameter/height (centimetres → millimetres). */
function parseDims(s) {
  if (!s) return undefined;
  const mm = (n) => Math.round(Number(n) * 10);
  const round = /^d(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(s);
  if (round) return { diameterMm: mm(round[1]), heightMm: mm(round[2]) };
  const box = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(s);
  if (box) return { lengthMm: mm(box[1]), widthMm: mm(box[2]), heightMm: mm(box[3]) };
  throw new Error(`Unparseable dimensions "${s}"`);
}
function dimsText(d) {
  const cm = (x) => `${+(x / 10).toFixed(1)}`;
  return d.diameterMm ? `Ø ${cm(d.diameterMm)} × H ${cm(d.heightMm)} cm` : `${cm(d.lengthMm)} × ${cm(d.widthMm)} × ${cm(d.heightMm)} cm (L × W × H)`;
}

/** Expands a product row into a named object. */
function rowToProduct(row) {
  const [n, m, c, f, dim, w, mrp, p, b, q, opts = {}] = row;
  return { n, m, c, f, dim, w, mrp, p, b, q, ...opts };
}

function skuFor(cat, p) {
  return `DD-${cat.code}-${hash6(p.n)}`;
}

/** Deterministic merchandising flags, spread evenly over the catalog. */
function flagsFor(index) {
  return { featured: index % 7 === 0, bestseller: index % 5 === 1, newArrival: index % 6 === 2 };
}

/** Product payload in the shape the admin API accepts (validated with the same zod schema). */
function buildProduct(cat, p, { categoryId, collectionIds, index }) {
  const { slugify } = require('../utils/common');
  const dims = parseDims(p.dim);
  const baseSku = skuFor(cat, p);
  const short = p.b.split(/(?<=\.)\s/)[0];
  const description = [
    p.b,
    `Crafted in ${label(p.m)}${p.ms?.length ? ` with ${p.ms.map(label).join(' and ')} details` : ''}, finished in ${p.c} with a ${p.f} surface. It measures ${dimsText(dims)}${p.w ? ` and weighs approximately ${p.w >= 1000 ? `${+(p.w / 1000).toFixed(1)} kg` : `${p.w} g`}` : ''}${p.pcs > 1 ? `, sold as a set of ${p.pcs}` : ''}.`,
    STYLE_BY_ROOT[cat.rootSlug],
    `Care: ${CARE_BY_MATERIAL[p.m] || CARE_BY_MATERIAL.other}`,
  ].join('\n\n');
  const highlights = [
    `${cap(label(p.m))}${p.ms?.length ? ` & ${p.ms.map(label).join(', ')}` : ''} · ${p.f} finish`,
    `Colour: ${p.c}`,
    `Size: ${dimsText(dims)}`,
    p.pcs > 1 ? `Set of ${p.pcs}` : null,
    `Curated for ${cat.rootName.toLowerCase()} — ${cat.name.toLowerCase()}`,
  ].filter(Boolean);
  const variants = p.v?.length
    ? p.v.map(([title, mrp, price, size], i) => ({
        sku: `${baseSku}-${String(size).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8)}`,
        title,
        attributes: { color: p.c.slice(0, 40), size: String(size).slice(0, 40), ...(p.pcs ? { setSize: p.pcs } : {}) },
        mrp: rupees(mrp),
        price: rupees(price),
        ...(p.w ? { weightGrams: p.w } : {}),
        dimensions: dims,
        isDefault: i === 0,
      }))
    : [{ sku: baseSku, title: p.pcs > 1 ? `Set of ${p.pcs}` : 'Standard', attributes: { color: p.c.slice(0, 40), ...(p.pcs ? { setSize: p.pcs } : {}) }, mrp: rupees(p.mrp), price: rupees(p.p), ...(p.w ? { weightGrams: p.w } : {}), dimensions: dims, isDefault: true }];
  const keywords = [...new Set([p.n.toLowerCase(), cat.name.toLowerCase(), cat.rootName.toLowerCase(), label(p.m), p.c, 'home decor'])].filter((k) => k.length <= 40).slice(0, 10);
  const fragile = FRAGILE.has(p.m);
  return {
    name: p.n,
    slug: slugify(p.n).slice(0, 120),
    type: 'simple',
    description,
    highlights,
    category: String(categoryId),
    collections: collectionIds.map(String),
    brand: BRAND,
    tags: [...new Set(['home-decor', cat.rootSlug, cat.slug.slice(0, 40), p.m.replace(/_/g, '-'), ...p.c.split(/\s+and\s+|\s+/).filter((x) => x.length > 2)])].map((t) => t.toLowerCase().slice(0, 40)).slice(0, 12),
    variants,
    specs: {
      material: p.m,
      ...(p.ms?.length ? { materials: p.ms } : {}),
      color: p.c.slice(0, 40),
      finish: p.f,
      dimensions: dims,
      ...(p.w ? { weightGrams: p.w } : {}),
      ...(p.pcs ? { piecesPerSet: p.pcs } : {}),
    },
    // Food-contact and appliance ratings are unknown for décor, so they stay null (never displayed).
    care: { foodSafe: null, dishwasherSafe: null, microwaveSafe: null, ovenSafe: null, freezerSafe: null, notes: CARE_BY_MATERIAL[p.m] || CARE_BY_MATERIAL.other },
    manufacturer: { countryOfOrigin: '' },
    isFragile: fragile,
    packaging: { requirements: fragile ? ['fragile_label', 'bubble_wrap', 'multi_layer_box', ...(/glass/.test(p.m) ? ['separate_glass_packing'] : [])] : ['protective_wrapping'] },
    giftWrapAvailable: true,
    seo: {
      title: `${p.n} | ${BRAND}`.slice(0, 70),
      description: short.slice(0, 170),
      keywords,
    },
    flags: flagsFor(index),
    status: 'draft',
  };
}

function plan() {
  const { MATERIALS } = require('../constants/statuses');
  const cats = flattenDecor();
  const problems = [];
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  if (bySlug.size !== cats.length) problems.push('duplicate category slugs in taxonomy');
  const subs = cats.filter((c) => c.level === 1);
  for (const c of subs) {
    const list = PRODUCTS[c.slug];
    if (!list) problems.push(`no products defined for ${c.slug}`);
    else if (list.length < 2) problems.push(`${c.slug} has ${list.length} products (need at least 2)`);
  }
  for (const slug of Object.keys(PRODUCTS)) if (!bySlug.has(slug) || bySlug.get(slug).level !== 1) problems.push(`products defined for unknown sub-category ${slug}`);
  let index = 0;
  const items = subs.flatMap((c) => (PRODUCTS[c.slug] || []).map((row) => ({ cat: c, p: rowToProduct(row), index: index++ })));
  for (const { cat, p } of items) {
    if (!MATERIALS.includes(p.m)) problems.push(`${p.n}: unknown material ${p.m}`);
    for (const m of p.ms || []) if (!MATERIALS.includes(m)) problems.push(`${p.n}: unknown material ${m}`);
    if (p.p > p.mrp) problems.push(`${p.n}: price above MRP`);
    for (const [t, mrp, price] of p.v || []) if (price > mrp) problems.push(`${p.n} (${t}): price above MRP`);
    try {
      parseDims(p.dim);
    } catch (e) {
      problems.push(`${p.n}: ${e.message}`);
    }
    if (!p.b || p.b.length < 60) problems.push(`${p.n}: description too short`);
    if (!cat.spaces?.length) problems.push(`${cat.slug}: no spaces`);
  }
  const skus = items.flatMap(({ cat, p }) => (p.v?.length ? p.v.map(([, , , size]) => `${skuFor(cat, p)}-${String(size).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8)}`) : [skuFor(cat, p)]));
  if (new Set(skus).size !== skus.length) problems.push('SKU collision in seed data');
  if (new Set(items.map((x) => x.p.n.toLowerCase())).size !== items.length) problems.push('duplicate product names in seed data');
  if (new Set(items.map((x) => x.p.b)).size !== items.length) problems.push('duplicate product descriptions in seed data');
  return { cats, items, problems };
}

/** The SKU the product is found by (first variant's SKU). */
function primarySku(cat, p) {
  const base = skuFor(cat, p);
  return p.v?.length ? `${base}-${String(p.v[0][3]).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8)}` : base;
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

/** Relevance score of an Unsplash search result for a query and keyword list (−1 = unusable). */
function score(photo, keywords, query, { minSide = 1200 } = {}) {
  const text = `${photo.description} ${photo.tags.join(' ')}`.toLowerCase();
  if (BLOCKED_WORDS.test(text)) return -1;
  if (Math.min(photo.width, photo.height) < minSide) return -1;
  let s = 0;
  for (const k of keywords) if (text.includes(k)) s += 2;
  for (const w of query.split(' ')) if (w.length > 2 && text.includes(w)) s += 3;
  return s;
}

function imageImporter({ wait, report }) {
  const unsplash = require('../services/unsplash');
  const { Upload } = require('../modules/media/media.model');
  const cache = loadCache();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let used = null;

  async function search(q) {
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
  }

  /** Up to `count` verified, unused photos for the queries (tried in order). */
  async function pick(queries, keywords, count, ref) {
    if (!used) used = new Set((await Upload.find({ 'source.provider': 'unsplash' }).select('source.photoId').lean()).map((u) => u.source.photoId));
    const chosen = [];
    for (const q of queries) {
      if (chosen.length >= count) break;
      const ranked = (await search(q))
        .filter((x) => !used.has(x.id) && !chosen.some((c) => c.photo.id === x.id))
        .map((x) => ({ x, s: score(x, keywords, q) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s);
      for (const { x } of ranked.slice(0, 8)) {
        if (chosen.length >= count) break;
        const verification = await unsplash.verify(x.rawUrl);
        if (!verification.ok) {
          report.images.broken.push({ ref, photoId: x.id, reason: verification.reason });
          continue;
        }
        used.add(x.id);
        chosen.push({ photo: x, verification, query: q });
        report.images.verifiedUrls.push({ ref, photoId: x.id, url: unsplash.sized(x.rawUrl, 1200), page: x.pageUrl, author: x.author });
      }
    }
    return chosen;
  }

  async function register({ photo, verification, query }, { purpose, target, alt, ownerId }) {
    const media = require('../modules/media/media.service');
    const { upload, created } = await media.registerUnsplashImage({ photo, verification, ownerId, purpose, target, query, alt });
    if (created) {
      await unsplash.trackDownload(photo.downloadLocation).then(
        () => Upload.updateOne({ _id: upload._id }, { $set: { 'source.downloadTrackedAt': new Date() } }),
        (err) => report.images.trackingFailed.push({ photoId: photo.id, reason: err.message }),
      );
    }
    return upload;
  }

  return { pick, register, configured: unsplash.isConfigured() };
}

async function importImages({ items, cats, apply, wait, perProduct, req, report }) {
  const Product = require('../modules/products/product.model');
  const Category = require('../modules/categories/category.model');
  const Collection = require('../modules/collections/collection.model');
  const { Upload } = require('../modules/media/media.model');
  const productService = require('../modules/products/product.service');
  const imp = imageImporter({ wait, report });
  if (!imp.configured) {
    report.images.blocked = 'UNSPLASH_ACCESS_KEY is not set — no photos were searched, verified or attached';
    return;
  }
  const ownerId = req.auth.userId;
  const hasPendingFor = async (type, id) => Upload.exists({ 'source.provider': 'unsplash', 'target.type': type, 'target.id': String(id), 'review.status': { $in: ['pending_review', 'approved'] } });

  try {
    // Categories and sub-categories: one photo each, targeted at the category for --attach.
    for (const c of cats) {
      const doc = await Category.findOne({ slug: c.slug }).select('_id image').lean();
      if (!doc) continue;
      if (doc.image?.url || (await hasPendingFor('category', doc._id))) {
        report.images.skippedHasImages++;
        continue;
      }
      const [pickd] = await imp.pick([c.q, `${c.name} decor`], c.keywords, 1, `category:${c.slug}`);
      if (!pickd) {
        report.images.unmatched.push({ ref: `category:${c.slug}`, query: c.q });
        continue;
      }
      if (apply) await imp.register(pickd, { purpose: 'category', target: { type: 'category', id: String(doc._id) }, alt: `${c.name} — home décor`.slice(0, 160), ownerId });
      report.images.categories++;
    }
    // Spaces: one photo each.
    for (const s of SPACES) {
      const doc = await Collection.findOne({ slug: s.slug, type: 'space' }).select('_id image').lean();
      if (!doc) continue;
      if (doc.image?.url || (await hasPendingFor('collection', doc._id))) {
        report.images.skippedHasImages++;
        continue;
      }
      const [pickd] = await imp.pick([s.q], ['interior', 'room', 'decor', 'home', ...s.name.toLowerCase().split(/\W+/)], 1, `space:${s.slug}`);
      if (!pickd) {
        report.images.unmatched.push({ ref: `space:${s.slug}`, query: s.q });
        continue;
      }
      if (apply) await imp.register(pickd, { purpose: 'collection', target: { type: 'collection', id: String(doc._id) }, alt: `${s.name} styled with home décor`, ownerId });
      report.images.spaces++;
    }
    // Products: a small gallery each (primary + alternate views).
    for (const { cat, p } of items) {
      const product = await Product.findOne({ 'variants.sku': primarySku(cat, p) }).select('_id images updatedAt').lean();
      if (!product) continue;
      if (product.images?.length) {
        report.images.skippedHasImages++;
        continue;
      }
      const picks = await imp.pick([p.q, cat.q, `${cat.name} ${label(p.m)}`], [...cat.keywords, ...p.q.split(' ')], perProduct, `product:${primarySku(cat, p)}`);
      if (!picks.length) {
        report.images.unmatched.push({ ref: `product:${primarySku(cat, p)}`, name: p.n, query: p.q });
        continue;
      }
      if (!apply) {
        report.images.products++;
        continue;
      }
      const uploads = [];
      for (const [i, pk] of picks.entries()) uploads.push({ media: String((await imp.register(pk, { purpose: 'product', target: { type: 'product', id: String(product._id) }, alt: (i ? `${p.n} — styled view` : p.n).slice(0, 160), ownerId }))._id), alt: (i ? `${p.n} — styled view` : p.n).slice(0, 160), sortOrder: i });
      await productService.setImages(String(product._id), uploads, req, { expectedUpdatedAt: product.updatedAt });
      report.images.products++;
      report.images.attachedPending += uploads.length;
    }
  } catch (err) {
    if (err.rateLimited) report.images.stoppedEarly = 'Unsplash rate limit reached; rerun later (progress is kept)';
    else throw err;
  }
}

/** After review: approved photos targeted at a category/space become its image (only where none is set). */
async function attachApproved({ cats, apply, report }) {
  const Category = require('../modules/categories/category.model');
  const Collection = require('../modules/collections/collection.model');
  const { Upload } = require('../modules/media/media.model');
  const media = require('../modules/media/media.service');
  const cache = require('../services/cache');
  const sync = require('../services/sync');
  const targets = [
    ...(await Category.find({ slug: { $in: cats.map((c) => c.slug) } }).select('_id slug name image').lean()).map((d) => ({ Model: Category, type: 'category', d })),
    ...(await Collection.find({ slug: { $in: SPACES.map((s) => s.slug) }, type: 'space' }).select('_id slug name image').lean()).map((d) => ({ Model: Collection, type: 'collection', d })),
  ];
  for (const { Model, type, d } of targets) {
    if (d.image?.url) continue;
    const up = await Upload.findOne({ 'target.type': type, 'target.id': String(d._id), 'review.status': 'approved' }).sort({ createdAt: 1 }).lean();
    if (!up) {
      report.attach.waitingForApproval.push(`${type}:${d.slug}`);
      continue;
    }
    if (apply) {
      const image = await media.resolveApprovedImage({ media: String(up._id), alt: up.originalName?.slice(0, 160) || d.name }, { field: 'image' });
      await Model.updateOne({ _id: d._id, 'image.url': { $exists: false } }, { $set: { image } });
    }
    report.attach.attached.push(`${type}:${d.slug}`);
  }
  if (apply && report.attach.attached.length) {
    await cache.bump(cache.NS.CATEGORIES, cache.NS.CATALOG);
    sync.changed({ tags: [sync.TAGS.CATEGORIES, sync.TAGS.CATALOG], events: [{ event: sync.EVENTS.CATEGORY_UPDATED }] });
  }
}

/** Publishes seeded drafts that have at least one approved image (the server enforces the same rule). */
async function publishReady({ items, apply, req, report }) {
  const Product = require('../modules/products/product.model');
  const productService = require('../modules/products/product.service');
  for (const { cat, p } of items) {
    const product = await Product.findOne({ 'variants.sku': primarySku(cat, p) }).select('_id status images updatedAt').lean();
    if (!product || product.status !== 'draft') continue;
    if (!Product.publicImages(product.images).length) {
      report.publish.waitingForApprovedImage++;
      continue;
    }
    if (apply) {
      try {
        await productService.setStatus(String(product._id), 'active', req, { expectedUpdatedAt: product.updatedAt });
      } catch (err) {
        report.publish.failed.push({ name: p.n, reason: err.message });
        continue;
      }
    }
    report.publish.published++;
  }
}

// ------------------------------------------------------------------ audit

async function audit() {
  const Category = require('../modules/categories/category.model');
  const Collection = require('../modules/collections/collection.model');
  const Product = require('../modules/products/product.model');
  const { Upload } = require('../modules/media/media.model');
  const Inventory = require('mongoose').model('Inventory');
  const { cats, items } = plan();
  const dbCats = await Category.find({ slug: { $in: cats.map((c) => c.slug) } }).lean();
  const catBySlug = new Map(dbCats.map((c) => [c.slug, c]));
  const spaces = await Collection.find({ slug: { $in: SPACES.map((s) => s.slug) }, type: 'space' }).lean();
  const products = await Product.find({ 'variants.sku': { $in: items.map((i) => primarySku(i.cat, i.p)) } }).lean();
  const direct = await Product.aggregate([{ $match: { category: { $in: dbCats.map((c) => c._id) } } }, { $group: { _id: '$category', n: { $sum: 1 } } }]);
  const directById = new Map(direct.map((d) => [String(d._id), d.n]));
  const perCategory = cats.map((c) => {
    const db = catBySlug.get(c.slug);
    const parentOk = db ? (c.parentSlug ? String(db.parent) === String(catBySlug.get(c.parentSlug)?._id) : !db.parent) : false;
    return { slug: c.slug, level: c.level, exists: Boolean(db), parentOk, products: db ? directById.get(String(db._id)) || 0 : 0, hasImage: Boolean(db?.image?.url) };
  });
  const badPaths = products.filter((p) => {
    const c = dbCats.find((x) => String(x._id) === String(p.category));
    return !c || c.level !== 1 || String([...c.ancestors, c._id]) !== String(p.categoryPath);
  });
  const mediaIds = products.flatMap((p) => p.images.map((i) => i.media)).filter(Boolean);
  const uploads = await Upload.find({ _id: { $in: mediaIds } }).select('review.status source.verifiedAt').lean();
  const allSkus = products.flatMap((p) => p.variants.map((v) => v.sku));
  const stock = await Inventory.find({ sku: { $in: allSkus } }).select('sku onHand').lean();
  const dupSlugs = await Product.aggregate([{ $group: { _id: '$slug', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  const dupCatSlugs = await Category.aggregate([{ $group: { _id: '$slug', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  const dupSkus = await Product.aggregate([{ $unwind: '$variants' }, { $group: { _id: '$variants.sku', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
  return {
    parents: perCategory.filter((c) => c.level === 0 && c.exists).length,
    subcategories: perCategory.filter((c) => c.level === 1 && c.exists).length,
    categoriesWithWrongParent: perCategory.filter((c) => c.exists && !c.parentOk).map((c) => c.slug),
    subcategoriesWithFewerThanTwoProducts: perCategory.filter((c) => c.level === 1 && c.products < 2).map((c) => `${c.slug}: ${c.products}`),
    categoriesWithImage: perCategory.filter((c) => c.hasImage).length,
    spaces: spaces.length,
    spacesWithImage: spaces.filter((s) => s.image?.url).length,
    expectedProducts: items.length,
    seededProductsFound: products.length,
    productsWithInvalidCategoryPath: badPaths.map((p) => p.slug),
    productsWithoutSpace: products.filter((p) => !p.collections?.some((id) => spaces.some((s) => String(s._id) === String(id)))).map((p) => p.slug),
    byStatus: products.reduce((a, p) => ({ ...a, [p.status]: (a[p.status] || 0) + 1 }), {}),
    flags: { featured: products.filter((p) => p.flags?.featured).length, bestseller: products.filter((p) => p.flags?.bestseller).length, newArrival: products.filter((p) => p.flags?.newArrival).length },
    productsWithImages: products.filter((p) => p.images.length).length,
    productsWithoutImages: products.filter((p) => !p.images.length).length,
    imagesPendingReview: uploads.filter((u) => u.review?.status === 'pending_review').length,
    imagesApproved: uploads.filter((u) => u.review?.status === 'approved').length,
    imagesVerified: uploads.filter((u) => u.source?.verifiedAt).length,
    skusWithStock: stock.filter((s) => s.onHand > 0).length,
    skusTotal: allSkus.length,
    duplicateProductSlugs: dupSlugs.length,
    duplicateCategorySlugs: dupCatSlugs.length,
    duplicateSkus: dupSkus.length,
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
  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (arg('audit')) {
    const r = await audit();
    const { perCategory, ...summary } = r;
    console.log(JSON.stringify(summary, null, 2));
    fs.writeFileSync(REPORT_PATH.replace('.json', '-audit.json'), JSON.stringify(r, null, 2));
    return done(0);
  }

  const { cats, items, problems } = plan();
  if (problems.length) {
    console.error('Seed data is invalid:\n - ' + problems.join('\n - '));
    return done(1);
  }
  console.log(`Plan: ${cats.filter((c) => !c.parentSlug).length} parent categories, ${cats.filter((c) => c.parentSlug).length} sub-categories, ${SPACES.length} spaces, ${items.length} products${apply ? '' : ' (DRY RUN — nothing is written)'}`);

  const mongoose = require('mongoose');
  const Category = require('../modules/categories/category.model');
  const Collection = require('../modules/collections/collection.model');
  const Product = require('../modules/products/product.model');
  const User = require('../modules/users/user.model');
  const productService = require('../modules/products/product.service');
  const { createProduct: createSchema } = require('../modules/products/product.schemas');
  const inventory = require('../modules/inventory/inventory.service');
  const cache = require('../services/cache');
  const sync = require('../services/sync');
  const { permissionsFor } = require('../constants/roles');
  const InventoryMovement = mongoose.model('InventoryMovement');

  const admin = await User.findOne({ role: 'super_admin' }).select('_id').lean();
  if (!admin) {
    console.error('No super_admin user exists to own the seeded records. Run `npm run create-admin` first.');
    return done(1);
  }
  const req = { auth: { userId: admin._id, role: 'super_admin', isStaff: true, permissions: permissionsFor('super_admin') }, ip: '127.0.0.1', headers: { 'user-agent': 'seed-home-decor' }, get: () => 'seed-home-decor' };

  const report = {
    startedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    categories: { created: [], reused: [], manualReview: [] },
    spaces: { created: [], reused: [], manualReview: [] },
    products: { created: [], reused: [], manualReview: [], failed: [], spaceLinksAdded: 0 },
    stock: { set: 0, skipped: 0, failed: [] },
    images: { categories: 0, spaces: 0, products: 0, attachedPending: 0, skippedHasImages: 0, verifiedUrls: [], broken: [], unmatched: [], trackingFailed: [] },
    attach: { attached: [], waitingForApproval: [] },
    publish: { published: 0, waitingForApprovedImage: 0, failed: [] },
  };

  // 1. Categories — each parent and its sub-categories in one transaction; matched by slug.
  const catBySlug = new Map((await Category.find({ slug: { $in: cats.map((c) => c.slug) } }).lean()).map((c) => [c.slug, c]));
  const parents = cats.filter((c) => c.level === 0);
  for (const parentDef of parents) {
    const group = [parentDef, ...cats.filter((c) => c.parentSlug === parentDef.slug)];
    const toCreate = [];
    for (const c of group) {
      const existing = catBySlug.get(c.slug);
      if (existing) {
        const parent = c.parentSlug ? catBySlug.get(c.parentSlug) : null;
        const ok = c.parentSlug ? parent && String(existing.parent) === String(parent._id) : !existing.parent;
        if (ok) report.categories.reused.push(c.slug);
        else report.categories.manualReview.push(`${c.slug} (exists under a different parent — left unchanged)`);
      } else toCreate.push(c);
    }
    if (!toCreate.length) continue;
    if (!apply) {
      for (const c of toCreate) {
        const parent = c.parentSlug ? catBySlug.get(c.parentSlug) : null;
        catBySlug.set(c.slug, { _id: `dry:${c.slug}`, slug: c.slug, ancestors: parent ? [parent._id] : [], level: c.level, parent: parent?._id || null });
        report.categories.created.push(c.slug);
      }
      continue;
    }
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const local = new Map();
        for (const c of toCreate) {
          const parent = c.parentSlug ? local.get(c.parentSlug) || catBySlug.get(c.parentSlug) : null;
          if (c.parentSlug && !parent) throw new Error(`parent ${c.parentSlug} missing for ${c.slug}`);
          const [doc] = await Category.create(
            [
              {
                name: c.name,
                slug: c.slug,
                parent: parent?._id || null,
                ancestors: parent ? [...(parent.ancestors || []), parent._id] : [],
                level: parent ? parent.level + 1 : 0,
                description: c.description,
                sortOrder: c.level === 0 ? 100 + c.sortOrder : c.sortOrder, // after the existing crockery parents
                isActive: true,
                isFeatured: c.level === 0,
                seo: { title: `${c.name} | Home Décor | ${BRAND}`.slice(0, 70), description: c.description.slice(0, 170), keywords: [c.name.toLowerCase(), 'home decor', c.rootName.toLowerCase()].filter((k) => k.length <= 40) },
              },
            ],
            { session },
          );
          local.set(c.slug, doc.toObject());
        }
        for (const [slug, doc] of local) catBySlug.set(slug, doc);
      });
      report.categories.created.push(...toCreate.map((c) => c.slug));
    } catch (err) {
      for (const c of toCreate) catBySlug.delete(c.slug);
      report.categories.manualReview.push(`${parentDef.slug} group failed and was rolled back: ${err.message}`);
    } finally {
      await session.endSession();
    }
  }
  if (apply && report.categories.created.length) {
    await cache.bump(cache.NS.CATEGORIES, cache.NS.CATALOG);
    sync.changed({ tags: [sync.TAGS.CATEGORIES, sync.TAGS.CATALOG], events: [{ event: sync.EVENTS.CATEGORY_UPDATED }] });
  }

  // 2. "Shop by Space" collections — matched by slug.
  const spaceBySlug = new Map();
  for (const [i, s] of SPACES.entries()) {
    const existing = await Collection.findOne({ slug: s.slug }).lean();
    if (existing) {
      if (existing.type === 'space') {
        report.spaces.reused.push(s.slug);
        spaceBySlug.set(s.slug, existing);
      } else report.spaces.manualReview.push(`${s.slug} (a ${existing.type} collection already uses this slug — left unchanged)`);
      continue;
    }
    report.spaces.created.push(s.slug);
    if (!apply) {
      spaceBySlug.set(s.slug, { _id: `dry:${s.slug}` });
      continue;
    }
    const doc = await Collection.create({ name: s.name, slug: s.slug, type: 'space', description: s.description, isActive: true, sortOrder: i, seo: { title: `${s.name} Décor | ${BRAND}`.slice(0, 70), description: s.description.slice(0, 170) } });
    spaceBySlug.set(s.slug, doc.toObject());
  }
  if (apply && report.spaces.created.length) {
    await cache.bump(cache.NS.CATALOG);
    sync.changed({ tags: [sync.TAGS.CATALOG], events: [] });
  }

  // 3. Products — matched by SKU; drafts with opening stock.
  for (const { cat, p, index } of items) {
    const sku = primarySku(cat, p);
    const category = catBySlug.get(cat.slug);
    const collectionIds = cat.spaces.map((s) => spaceBySlug.get(s)?._id).filter((id) => id && !String(id).startsWith('dry:'));
    try {
      const existing = await Product.findOne({ 'variants.sku': sku }).select('_id collections').lean();
      if (existing) {
        report.products.reused.push(sku);
        // Additive repair: link the product to its spaces if a link is missing (nothing is removed).
        const missing = collectionIds.filter((id) => !(existing.collections || []).some((c) => String(c) === String(id)));
        if (missing.length && apply) {
          await Product.updateOne({ _id: existing._id }, { $addToSet: { collections: { $each: missing } } });
          report.products.spaceLinksAdded += missing.length;
        }
        continue;
      }
      if (!category) {
        report.products.manualReview.push(`${sku} (category ${cat.slug} missing)`);
        continue;
      }
      const data = buildProduct(cat, p, { categoryId: String(category._id).startsWith('dry:') ? '0'.repeat(24) : category._id, collectionIds, index });
      if (await Product.exists({ slug: data.slug })) {
        report.products.manualReview.push(`${sku} (slug ${data.slug} already used by another product)`);
        continue;
      }
      const parsed = createSchema.parse(data);
      if (!apply) {
        report.products.created.push(sku);
        continue;
      }
      const product = await productService.createProduct(parsed, req);
      report.products.created.push(sku);
      for (const v of product.variants) {
        try {
          if (await InventoryMovement.exists({ sku: v.sku, reason: OPENING_STOCK_REASON })) {
            report.stock.skipped++;
            continue;
          }
          await inventory.adjust(v.sku, 10 + (parseInt(hash6(v.sku), 16) % 31), OPENING_STOCK_REASON, { type: 'system', id: admin._id });
          report.stock.set++;
        } catch (err) {
          report.stock.failed.push({ sku: v.sku, reason: err.message });
        }
      }
    } catch (err) {
      report.products.failed.push({ sku, name: p.n, reason: err.issues ? JSON.stringify(err.issues).slice(0, 300) : err.message });
    }
  }
  if (apply) {
    const skus = (await Product.find({ 'variants.sku': { $in: items.map((i) => primarySku(i.cat, i.p)) } }).select('variants.sku').lean()).flatMap((x) => x.variants.map((v) => v.sku));
    await inventory.refreshStock({ skus });
    if (report.products.spaceLinksAdded) await cache.bump(cache.NS.CATALOG);
  }

  // 4–6. Optional phases.
  if (arg('images')) await importImages({ items, cats, apply, wait: Boolean(arg('wait')), perProduct: Math.min(4, Math.max(1, Number(arg('per-product', 2)) || 2)), req, report });
  if (arg('attach')) await attachApproved({ cats, apply, report });
  if (arg('publish')) await publishReady({ items, apply, req, report });

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(apply ? REPORT_PATH : REPORT_PATH.replace('.json', '-dryrun.json'), JSON.stringify(report, null, 2));
  const n = (a) => (Array.isArray(a) ? a.length : a);
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        categories: { created: n(report.categories.created), reused: n(report.categories.reused), manualReview: report.categories.manualReview },
        spaces: { created: n(report.spaces.created), reused: n(report.spaces.reused), manualReview: report.spaces.manualReview },
        products: { created: n(report.products.created), reused: n(report.products.reused), spaceLinksAdded: report.products.spaceLinksAdded, manualReview: report.products.manualReview, failed: report.products.failed },
        stock: { set: report.stock.set, skipped: report.stock.skipped, failed: report.stock.failed },
        ...(arg('images') ? { images: { ...report.images, verifiedUrls: n(report.images.verifiedUrls), broken: n(report.images.broken), unmatched: n(report.images.unmatched) } } : {}),
        ...(arg('attach') ? { attach: { attached: n(report.attach.attached), waitingForApproval: n(report.attach.waitingForApproval) } } : {}),
        ...(arg('publish') ? { publish: report.publish } : {}),
        report: path.relative(process.cwd(), apply ? REPORT_PATH : REPORT_PATH.replace('.json', '-dryrun.json')),
      },
      null,
      2,
    ),
  );
  return done(report.products.failed.length || report.categories.manualReview.some((m) => m.includes('rolled back')) ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    done(1);
  });
}

module.exports = { plan, buildProduct, skuFor, primarySku, parseDims, score, flagsFor };
