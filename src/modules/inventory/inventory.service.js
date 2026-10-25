'use strict';

const { Inventory, InventoryMovement, StockReservation, BackInStockSubscription } = require('./inventory.models');
const { conflict, badRequest, notFound } = require('../../utils/errors');
const { enqueue, QUEUES } = require('../../queues');
const bus = require('../../events/bus');
const logger = require('../../config/logger');

/**
 * All stock mutations are single-document conditional updates ($inc guarded by a filter), so
 * concurrent buyers can never push `reserved` above `onHand`. Multi-SKU operations run inside a
 * MongoDB transaction when available; otherwise they compensate on failure.
 */

const AVAILABLE_GTE = (q) => ({ $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, q] } });
const opts = (session) => (session ? { session, new: true } : { new: true });

function mergeItems(items) {
  const map = new Map();
  for (const { sku, quantity } of items) {
    if (!Number.isInteger(quantity) || quantity <= 0) throw badRequest(`Invalid quantity for ${sku}`);
    map.set(sku, (map.get(sku) || 0) + quantity);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sku, quantity]) => ({ sku, quantity }));
}

/** Expands order lines into component SKUs (bundles reserve their component stock). */
function expandLines(lines) {
  const out = [];
  for (const l of lines) {
    if (l.bundleComponents?.length) {
      for (const c of l.bundleComponents) out.push({ sku: c.sku, quantity: c.quantity * l.quantity });
    } else out.push({ sku: l.sku, quantity: l.quantity });
  }
  return mergeItems(out);
}

async function logMovements(entries, session) {
  if (!entries.length) return;
  await InventoryMovement.insertMany(entries, session ? { session } : {});
}

function movement(doc, type, quantity, delta, ref, extra = {}) {
  return {
    sku: doc.sku,
    product: doc.product,
    type,
    quantity,
    delta,
    after: { onHand: doc.onHand, reserved: doc.reserved, quarantine: doc.quarantine },
    ref,
    ...extra,
  };
}

async function outOfStockError(sku) {
  const inv = await Inventory.findOne({ sku }).select('onHand reserved').lean();
  const available = inv ? Math.max(0, inv.onHand - inv.reserved) : 0;
  return conflict(`Only ${available} unit(s) of ${sku} available`, 'OUT_OF_STOCK', { sku, available });
}

/**
 * Applies a list of guarded $inc operations atomically per SKU. On failure without a session,
 * already-applied steps are reverted with their inverse.
 */
async function applySteps(steps, session) {
  const applied = [];
  try {
    for (const s of steps) {
      const doc = await Inventory.findOneAndUpdate({ sku: s.sku, ...s.guard }, { $inc: s.inc }, opts(session));
      if (!doc) throw s.onFail ? await s.onFail() : conflict(`Stock update failed for ${s.sku}`, 'STOCK_CONFLICT', { sku: s.sku });
      applied.push({ step: s, doc });
    }
    return applied;
  } catch (err) {
    if (!session) {
      for (const { step } of applied.reverse()) {
        const inverse = Object.fromEntries(Object.entries(step.inc).map(([k, v]) => [k, -v]));
        await Inventory.updateOne({ sku: step.sku }, { $inc: inverse }).catch((e) => logger.error({ e: e.message, sku: step.sku }, 'compensation failed'));
      }
    }
    throw err;
  }
}

/**
 * Debounced refresh of derived state (product inStock, low-stock and back-in-stock alerts): one job
 * per SKU per 2 s bucket, scheduled to run just after the bucket closes so it sees the latest stock.
 */
const REFRESH_BUCKET_MS = 2000;
function touch(skus) {
  const now = Date.now();
  const bucket = Math.floor(now / REFRESH_BUCKET_MS);
  const delay = (bucket + 1) * REFRESH_BUCKET_MS - now + 50;
  for (const sku of new Set(skus)) enqueue(QUEUES.INVENTORY, 'refresh', { skus: [sku] }, { delay, jobId: `refresh-${sku}-${bucket}` }).catch(() => {});
}

// ------------------------------------------------------------------ reads

async function getAvailability(skus) {
  const docs = await Inventory.find({ sku: { $in: skus } }).select('sku onHand reserved').lean();
  const map = Object.fromEntries(skus.map((s) => [s, 0]));
  for (const d of docs) map[d.sku] = Math.max(0, d.onHand - d.reserved);
  return map;
}

/** Per-variant availability for a product document; bundle availability is min over components. */
async function productAvailability(product) {
  if (product.type === 'bundle') {
    const avail = await getAvailability(product.bundleItems.map((b) => b.sku));
    const units = product.bundleItems.length ? Math.min(...product.bundleItems.map((b) => Math.floor(avail[b.sku] / b.quantity))) : 0;
    return Object.fromEntries(product.variants.map((v) => [v.sku, units]));
  }
  return getAvailability(product.variants.map((v) => v.sku));
}

// ------------------------------------------------------------------ setup

async function ensureInventory(product, session) {
  if (product.type === 'bundle') return;
  for (const v of product.variants) {
    await Inventory.updateOne(
      { sku: v.sku },
      { $setOnInsert: { sku: v.sku, product: product._id, variantId: v._id, onHand: 0 } },
      { upsert: true, session },
    );
  }
}

// ------------------------------------------------------------------ reservations

async function reserve(lines, ref, { expiresAt, session } = {}) {
  const items = expandLines(lines);
  const applied = await applySteps(
    items.map((i) => ({ sku: i.sku, guard: AVAILABLE_GTE(i.quantity), inc: { reserved: i.quantity }, onFail: () => outOfStockError(i.sku) })),
    session,
  );
  try {
    await StockReservation.create([{ ref, items, expiresAt, status: 'active' }], session ? { session } : {});
  } catch (err) {
    if (!session) {
      for (const i of items) await Inventory.updateOne({ sku: i.sku, reserved: { $gte: i.quantity } }, { $inc: { reserved: -i.quantity } });
    }
    throw err;
  }
  await logMovements(applied.map(({ step, doc }) => movement(doc, 'reserve', step.inc.reserved, { reserved: step.inc.reserved }, { type: ref.type, id: String(ref.id) })), session);
  touch(items.map((i) => i.sku));
  return items;
}

/** Converts an active reservation into sold stock. Returns false if no active reservation exists. */
async function commitReservation(ref, { session } = {}) {
  const r = await StockReservation.findOneAndUpdate(
    { 'ref.type': ref.type, 'ref.id': ref.id, status: 'active' },
    { $set: { status: 'committed' } },
    opts(session),
  );
  if (!r) return false;
  const applied = await applySteps(
    r.items.map((i) => ({ sku: i.sku, guard: { reserved: { $gte: i.quantity }, onHand: { $gte: i.quantity } }, inc: { reserved: -i.quantity, onHand: -i.quantity, sold: i.quantity } })),
    session,
  );
  await logMovements(applied.map(({ step, doc }) => movement(doc, 'commit', step.inc.sold, { reserved: -step.inc.sold, onHand: -step.inc.sold, sold: step.inc.sold }, { type: ref.type, id: String(ref.id) })), session);
  touch(r.items.map((i) => i.sku));
  return true;
}

/** Takes stock directly (no prior reservation), e.g. a late payment after the hold expired. */
async function commitDirect(lines, ref, { session, type = 'commit' } = {}) {
  const items = expandLines(lines);
  const soldInc = type === 'commit' ? 1 : 0;
  const applied = await applySteps(
    items.map((i) => ({ sku: i.sku, guard: AVAILABLE_GTE(i.quantity), inc: { onHand: -i.quantity, sold: i.quantity * soldInc }, onFail: () => outOfStockError(i.sku) })),
    session,
  );
  await StockReservation.updateOne(
    { 'ref.type': ref.type, 'ref.id': ref.id },
    { $set: { status: 'committed', items } },
    { upsert: true, session },
  );
  await logMovements(applied.map(({ step, doc }) => movement(doc, type, -step.inc.onHand, step.inc, { type: ref.type, id: String(ref.id) })), session);
  touch(items.map((i) => i.sku));
  return items;
}

async function releaseReservation(ref, reason, { session } = {}) {
  const r = await StockReservation.findOneAndUpdate(
    { 'ref.type': ref.type, 'ref.id': ref.id, status: 'active' },
    { $set: { status: 'released', releasedReason: reason } },
    opts(session),
  );
  if (!r) return false;
  const applied = await applySteps(
    r.items.map((i) => ({ sku: i.sku, guard: { reserved: { $gte: i.quantity } }, inc: { reserved: -i.quantity } })),
    session,
  );
  await logMovements(applied.map(({ step, doc }) => movement(doc, 'release', -step.inc.reserved, { reserved: step.inc.reserved }, { type: ref.type, id: String(ref.id) }, { reason })), session);
  touch(r.items.map((i) => i.sku));
  return true;
}

async function getReservation(ref) {
  return StockReservation.findOne({ 'ref.type': ref.type, 'ref.id': ref.id }).lean();
}

/** Puts committed-but-unshipped units back on the shelf (cancellation before dispatch). */
async function restockCancelled(lines, ref, { session } = {}) {
  const items = expandLines(lines);
  const applied = await applySteps(items.map((i) => ({ sku: i.sku, guard: {}, inc: { onHand: i.quantity, sold: -i.quantity } })), session);
  await logMovements(applied.map(({ step, doc }) => movement(doc, 'cancel_restock', step.inc.onHand, step.inc, { type: ref.type, id: String(ref.id) })), session);
  touch(items.map((i) => i.sku));
}

/** Puts units taken for a cancelled replacement back on the shelf (they were never counted as sold). */
async function restockReplacement(lines, ref, { session } = {}) {
  const items = expandLines(lines);
  const applied = await applySteps(items.map((i) => ({ sku: i.sku, guard: {}, inc: { onHand: i.quantity } })), session);
  await logMovements(applied.map(({ step, doc }) => movement(doc, 'cancel_restock', step.inc.onHand, step.inc, { type: ref.type, id: String(ref.id) })), session);
  touch(items.map((i) => i.sku));
}

/** Returned / RTO units go to quarantine and wait for an inspection decision. */
async function quarantine(lines, ref, { session, reason } = {}) {
  const items = expandLines(lines);
  const applied = await applySteps(items.map((i) => ({ sku: i.sku, guard: {}, inc: { quarantine: i.quantity } })), session);
  await logMovements(applied.map(({ step, doc }) => movement(doc, 'return_quarantine', step.inc.quarantine, step.inc, { type: ref.type, id: String(ref.id) }, { reason })), session);
}

const DISPOSITIONS = {
  restock: { type: 'disposition_restock', inc: (q) => ({ quarantine: -q, onHand: q }) },
  damaged: { type: 'disposition_damaged', inc: (q) => ({ quarantine: -q, damaged: q }) },
  unusable: { type: 'disposition_unusable', inc: (q) => ({ quarantine: -q, unusable: q }) },
};

async function disposition(sku, quantity, decision, ref, actor, { session, reason } = {}) {
  const d = DISPOSITIONS[decision];
  if (!d) throw badRequest('Invalid disposition');
  const [{ doc }] = await applySteps(
    [{ sku, guard: { quarantine: { $gte: quantity } }, inc: d.inc(quantity), onFail: async () => conflict(`Not enough quarantined units of ${sku}`, 'STOCK_CONFLICT') }],
    session,
  );
  await logMovements([movement(doc, d.type, quantity, d.inc(quantity), ref, { actor, reason })], session);
  touch([sku]);
  return doc;
}

async function adjust(sku, delta, reason, actor) {
  if (!Number.isInteger(delta) || delta === 0) throw badRequest('Adjustment must be a non-zero integer');
  const guard = delta < 0 ? { $expr: { $gte: [{ $add: ['$onHand', delta] }, '$reserved'] } } : {};
  const doc = await Inventory.findOneAndUpdate({ sku, ...guard }, { $inc: { onHand: delta } }, { new: true });
  if (!doc) {
    if (!(await Inventory.exists({ sku }))) throw notFound('SKU');
    throw conflict('Adjustment would drop stock below reserved units', 'STOCK_CONFLICT');
  }
  await logMovements([movement(doc, 'adjustment', delta, { onHand: delta }, { type: 'manual', id: '-' }, { reason, actor })]);
  touch([sku]);
  return doc;
}

async function receivePurchase(items, ref, actor, { session } = {}) {
  const merged = mergeItems(items);
  for (const i of merged) if (!(await Inventory.exists({ sku: i.sku }).session(session || null))) throw notFound(`SKU ${i.sku}`);
  const applied = await applySteps(merged.map((i) => ({ sku: i.sku, guard: {}, inc: { onHand: i.quantity } })), session);
  await logMovements(applied.map(({ step, doc }) => movement(doc, 'purchase_receipt', step.inc.onHand, step.inc, ref, { actor })), session);
  touch(merged.map((i) => i.sku));
}

async function warehouseDamage(sku, quantity, reason, actor) {
  const [{ doc }] = await applySteps(
    [{ sku, guard: AVAILABLE_GTE(quantity), inc: { onHand: -quantity, damaged: quantity }, onFail: () => outOfStockError(sku) }],
    null,
  );
  await logMovements([movement(doc, 'warehouse_damage', quantity, { onHand: -quantity, damaged: quantity }, { type: 'manual', id: '-' }, { reason, actor })]);
  touch([sku]);
  return doc;
}

// ------------------------------------------------------------------ derived state (job)

async function refreshStock({ skus }) {
  const Product = require('../products/product.model');
  const { getSettings } = require('../settings/settings');
  const settings = await getSettings();
  const products = await Product.find({ $or: [{ 'variants.sku': { $in: skus } }, { 'bundleItems.sku': { $in: skus } }] })
    .select('type variants bundleItems inStock name slug status')
    .lean();
  let flipped = false;
  const flippedLive = [];
  for (const p of products) {
    const avail = await productAvailability(p);
    const activeSkus = p.variants.filter((v) => v.status === 'active').map((v) => v.sku);
    const inStock = activeSkus.some((s) => avail[s] > 0);
    if (inStock !== p.inStock) {
      await Product.updateOne({ _id: p._id }, { $set: { inStock } });
      flipped = true;
      if (p.status === 'active') flippedLive.push(p);
    }
  }
  const invs = await Inventory.find({ sku: { $in: skus } }).lean();
  for (const inv of invs) {
    const available = inv.onHand - inv.reserved;
    const threshold = inv.lowStockThreshold ?? settings.inventory.defaultLowStockThreshold;
    if (available <= threshold) {
      const res = await Inventory.updateOne(
        { _id: inv._id, $or: [{ lowStockAlertedAt: null }, { lowStockAlertedAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } }] },
        { $set: { lowStockAlertedAt: new Date() } },
      );
      if (res.modifiedCount) bus.publish(bus.EVENTS.STOCK_LOW, { sku: inv.sku, product: inv.product, available, threshold });
    } else if (inv.lowStockAlertedAt) {
      await Inventory.updateOne({ _id: inv._id }, { $unset: { lowStockAlertedAt: 1 } });
    }
    if (available > 0) {
      const waiting = await BackInStockSubscription.find({ sku: inv.sku, notifiedAt: null }).limit(500).lean();
      if (waiting.length) {
        await BackInStockSubscription.updateMany({ _id: { $in: waiting.map((w) => w._id) } }, { $set: { notifiedAt: new Date() } });
        bus.publish(bus.EVENTS.STOCK_RESTOCKED, { sku: inv.sku, product: inv.product, userIds: waiting.map((w) => w.user) });
      }
    }
  }
  if (flipped) {
    // Only an in/out-of-stock flip changes cached listings; exact counts are always read live.
    const cache = require('../../services/cache');
    await cache.bump(cache.NS.CATALOG);
  }
  if (flippedLive.length) {
    // Public payload carries only the in/out-of-stock flag, never quantities.
    const sync = require('../../services/sync');
    sync.changed({
      tags: [sync.TAGS.CATALOG, ...flippedLive.map((p) => sync.TAGS.product(p.slug))],
      events: flippedLive.map((p) => ({ event: sync.EVENTS.INVENTORY_UPDATED, id: String(p._id), slug: p.slug, inStock: !p.inStock })),
    });
  }
}

module.exports = {
  mergeItems,
  expandLines,
  getAvailability,
  productAvailability,
  ensureInventory,
  reserve,
  commitReservation,
  commitDirect,
  releaseReservation,
  getReservation,
  restockCancelled,
  restockReplacement,
  quarantine,
  disposition,
  adjust,
  receivePurchase,
  warehouseDamage,
  refreshStock,
};
