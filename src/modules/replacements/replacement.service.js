'use strict';

const Replacement = require('./replacement.model');
const Order = require('../orders/order.model');
const ReturnRequest = require('../returns/return.model');
const { Shipment } = require('../shipping/shipping.models');
const inventory = require('../inventory/inventory.service');
const orderService = require('../orders/order.service');
const shippingService = require('../shipping/shipping.service');
const bus = require('../../events/bus');
const logger = require('../../config/logger');
const { transaction } = require('../../config/database');
const { referenceNumber } = require('../../utils/crypto');
const { conflict, notFound } = require('../../utils/errors');
const { REPLACEMENT_STATUS: R, ORDER_STATUS: S } = require('../../constants/statuses');

function publish(rep, ctx) {
  const fn = () => bus.publish(bus.EVENTS.REPLACEMENT_UPDATED, { replacementId: rep._id, userId: rep.user, replacementNumber: rep.replacementNumber, orderNumber: rep.orderNumber, status: rep.status });
  if (ctx?.after) ctx.after.push(fn);
  else fn();
}

/** Stock lines for a replacement: the claimed order items (bundles expand to components). */
function stockLines(order, items) {
  return items.map((i) => {
    const oi = order.items.id(i.orderItemId) || order.items.find((x) => String(x._id) === String(i.orderItemId));
    return { sku: i.sku, quantity: i.quantity, bundleComponents: oi?.bundleComponents?.length ? oi.bundleComponents : [] };
  });
}

/**
 * Creates the replacement for an approved claim. The unique index on `returnRequest` makes this
 * idempotent: retries and duplicate AI/customer submissions can never create a second shipment.
 * Stock is taken immediately when available; otherwise it waits in `awaiting_stock`.
 */
async function createForClaim(claim, ctx) {
  const existing = await Replacement.findOne({ returnRequest: claim._id }).session(ctx.session || null);
  if (existing) return existing;
  const order = await Order.findById(claim.order).session(ctx.session || null);
  const items = claim.type === 'missing_item' && claim.items.some((i) => i.missingComponents?.length)
    ? claim.items.flatMap((i) => (i.missingComponents?.length ? i.missingComponents.map((c) => ({ orderItemId: i.orderItemId, sku: c.sku, name: c.name, quantity: c.quantity })) : [{ orderItemId: i.orderItemId, sku: i.sku, name: i.name, quantity: i.quantity }]))
    : claim.items.map((i) => ({ orderItemId: i.orderItemId, sku: i.sku, name: i.name, quantity: i.quantity }));

  const [rep] = await Replacement.create(
    [{ replacementNumber: referenceNumber('RPL'), returnRequest: claim._id, order: order._id, orderNumber: order.orderNumber, user: order.user, items, status: R.AWAITING_STOCK, shippingAddress: order.shippingAddress, timeline: [{ status: R.AWAITING_STOCK, note: 'Replacement created' }] }],
    ctx.session ? { session: ctx.session } : {},
  );
  try {
    const lines = claim.type === 'missing_item' ? items.map((i) => ({ sku: i.sku, quantity: i.quantity })) : stockLines(order, items);
    await inventory.commitDirect(lines, { type: 'replacement', id: rep._id }, { session: ctx.session, type: 'replacement_out' });
    rep.status = R.RESERVED;
    rep.stockAllocatedAt = new Date();
    rep.timeline.push({ status: R.RESERVED, note: 'Stock allocated' });
    await rep.save({ session: ctx.session });
  } catch (err) {
    if (err.code !== 'OUT_OF_STOCK') throw err;
    logger.info({ replacement: rep.replacementNumber, sku: err.details?.sku }, 'replacement waiting for stock');
  }
  if (orderService.canTransition(order.status, S.REPLACEMENT_PROCESSING)) {
    await orderService.transition(order, S.REPLACEMENT_PROCESSING, { note: `Replacement ${rep.replacementNumber}`, ctx });
  }
  publish(rep, ctx);
  return rep;
}

/** Job: retries stock allocation for back-ordered replacements, oldest first. */
async function allocateAwaitingStock() {
  const waiting = await Replacement.find({ status: R.AWAITING_STOCK }).sort({ createdAt: 1 }).limit(50);
  for (const rep of waiting) {
    try {
      await transaction(async (ctx) => {
        const order = await Order.findById(rep.order).session(ctx.session);
        const claim = await ReturnRequest.findById(rep.returnRequest).session(ctx.session);
        const lines = claim.type === 'missing_item' ? rep.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) : stockLines(order, rep.items);
        await inventory.commitDirect(lines, { type: 'replacement', id: rep._id }, { session: ctx.session, type: 'replacement_out' });
        const updated = await Replacement.findOneAndUpdate(
          { _id: rep._id, status: R.AWAITING_STOCK },
          { $set: { status: R.RESERVED, stockAllocatedAt: new Date() }, $push: { timeline: { status: R.RESERVED, note: 'Stock allocated' } } },
          { new: true, session: ctx.session },
        );
        if (!updated) throw conflict('Replacement state changed', 'CONCURRENT_UPDATE');
        publish(updated, ctx);
      });
    } catch (err) {
      if (err.code !== 'OUT_OF_STOCK') logger.warn({ err: err.message, replacement: rep.replacementNumber }, 'allocation failed');
    }
  }
}

async function ship(replacementId, { courier = 'manual', awb, trackingUrl }, actor) {
  const rep = await Replacement.findById(replacementId);
  if (!rep) throw notFound('Replacement');
  if (![R.RESERVED, R.PACKED].includes(rep.status)) throw conflict(`Replacement is ${rep.status}; stock must be allocated first`, 'INVALID_STATE');
  const order = await Order.findById(rep.order).lean();
  const shipment = await Shipment.create({
    order: rep.order,
    replacement: rep._id,
    kind: 'replacement',
    courier,
    awb,
    trackingUrl,
    packaging: shippingService.packagingPlan(order.items.filter((i) => rep.items.some((r) => String(r.orderItemId) === String(i._id)))),
    events: [{ status: 'created', note: `Replacement ${rep.replacementNumber}` }],
    createdBy: actor.id,
  });
  const updated = await Replacement.findOneAndUpdate(
    { _id: rep._id, status: rep.status },
    { $set: { status: R.SHIPPED, shipment: shipment._id, shippedAt: new Date() }, $push: { timeline: { status: R.SHIPPED, note: `AWB ${awb}` } } },
    { new: true },
  );
  if (!updated) throw conflict('Replacement was updated concurrently', 'CONCURRENT_UPDATE');
  publish(updated);
  return { replacement: updated, shipment };
}

/** Courier events on a replacement shipment drive the replacement (and order) to completion. */
async function syncReplacementShipment(shipment, actor) {
  if (shipment.status !== 'delivered') return;
  const rep = await Replacement.findOneAndUpdate(
    { _id: shipment.replacement, status: R.SHIPPED },
    { $set: { status: R.DELIVERED, deliveredAt: new Date() }, $push: { timeline: { status: R.DELIVERED } } },
    { new: true },
  );
  if (!rep) return;
  publish(rep);
  const { closeAfterReplacement } = require('../returns/return.service');
  await closeAfterReplacement(rep.returnRequest, actor);
}

async function cancel(replacementId, reason, actor) {
  const rep = await Replacement.findById(replacementId);
  if (!rep) throw notFound('Replacement');
  if (![R.AWAITING_STOCK, R.RESERVED, R.PACKED].includes(rep.status)) throw conflict('Shipped replacements cannot be cancelled', 'INVALID_STATE');
  await transaction(async (ctx) => {
    if (rep.status !== R.AWAITING_STOCK) {
      const order = await Order.findById(rep.order).session(ctx.session);
      const claim = await ReturnRequest.findById(rep.returnRequest).session(ctx.session);
      const lines = claim.type === 'missing_item' ? rep.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) : stockLines(order, rep.items);
      await inventory.restockReplacement(lines, { type: 'replacement', id: rep._id }, ctx);
    }
    const updated = await Replacement.findOneAndUpdate(
      { _id: rep._id, status: rep.status },
      { $set: { status: R.CANCELLED }, $push: { timeline: { status: R.CANCELLED, note: reason } } },
      { new: true, session: ctx.session },
    );
    if (!updated) throw conflict('Replacement was updated concurrently', 'CONCURRENT_UPDATE');
    publish(updated, ctx);
  });
  logger.info({ replacement: rep.replacementNumber, by: actor?.id, reason }, 'replacement cancelled');
  return Replacement.findById(replacementId).lean();
}

module.exports = { createForClaim, allocateAwaitingStock, ship, syncReplacementShipment, cancel };
