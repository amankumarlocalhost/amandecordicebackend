'use strict';

const Order = require('../orders/order.model');
const { Payment, Refund } = require('../payments/payment.models');
const gateway = require('../payments/razorpay.gateway');
const audit = require('../audit/audit');
const bus = require('../../events/bus');
const logger = require('../../config/logger');
const { getSettings } = require('../settings/settings');
const { enqueue, QUEUES } = require('../../queues');
const { transaction } = require('../../config/database');
const { referenceNumber } = require('../../utils/crypto');
const { conflict, notFound, forbidden, badRequest } = require('../../utils/errors');
const { REFUND_STATUS: RS, PAYMENT_METHOD, PAYMENT_STATUS: PS } = require('../../constants/statuses');
const { PERMISSIONS } = require('../../constants/roles');

/**
 * Refund lifecycle
 *   UPI orders  : pending_approval → approved → processing → processed | failed  (Razorpay refund API)
 *   COD orders  : awaiting_destination → pending_approval → approved → processing → processed (manual payout by staff)
 * Over-refunding is impossible: creating a refund atomically reserves capacity on the order
 * (pricing.refundCommitted ≤ pricing.total); rejection/permanent failure releases it.
 * A refund is reported as completed only after the provider (or an authorised manual payout) confirms it.
 */

function scheduleProcessing(refund, ctx) {
  const run = () => enqueue(QUEUES.PAYMENTS, 'refund.process', { refundId: String(refund._id) }, { jobId: `refund-${refund._id}-${refund.attempts || 0}` });
  if (ctx?.after) ctx.after.push(run);
  else return run();
}

async function createRefund({ order, amount, type, reason, returnRequest, requestedBy, autoApprove = false, destination, idempotencyKey }, ctx = {}) {
  const session = ctx.session;
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Refund amount must be a positive integer (paise)');
  const key = idempotencyKey || `${order._id}:${type}:${returnRequest || '-'}`;
  const existing = await Refund.findOne({ idempotencyKey: key }).session(session || null);
  if (existing) return existing;

  const isCod = order.paymentMethod === PAYMENT_METHOD.COD;
  if (isCod && ![PS.COD_COLLECTED, PS.PARTIALLY_REFUNDED].includes(order.paymentStatus)) throw conflict('Nothing to refund: COD amount was not collected', 'NOTHING_TO_REFUND');
  if (!isCod && ![PS.PAID, PS.PARTIALLY_REFUNDED].includes(order.paymentStatus)) throw conflict('Order has no captured payment to refund', 'NOTHING_TO_REFUND');

  const reserved = await Order.findOneAndUpdate(
    { _id: order._id, $expr: { $lte: [{ $add: ['$pricing.refundCommitted', amount] }, '$pricing.total'] } },
    { $inc: { 'pricing.refundCommitted': amount } },
    { new: true, session },
  );
  if (!reserved) throw conflict('Refund would exceed the amount paid for this order', 'REFUND_EXCEEDS_PAID');

  const payment = await Payment.findOne({ order: order._id }).session(session || null);
  let status;
  if (isCod && !destination) status = RS.AWAITING_DESTINATION;
  else status = autoApprove ? RS.APPROVED : RS.PENDING_APPROVAL;

  const [refund] = await Refund.create(
    [
      {
        refundNumber: referenceNumber('RF'),
        order: order._id,
        payment: payment?._id,
        user: order.user,
        returnRequest,
        amount,
        reason,
        type,
        method: isCod ? (destination?.vpa ? 'manual_upi' : 'manual_bank') : 'original',
        destination,
        status,
        requestedBy: requestedBy ? { type: requestedBy.type, id: requestedBy.id } : { type: 'system' },
        ...(autoApprove ? { approvedBy: { type: 'system' }, approvedAt: new Date() } : {}),
        idempotencyKey: key,
      },
    ],
    session ? { session } : {},
  );
  const publish = () => bus.publish(bus.EVENTS.REFUND_UPDATED, { refundId: refund._id, userId: refund.user, orderId: order._id, status: refund.status, amount });
  if (ctx.after) ctx.after.push(publish);
  else publish();
  if (status === RS.APPROVED && refund.method === 'original') await scheduleProcessing(refund, ctx);
  return refund;
}

function assertApprovalLimit(auth, amount, settings) {
  if (auth.permissions.includes(PERMISSIONS.REFUNDS_APPROVE)) return;
  if (auth.permissions.includes(PERMISSIONS.REFUNDS_APPROVE_LIMITED) && amount <= settings.refunds.limitedApprovalMax) return;
  throw forbidden(`Refunds above ₹${settings.refunds.limitedApprovalMax / 100} need a finance approver`, 'APPROVAL_LIMIT');
}

async function approve(refundId, req) {
  const settings = await getSettings();
  const refund = await Refund.findById(refundId);
  if (!refund) throw notFound('Refund');
  assertApprovalLimit(req.auth, refund.amount, settings);
  const updated = await Refund.findOneAndUpdate(
    { _id: refund._id, status: RS.PENDING_APPROVAL },
    { $set: { status: RS.APPROVED, approvedBy: { type: 'staff', id: req.auth.userId }, approvedAt: new Date() } },
    { new: true },
  );
  if (!updated) throw conflict(`Refund is ${refund.status}, not pending approval`, 'INVALID_STATE');
  await audit.record({ req, action: 'refund.approve', resource: { type: 'refund', id: refund._id }, metadata: { amount: refund.amount } });
  bus.publish(bus.EVENTS.REFUND_UPDATED, { refundId: updated._id, userId: updated.user, orderId: updated.order, status: updated.status, amount: updated.amount });
  if (updated.method === 'original') await scheduleProcessing(updated);
  return updated;
}

async function releaseCapacity(refund, session) {
  await Order.updateOne({ _id: refund.order, 'pricing.refundCommitted': { $gte: refund.amount } }, { $inc: { 'pricing.refundCommitted': -refund.amount } }, { session });
}

async function reject(refundId, reason, req) {
  const updated = await transaction(async ({ session }) => {
    const r = await Refund.findOneAndUpdate(
      { _id: refundId, status: { $in: [RS.PENDING_APPROVAL, RS.AWAITING_DESTINATION] } },
      { $set: { status: RS.REJECTED, failureReason: reason } },
      { new: true, session },
    );
    if (!r) throw conflict('Only pending refunds can be rejected', 'INVALID_STATE');
    await releaseCapacity(r, session);
    return r;
  });
  await audit.record({ req, action: 'refund.reject', resource: { type: 'refund', id: refundId }, metadata: { reason } });
  bus.publish(bus.EVENTS.REFUND_UPDATED, { refundId: updated._id, userId: updated.user, orderId: updated.order, status: updated.status, amount: updated.amount });
  return updated;
}

/** COD refunds: the customer supplies a UPI ID or bank account; staff pay out and record the reference. */
async function provideDestination(refundId, userId, destination) {
  const r = await Refund.findOneAndUpdate(
    { _id: refundId, user: userId, status: RS.AWAITING_DESTINATION },
    { $set: { destination, method: destination.vpa ? 'manual_upi' : 'manual_bank', status: RS.PENDING_APPROVAL } },
    { new: true },
  );
  if (!r) throw notFound('Refund awaiting payout details');
  return r;
}

async function applyProcessed(refund, { providerStatus, manualReference, session } = {}) {
  const done = await Refund.findOneAndUpdate(
    { _id: refund._id, status: { $ne: RS.PROCESSED } },
    { $set: { status: RS.PROCESSED, processedAt: new Date(), ...(providerStatus ? { providerStatus } : {}), ...(manualReference ? { manualReference } : {}) } },
    { new: true, session },
  );
  if (!done) return null; // already processed (duplicate webhook / retry)
  const order = await Order.findOneAndUpdate({ _id: refund.order }, { $inc: { 'pricing.refundedTotal': refund.amount } }, { new: true, session });
  if (refund.payment) await Payment.updateOne({ _id: refund.payment }, { $inc: { refundedAmount: refund.amount } }, { session });
  const fully = order.pricing.refundedTotal >= order.pricing.total;
  await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: fully ? PS.REFUNDED : PS.PARTIALLY_REFUNDED } }, { session });
  return done;
}

async function markProcessed(refund, opts = {}) {
  const done = await transaction(({ session }) => applyProcessed(refund, { ...opts, session }));
  if (done) bus.publish(bus.EVENTS.REFUND_UPDATED, { refundId: done._id, userId: done.user, orderId: done.order, status: RS.PROCESSED, amount: done.amount });
  return done;
}

async function markFailed(refund, reason) {
  const failed = await transaction(async ({ session }) => {
    const r = await Refund.findOneAndUpdate({ _id: refund._id, status: { $in: [RS.APPROVED, RS.PROCESSING] } }, { $set: { status: RS.FAILED, failureReason: reason } }, { new: true, session });
    if (r) await releaseCapacity(r, session);
    return r;
  });
  if (failed) {
    logger.error({ refund: refund.refundNumber, reason }, 'refund failed');
    bus.publish(bus.EVENTS.REFUND_UPDATED, { refundId: failed._id, userId: failed.user, orderId: failed.order, status: RS.FAILED, amount: failed.amount });
  }
  return failed;
}

/**
 * Job: issues a Razorpay refund. Before calling the provider we look for a refund already created
 * with our refund id in its notes, so a retry after a timeout never refunds twice.
 */
async function processRefund({ refundId }) {
  const refund = await Refund.findOneAndUpdate(
    { _id: refundId, method: 'original', status: { $in: [RS.APPROVED, RS.PROCESSING] } },
    { $set: { status: RS.PROCESSING }, $inc: { attempts: 1 } },
    { new: true },
  );
  if (!refund) return;
  const payment = await Payment.findById(refund.payment);
  if (!payment?.providerPaymentId) return markFailed(refund, 'No captured provider payment');

  if (!refund.providerRefundId) {
    const existing = await gateway.fetchRefunds(payment.providerPaymentId);
    const match = (existing?.items || []).find((r) => r.notes?.refundId === String(refund._id));
    if (match) {
      refund.providerRefundId = match.id;
      refund.providerStatus = match.status;
      await Refund.updateOne({ _id: refund._id }, { $set: { providerRefundId: match.id, providerStatus: match.status } });
    } else {
      let created;
      try {
        created = await gateway.refundPayment(payment.providerPaymentId, {
          amount: refund.amount,
          receipt: refund.refundNumber,
          notes: { refundId: String(refund._id), refundNumber: refund.refundNumber },
        });
      } catch (err) {
        if (err.transient) throw err; // retried by the queue; next attempt checks for an existing refund first
        return markFailed(refund, err.message);
      }
      refund.providerRefundId = created.id;
      refund.providerStatus = created.status;
      await Refund.updateOne({ _id: refund._id }, { $set: { providerRefundId: created.id, providerStatus: created.status } });
    }
  }
  if (refund.providerStatus === 'processed') return markProcessed(refund, { providerStatus: 'processed' });
  if (refund.providerStatus === 'failed') return markFailed(refund, 'Provider reported failure');
  // 'pending' → completed by the refund.processed webhook or the reconciliation job.
}

/** Webhook / reconciliation sync from a Razorpay refund entity. */
async function syncFromProvider(entity) {
  const refund =
    (await Refund.findOne({ providerRefundId: entity.id })) || (entity.notes?.refundId ? await Refund.findById(entity.notes.refundId).catch(() => null) : null);
  if (!refund) return 'unknown_refund';
  if (!refund.providerRefundId) await Refund.updateOne({ _id: refund._id }, { $set: { providerRefundId: entity.id } });
  await Refund.updateOne({ _id: refund._id }, { $set: { providerStatus: entity.status } });
  if (entity.status === 'processed') await markProcessed(refund, { providerStatus: 'processed' });
  else if (entity.status === 'failed') await markFailed(refund, 'Provider reported failure');
  return entity.status;
}

/** Job: refunds stuck in processing are re-checked against the provider. */
async function reconcileProcessing() {
  const stuck = await Refund.find({ method: 'original', status: RS.PROCESSING, updatedAt: { $lt: new Date(Date.now() - 10 * 60000) } }).limit(50);
  for (const r of stuck) {
    try {
      if (!r.providerRefundId) {
        await processRefund({ refundId: r._id });
        continue;
      }
      const payment = await Payment.findById(r.payment).lean();
      const list = await gateway.fetchRefunds(payment.providerPaymentId);
      const entity = (list?.items || []).find((x) => x.id === r.providerRefundId);
      if (entity) await syncFromProvider(entity);
      else await Refund.updateOne({ _id: r._id }, { $set: { updatedAt: new Date() } });
    } catch (err) {
      logger.warn({ refund: r.refundNumber, err: err.message }, 'refund reconciliation failed');
    }
  }
}

/** Manual payouts (COD refunds) are confirmed by an authorised staff member with a reference. */
async function markManualProcessed(refundId, reference, req) {
  const settings = await getSettings();
  const refund = await Refund.findById(refundId);
  if (!refund) throw notFound('Refund');
  if (refund.method === 'original') throw badRequest('Provider refunds are confirmed automatically');
  assertApprovalLimit(req.auth, refund.amount, settings);
  if (![RS.APPROVED, RS.PROCESSING].includes(refund.status)) throw conflict('Refund must be approved first', 'INVALID_STATE');
  const done = await markProcessed(refund, { manualReference: reference });
  await audit.record({ req, action: 'refund.manual_processed', resource: { type: 'refund', id: refund._id }, metadata: { reference, amount: refund.amount } });
  return done;
}

function toCustomerView(r) {
  return {
    id: r._id,
    refundNumber: r.refundNumber,
    order: r.order,
    amount: r.amount,
    type: r.type,
    method: r.method,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt,
    processedAt: r.processedAt,
    needsPayoutDetails: r.status === RS.AWAITING_DESTINATION,
  };
}

module.exports = { createRefund, approve, reject, provideDestination, processRefund, syncFromProvider, reconcileProcessing, markManualProcessed, markProcessed, toCustomerView };
