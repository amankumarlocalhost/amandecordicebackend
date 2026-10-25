'use strict';

const ReturnRequest = require('./return.model');
const Order = require('../orders/order.model');
const orderService = require('../orders/order.service');
const inventory = require('../inventory/inventory.service');
const refunds = require('../refunds/refund.service');
const replacements = require('../replacements/replacement.service');
const media = require('../media/media');
const audit = require('../audit/audit');
const bus = require('../../events/bus');
const { getSettings } = require('../settings/settings');
const { transaction } = require('../../config/database');
const { referenceNumber } = require('../../utils/crypto');
const { addDays } = require('../../utils/common');
const { badRequest, conflict, notFound } = require('../../utils/errors');
const { RETURN_STATUS: RS, RETURN_TRANSITIONS, OPEN_RETURN_STATUSES, RETURN_REASONS: RR, DAMAGE_REASONS, ORDER_STATUS: S } = require('../../constants/statuses');
const { PERMISSIONS } = require('../../constants/roles');

/** Transit problems must be reported within the short damage window; others use the item's return window. */
const TRANSIT_REASONS = new Set([RR.BROKEN_GLASS, RR.CHIPPED, RR.SHIPPING_DAMAGE, RR.MISSING_ITEM]);
const AUTO_ELIGIBLE_REASONS = new Set([...DAMAGE_REASONS, RR.MISSING_ITEM, RR.WRONG_ITEM, RR.WRONG_COLOR]);
const PHOTO_REASONS = new Set([...DAMAGE_REASONS, RR.WRONG_ITEM, RR.WRONG_COLOR, RR.NOT_AS_DESCRIBED]);
const DELIVERED_STATES = [S.DELIVERED, S.COMPLETED, S.RETURN_REQUESTED, S.REPLACEMENT_PROCESSING];

function unitValue(item) {
  return Math.floor(item.total / item.quantity);
}

function itemEligibility(order, item, settings, now = new Date()) {
  const deliveredAt = order.deliveredAt;
  const windowDays = item.returnPolicy?.windowDays ?? order.policySnapshot?.returnWindowDays ?? settings.returns.defaultWindowDays;
  const damageDays = order.policySnapshot?.damageReportWindowDays ?? settings.returns.damageReportWindowDays;
  const generalDeadline = deliveredAt ? addDays(deliveredAt, windowDays) : null;
  const damageDeadline = deliveredAt ? addDays(deliveredAt, damageDays) : null;
  const claimable = item.quantity - (item.claimedQty || 0);
  const allowChangeOfMind = (order.policySnapshot?.allowChangeOfMind ?? settings.returns.allowChangeOfMind) && !item.returnPolicy?.replacementOnly;

  const reasons = [];
  if (deliveredAt && item.returnPolicy?.returnable !== false && claimable > 0) {
    if (now <= damageDeadline) reasons.push(...TRANSIT_REASONS);
    if (now <= generalDeadline) {
      reasons.push(RR.WRONG_ITEM, RR.WRONG_COLOR, RR.NOT_AS_DESCRIBED, RR.DEFECTIVE);
      if (allowChangeOfMind) reasons.push(RR.CHANGE_OF_MIND);
    }
  }
  let blockedReason = null;
  if (!deliveredAt) blockedReason = 'Order has not been delivered yet';
  else if (item.returnPolicy?.returnable === false) blockedReason = 'This item is not returnable';
  else if (claimable <= 0) blockedReason = 'A request already covers every unit of this item';
  else if (!reasons.length) blockedReason = 'The return window for this item has closed';

  return {
    orderItemId: item._id,
    sku: item.sku,
    name: item.name,
    quantity: item.quantity,
    claimableQty: Math.max(0, claimable),
    unitValue: unitValue(item),
    eligible: reasons.length > 0,
    blockedReason,
    allowedReasons: [...new Set(reasons)],
    allowedResolutions: item.returnPolicy?.replacementOnly ? ['replacement'] : ['replacement', 'refund'],
    deadlines: { damageReport: damageDeadline, return: generalDeadline },
    isBundle: item.bundleComponents?.length > 0,
    components: item.bundleComponents,
  };
}

async function eligibility(userId, orderRef) {
  const order = await orderService.findOwned(userId, orderRef, { lean: true });
  const settings = await getSettings();
  const open = await ReturnRequest.find({ order: order._id, status: { $in: OPEN_RETURN_STATUSES } }).select('requestNumber status type items').lean();
  return {
    orderId: order._id,
    orderNumber: order.orderNumber,
    status: order.status,
    deliveredAt: order.deliveredAt,
    orderEligible: DELIVERED_STATES.includes(order.status),
    items: order.items.map((i) => itemEligibility(order, i, settings)),
    openRequests: open,
    policy: { requirePhotosForDamage: settings.returns.requirePhotosForDamage, allowChangeOfMind: settings.returns.allowChangeOfMind, damageReportWindowDays: settings.returns.damageReportWindowDays },
  };
}

/** Policy engine: decides whether a claim can be approved automatically, and records why not. */
async function autoApprovalDecision({ userId, order, reason, claimValue, photos, settings }) {
  const reasons = [];
  if (!settings.returns.autoApproveEnabled) reasons.push('auto_approval_disabled');
  if (!AUTO_ELIGIBLE_REASONS.has(reason)) reasons.push('reason_requires_review');
  if (claimValue > settings.returns.autoApproveMaxValue) reasons.push('claim_value_above_limit');
  if (PHOTO_REASONS.has(reason) && photos.length === 0) reasons.push('no_photos');
  if (order.flags?.highValue) reasons.push('high_value_order');
  const recent = await ReturnRequest.countDocuments({ user: userId, createdAt: { $gte: addDays(new Date(), -90) }, status: { $nin: [RS.CANCELLED] } });
  const risk = [];
  if (recent >= settings.returns.maxClaimsPer90Days) {
    reasons.push('frequent_claims');
    risk.push(`claims_last_90d:${recent}`);
  }
  return { auto: reasons.length === 0, reviewReasons: reasons, riskFlags: risk };
}

function publish(claim, ctx, extra = {}) {
  const messages = {
    [RS.APPROVED]: 'Your request has been approved.',
    [RS.AWAITING_REVIEW]: 'Your request is being reviewed by our team. We usually respond within 24 hours.',
    [RS.REJECTED]: `Your request was not approved. ${claim.resolution?.note || ''}`.trim(),
    [RS.PICKUP_SCHEDULED]: 'A pickup has been scheduled. Please pack the item securely.',
    [RS.ITEM_RECEIVED]: 'We received the returned item and will inspect it shortly.',
    [RS.RESOLVED]: claim.resolution?.type === 'replacement' ? 'A replacement is on its way.' : 'Your refund has been initiated.',
    [RS.CLOSED]: 'Your request is closed.',
    [RS.CANCELLED]: 'Your request was cancelled.',
  };
  const fn = () =>
    bus.publish(bus.EVENTS.RETURN_UPDATED, { returnId: claim._id, userId: claim.user, requestNumber: claim.requestNumber, status: claim.status, message: messages[claim.status] || `Status: ${claim.status}`, ...extra });
  if (ctx?.after) ctx.after.push(fn);
  else fn();
}

async function setStatus(claim, to, { actor, note, set = {}, ctx }) {
  if (!(RETURN_TRANSITIONS[claim.status] || []).includes(to)) throw conflict(`Request cannot move from ${claim.status} to ${to}`, 'INVALID_TRANSITION');
  const updated = await ReturnRequest.findOneAndUpdate(
    { _id: claim._id, status: claim.status },
    { $set: { status: to, ...set }, $push: { timeline: { status: to, by: actor ? { type: actor.type, id: actor.id } : { type: 'system' }, note } } },
    { new: true, session: ctx?.session },
  );
  if (!updated) throw conflict('The request was updated by someone else', 'CONCURRENT_UPDATE');
  return updated;
}

/** Releases claimed quantities so the units can be claimed again (rejection / cancellation). */
async function releaseClaim(claim, session) {
  for (const it of claim.items) {
    await Order.updateOne({ _id: claim.order, items: { $elemMatch: { _id: it.orderItemId, claimedQty: { $gte: it.quantity } } } }, { $inc: { 'items.$.claimedQty': -it.quantity } }, { session });
  }
  const stillOpen = await ReturnRequest.exists({ order: claim.order, _id: { $ne: claim._id }, status: { $in: OPEN_RETURN_STATUSES } }).session(session || null);
  if (!stillOpen) {
    const order = await Order.findById(claim.order).session(session || null);
    if (order.status === S.RETURN_REQUESTED) await orderService.transition(order, S.DELIVERED, { note: 'No open return requests', ctx: { session } });
  }
}

function refundAmountFor(claim, order) {
  const remaining = order.pricing.total - order.pricing.refundCommitted;
  return Math.min(claim.claimValue, remaining);
}

/** Executes the approved resolution: replacement shipment or refund. */
async function executeResolution(claim, { resolution, amount, actor, ctx, approveRefund }) {
  const order = await Order.findById(claim.order).session(ctx.session || null);
  if (resolution === 'replacement') {
    const rep = await replacements.createForClaim(claim, ctx);
    return setStatus(claim, RS.RESOLVED, { actor, note: `Replacement ${rep.replacementNumber}`, set: { replacement: rep._id, resolution: { type: 'replacement', decidedBy: actor, decidedAt: new Date() } }, ctx });
  }
  const value = amount ?? refundAmountFor(claim, order);
  if (value <= 0) throw conflict('Nothing left to refund on this order', 'NOTHING_TO_REFUND');
  const refund = await refunds.createRefund(
    { order, amount: value, type: DAMAGE_REASONS.includes(claim.reason) ? 'damage' : claim.reason === RR.MISSING_ITEM ? 'missing_item' : 'return', reason: `${claim.requestNumber}: ${claim.reason}`, returnRequest: claim._id, requestedBy: actor, autoApprove: approveRefund, idempotencyKey: `${claim._id}:refund` },
    ctx,
  );
  const type = value < claim.claimValue ? 'partial_refund' : 'refund';
  return setStatus(claim, RS.RESOLVED, { actor, note: `Refund ${refund.refundNumber}`, set: { refund: refund._id, resolution: { type, amount: value, decidedBy: actor, decidedAt: new Date() } }, ctx });
}

/**
 * Creates a return / replacement / missing-item claim.
 * Duplicate protection: units are claimed with a conditional array update (claimedQty + q ≤ quantity),
 * and an optional idempotency key makes retried submissions return the original request.
 */
async function createRequest(userId, input, { source = 'customer', actor } = {}) {
  const { orderId, type, reason, items, description, photoIds = [], preferredResolution, idempotencyKey } = input;
  if (idempotencyKey) {
    const prior = await ReturnRequest.findOne({ user: userId, idempotencyKey }).lean();
    if (prior) return { request: prior, duplicate: true };
  }
  const settings = await getSettings();
  const order = await orderService.findOwned(userId, orderId);
  if (!DELIVERED_STATES.includes(order.status)) throw conflict('Returns and replacements are available after delivery. To stop an undelivered order, cancel it instead.', 'NOT_DELIVERED');

  const resolution = preferredResolution || (type === 'return' ? 'refund' : 'replacement');
  const claimItems = [];
  for (const req of items) {
    const item = order.items.id(req.orderItemId);
    if (!item) throw badRequest('Item not found in this order');
    const elig = itemEligibility(order, item, settings);
    const itemReason = req.reason || reason;
    if (!elig.eligible) throw conflict(`${item.name}: ${elig.blockedReason}`, 'NOT_ELIGIBLE');
    if (!elig.allowedReasons.includes(itemReason)) throw conflict(`${item.name}: "${itemReason.replace(/_/g, ' ')}" can no longer be reported for this item`, 'REASON_NOT_ALLOWED', { allowedReasons: elig.allowedReasons });
    if (req.quantity > elig.claimableQty) throw conflict(`${item.name}: only ${elig.claimableQty} unit(s) can be claimed`, 'QUANTITY_EXCEEDS');
    if (!elig.allowedResolutions.includes(resolution)) throw conflict(`${item.name} can only be replaced, not refunded`, 'RESOLUTION_NOT_ALLOWED');
    let missingComponents = [];
    if (type === 'missing_item' && req.missingComponents?.length) {
      if (!item.bundleComponents?.length) throw badRequest('Missing components can only be reported for sets/bundles');
      for (const mc of req.missingComponents) {
        const comp = item.bundleComponents.find((c) => c.sku === mc.sku);
        if (!comp || mc.quantity > comp.quantity * req.quantity) throw badRequest(`Invalid missing component ${mc.sku}`);
        missingComponents.push({ sku: comp.sku, name: comp.name, quantity: mc.quantity });
      }
    }
    claimItems.push({ orderItemId: item._id, sku: item.sku, name: item.name, quantity: req.quantity, unitValue: elig.unitValue, reason: itemReason, missingComponents });
  }
  if (!claimItems.length) throw badRequest('Select at least one item');

  const photos = await media.resolveOwnedUploads(photoIds, userId, ['return', 'chat']);
  if (settings.returns.requirePhotosForDamage && DAMAGE_REASONS.includes(reason) && photos.length === 0) {
    throw badRequest('Please attach at least one photo or video showing the damage', undefined, 'PHOTOS_REQUIRED');
  }

  const claimValue = claimItems.reduce((a, i) => a + i.unitValue * i.quantity, 0);
  const decision = await autoApprovalDecision({ userId, order, reason, claimValue, photos, settings });
  const pickupRequired = DAMAGE_REASONS.includes(reason) || reason === RR.MISSING_ITEM ? settings.returns.pickupRequiredForDamage : settings.returns.pickupRequiredForReturn;
  const who = actor || { type: source === 'ai' ? 'ai' : 'customer', id: userId };

  const result = await transaction(async (ctx) => {
    for (const ci of claimItems) {
      const item = order.items.id(ci.orderItemId);
      // The guard lives in the query filter (not arrayFilters): Mongoose timestamps make modifiedCount
      // non-zero on every matched update, so only matchedCount reliably signals a failed guard.
      const r = await Order.updateOne(
        { _id: order._id, items: { $elemMatch: { _id: ci.orderItemId, claimedQty: { $lte: item.quantity - ci.quantity } } } },
        { $inc: { 'items.$.claimedQty': ci.quantity } },
        { session: ctx.session },
      );
      if (!r.matchedCount) throw conflict(`${ci.name}: these units are already part of another request`, 'DUPLICATE_CLAIM');
    }
    const [claim] = await ReturnRequest.create(
      [
        {
          requestNumber: referenceNumber(type === 'return' ? 'RET' : 'RPR'),
          order: order._id,
          orderNumber: order.orderNumber,
          user: userId,
          type,
          preferredResolution: resolution,
          reason,
          description,
          items: claimItems,
          claimValue,
          photos: photos.map(media.toRef),
          status: RS.REQUESTED,
          source,
          reviewReasons: decision.reviewReasons,
          riskFlags: decision.riskFlags,
          policySnapshot: {
            windowDays: order.policySnapshot?.returnWindowDays,
            damageWindowDays: order.policySnapshot?.damageReportWindowDays,
            requirePhotos: settings.returns.requirePhotosForDamage,
            pickupRequired,
            allowChangeOfMind: order.policySnapshot?.allowChangeOfMind,
          },
          pickup: { required: pickupRequired },
          timeline: [{ status: RS.REQUESTED, by: { type: who.type, id: who.id }, note: `Created via ${source}` }],
          idempotencyKey,
        },
      ],
      { session: ctx.session },
    );
    const fresh = await Order.findById(order._id).session(ctx.session);
    if (orderService.canTransition(fresh.status, S.RETURN_REQUESTED) && fresh.status !== S.REPLACEMENT_PROCESSING) {
      await orderService.transition(fresh, S.RETURN_REQUESTED, { actor: who, note: claim.requestNumber, ctx });
    }

    if (!decision.auto) {
      const c = await setStatus(claim, RS.AWAITING_REVIEW, { note: `Manual review: ${decision.reviewReasons.join(', ')}`, ctx });
      publish(c, ctx, { needsReview: true, reason: decision.reviewReasons.join(', ') });
      return c;
    }
    let c = await setStatus(claim, RS.APPROVED, { note: 'Auto-approved by policy', set: { autoApproved: true }, ctx });
    if (pickupRequired) {
      publish(c, ctx);
      return c; // staff schedule the pickup; resolution happens after inspection
    }
    c = await executeResolution(c, { resolution, actor: { type: 'system' }, ctx, approveRefund: true });
    publish(c, ctx);
    return c;
  });

  await audit.record({ actor: who.type === 'ai' ? { type: 'ai', onBehalfOf: userId } : who, action: 'return.create', resource: { type: 'return', id: result._id }, metadata: { requestNumber: result.requestNumber, type, reason, claimValue, autoApproved: result.autoApproved, source } });
  return { request: result.toObject ? result.toObject() : result, duplicate: false };
}

async function cancelByCustomer(userId, id) {
  const claim = await ReturnRequest.findOne({ _id: id, user: userId });
  if (!claim) throw notFound('Request');
  if (![RS.REQUESTED, RS.AWAITING_REVIEW].includes(claim.status)) throw conflict('This request can no longer be cancelled', 'INVALID_STATE');
  return transaction(async (ctx) => {
    const c = await setStatus(claim, RS.CANCELLED, { actor: { type: 'customer', id: userId }, note: 'Cancelled by customer', ctx });
    await releaseClaim(c, ctx.session);
    publish(c, ctx);
    return c;
  });
}

// ------------------------------------------------------------------ staff workflow

function staffActor(req) {
  return { type: 'staff', id: req.auth.userId };
}

async function review(id, { decision, resolution, amount, note }, req) {
  const claim = await ReturnRequest.findById(id);
  if (!claim) throw notFound('Request');
  const actor = staffActor(req);
  const settings = await getSettings();
  const result = await transaction(async (ctx) => {
    if (decision === 'reject') {
      const c = await setStatus(claim, RS.REJECTED, { actor, note, set: { resolution: { type: 'rejected', note, decidedBy: actor, decidedAt: new Date() } }, ctx });
      await releaseClaim(c, ctx.session);
      publish(c, ctx);
      return c;
    }
    let c = await setStatus(claim, RS.APPROVED, { actor, note, set: { preferredResolution: resolution || claim.preferredResolution }, ctx });
    if (claim.pickup?.required) {
      publish(c, ctx);
      return c;
    }
    const canApprove = req.auth.permissions.includes(PERMISSIONS.REFUNDS_APPROVE) || (req.auth.permissions.includes(PERMISSIONS.REFUNDS_APPROVE_LIMITED) && (amount ?? claim.claimValue) <= settings.refunds.limitedApprovalMax);
    c = await executeResolution(c, { resolution: resolution || claim.preferredResolution, amount, actor, ctx, approveRefund: canApprove });
    publish(c, ctx);
    return c;
  });
  await audit.record({ req, action: `return.${decision}`, resource: { type: 'return', id }, metadata: { resolution, amount, note } });
  return result;
}

async function schedulePickup(id, pickup, req) {
  const claim = await ReturnRequest.findById(id);
  if (!claim) throw notFound('Request');
  const c = await setStatus(claim, RS.PICKUP_SCHEDULED, { actor: staffActor(req), note: pickup.instructions, set: { pickup: { ...claim.pickup?.toObject?.(), ...pickup, required: true } } });
  publish(c);
  return c;
}

async function markReceived(id, req) {
  const claim = await ReturnRequest.findById(id);
  if (!claim) throw notFound('Request');
  const order = await Order.findById(claim.order).lean();
  return transaction(async (ctx) => {
    const c = await setStatus(claim, RS.ITEM_RECEIVED, { actor: staffActor(req), ctx });
    const lines = claim.items.map((i) => {
      const oi = order.items.find((x) => String(x._id) === String(i.orderItemId));
      return { sku: i.sku, quantity: i.quantity, bundleComponents: oi?.bundleComponents || [] };
    });
    // Returned fragile goods are never sellable until inspected.
    await inventory.quarantine(lines, { type: 'return', id: claim._id }, { session: ctx.session, reason: claim.reason });
    publish(c, ctx);
    return c;
  });
}

async function inspect(id, { result, notes, dispositions, resolution, amount }, req) {
  const claim = await ReturnRequest.findById(id);
  if (!claim) throw notFound('Request');
  if (claim.status !== RS.ITEM_RECEIVED) throw conflict('Mark the item received before inspection', 'INVALID_STATE');
  const actor = staffActor(req);
  const settings = await getSettings();
  const out = await transaction(async (ctx) => {
    for (const d of dispositions) await inventory.disposition(d.sku, d.quantity, d.decision, { type: 'return', id: String(claim._id) }, { type: 'staff', id: req.auth.userId }, { session: ctx.session, reason: notes });
    let c = await setStatus(claim, RS.INSPECTION, { actor, note: notes, set: { inspection: { result, notes, dispositions, by: req.auth.userId, at: new Date() } }, ctx });
    if (result === 'not_confirmed') {
      c = await setStatus(c, RS.REJECTED, { actor, note: notes || 'Inspection did not confirm the issue', set: { resolution: { type: 'rejected', note: notes, decidedBy: actor, decidedAt: new Date() } }, ctx });
      await releaseClaim(c, ctx.session);
      publish(c, ctx);
      return c;
    }
    const canApprove = req.auth.permissions.includes(PERMISSIONS.REFUNDS_APPROVE) || (req.auth.permissions.includes(PERMISSIONS.REFUNDS_APPROVE_LIMITED) && (amount ?? claim.claimValue) <= settings.refunds.limitedApprovalMax);
    c = await executeResolution(c, { resolution: resolution || claim.preferredResolution, amount, actor, ctx, approveRefund: canApprove });
    publish(c, ctx);
    return c;
  });
  await audit.record({ req, action: 'return.inspect', resource: { type: 'return', id }, metadata: { result, dispositions, resolution, amount } });
  return out;
}

async function close(id, req) {
  const claim = await ReturnRequest.findById(id);
  if (!claim) throw notFound('Request');
  const c = await setStatus(claim, RS.CLOSED, { actor: staffActor(req) });
  publish(c);
  return c;
}

/** Called when the replacement shipment is delivered. */
async function closeAfterReplacement(returnRequestId, actor) {
  const claim = await ReturnRequest.findById(returnRequestId);
  if (!claim || claim.status !== RS.RESOLVED) return;
  const c = await setStatus(claim, RS.CLOSED, { actor, note: 'Replacement delivered' });
  publish(c);
  const order = await Order.findById(claim.order);
  const open = await ReturnRequest.exists({ order: order._id, status: { $in: OPEN_RETURN_STATUSES } });
  if (!open && orderService.canTransition(order.status, S.COMPLETED)) await orderService.transition(order, S.COMPLETED, { actor, note: 'Replacement delivered' });
}

function toCustomerView(r) {
  return {
    id: r._id,
    requestNumber: r.requestNumber,
    orderId: r.order,
    orderNumber: r.orderNumber,
    type: r.type,
    reason: r.reason,
    preferredResolution: r.preferredResolution,
    status: r.status,
    items: r.items.map(({ orderItemId, sku, name, quantity, missingComponents }) => ({ orderItemId, sku, name, quantity, missingComponents })),
    claimValue: r.claimValue,
    photos: r.photos?.map((x) => ({ kind: x.kind || 'image', url: x.url, thumbUrl: x.thumbUrl, posterUrl: x.posterUrl })),
    pickup: r.pickup?.required ? { scheduledAt: r.pickup.scheduledAt, instructions: r.pickup.instructions } : undefined,
    resolution: r.resolution?.type ? { type: r.resolution.type, amount: r.resolution.amount, note: r.resolution.note } : undefined,
    refund: r.refund,
    replacement: r.replacement,
    timeline: (r.timeline || []).map((t) => ({ status: t.status, at: t.at })),
    createdAt: r.createdAt,
  };
}

module.exports = { eligibility, itemEligibility, createRequest, cancelByCustomer, review, schedulePickup, markReceived, inspect, close, closeAfterReplacement, toCustomerView };
