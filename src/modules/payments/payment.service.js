'use strict';

const Order = require('../orders/order.model');
const User = require('../users/user.model');
const { Payment, WebhookEvent } = require('./payment.models');
const gateway = require('./razorpay.gateway');
const orderService = require('../orders/order.service');
const refunds = require('../refunds/refund.service');
const inventory = require('../inventory/inventory.service');
const promotions = require('../promotions/promotion.service');
const audit = require('../audit/audit');
const bus = require('../../events/bus');
const logger = require('../../config/logger');
const { getSettings } = require('../settings/settings');
const { transaction } = require('../../config/database');
const { sha256 } = require('../../utils/crypto');
const { badRequest, conflict, notFound, AppError } = require('../../utils/errors');
const { ORDER_STATUS: S, PAYMENT_STATUS: PS, PAYMENT_METHOD } = require('../../constants/statuses');

const maskVpa = (vpa) => (vpa ? vpa.replace(/^(.{2}).*(@.*)$/, '$1***$2') : undefined);

// ------------------------------------------------------------------ initiation

/** Creates (once) the Razorpay order for a pending UPI order. Safe to call repeatedly. */
async function initiateUpi(order) {
  let payment = await Payment.findOne({ order: order._id });
  if (payment?.providerOrderId) return payment;
  const rp = await gateway.createOrder({ amount: order.pricing.total, receipt: order.orderNumber, notes: { orderId: String(order._id), orderNumber: order.orderNumber } });
  if (rp.amount !== order.pricing.total || rp.currency !== 'INR') throw new AppError(502, 'PAYMENT_PROVIDER_MISMATCH', 'Payment provider returned an unexpected amount');
  payment = await Payment.findOneAndUpdate(
    { order: order._id, providerOrderId: { $exists: false } },
    { $set: { providerOrderId: rp.id } },
    { new: true },
  );
  return payment || Payment.findOne({ order: order._id });
}

async function checkoutPayload(order, payment) {
  const [user, settings] = await Promise.all([User.findById(order.user).select('name email phone').lean(), getSettings()]);
  return {
    provider: 'razorpay',
    razorpayOrderId: payment.providerOrderId,
    amount: payment.amount,
    currency: 'INR',
    expiresAt: order.reservationExpiresAt,
    checkoutOptions: gateway.upiCheckoutOptions({ providerOrderId: payment.providerOrderId, amount: payment.amount, orderNumber: order.orderNumber, customer: user, storeName: settings.store.name }),
  };
}

/** Customer retries payment for a still-pending order (same Razorpay order; reservation unchanged). */
async function retryPayment(userId, orderRef) {
  const order = await orderService.findOwned(userId, orderRef);
  if (order.paymentMethod !== PAYMENT_METHOD.UPI) throw badRequest('This order is not an online payment order');
  if (order.status !== S.PENDING) throw conflict(order.paymentStatus === PS.PAID ? 'This order is already paid' : 'This order can no longer be paid. Please place a new order.', 'NOT_PAYABLE');
  if (order.reservationExpiresAt && order.reservationExpiresAt < new Date()) throw conflict('The payment window has expired. Please place a new order.', 'PAYMENT_WINDOW_EXPIRED');
  const payment = await initiateUpi(order);
  return checkoutPayload(order, payment);
}

// ------------------------------------------------------------------ confirmation

async function recordAttempt(payment, entity) {
  const exists = payment.attempts?.some((a) => a.paymentId === entity.id && a.status === entity.status);
  if (exists) return;
  await Payment.updateOne(
    { _id: payment._id },
    {
      $push: { attempts: { paymentId: entity.id, status: entity.status, method: entity.method, vpaMasked: maskVpa(entity.vpa), errorCode: entity.error_code, errorReason: entity.error_reason || entity.error_description } },
      ...(payment.status === 'created' ? { $set: { status: 'attempted' } } : {}),
    },
  );
}

/**
 * Handles a Razorpay payment entity from any trusted source (signature-verified checkout callback
 * followed by an API fetch, a signature-verified webhook, or reconciliation). Exactly-once:
 * the Payment document is claimed with a conditional update before any side effect.
 */
async function handlePaymentEntity(entity, via) {
  const payment = await Payment.findOne({ providerOrderId: entity.order_id });
  if (!payment) {
    logger.warn({ providerOrderId: entity.order_id }, 'payment for unknown order');
    return { outcome: 'unknown_order' };
  }
  await recordAttempt(payment, entity);

  if (entity.status === 'authorized') {
    try {
      entity = await gateway.capturePayment(entity.id, payment.amount);
    } catch (err) {
      logger.warn({ err: err.message, payment: entity.id }, 'capture failed; will retry via reconciliation');
      await Payment.updateOne({ _id: payment._id, status: { $in: ['created', 'attempted'] } }, { $set: { status: 'authorized' } });
      return { outcome: 'authorized' };
    }
  }

  if (entity.status === 'failed') {
    const res = await Payment.updateOne({ _id: payment._id, status: { $in: ['created', 'attempted', 'authorized'] } }, { $set: { status: 'failed' } });
    if (res.modifiedCount) bus.publish(bus.EVENTS.PAYMENT_FAILED, { orderId: payment.order, userId: payment.user, reason: entity.error_description });
    return { outcome: 'failed' };
  }
  if (entity.status !== 'captured') return { outcome: entity.status };

  if (entity.amount !== payment.amount || entity.currency !== 'INR') {
    await audit.record({ actor: { type: 'system' }, action: 'payment.amount_mismatch', resource: { type: 'payment', id: payment._id }, metadata: { expected: payment.amount, got: entity.amount, currency: entity.currency } });
    throw new AppError(409, 'PAYMENT_AMOUNT_MISMATCH', 'Captured amount does not match the order total');
  }

  const isUpi = entity.method === 'upi';
  try {
    return await confirmCapture(payment, entity, via, { forceRefund: !isUpi });
  } catch (err) {
    if (err.code !== 'OUT_OF_STOCK') throw err;
    const { supportsTransactions } = require('../../config/database');
    if (!supportsTransactions()) await Payment.updateOne({ _id: payment._id }, { $set: { status: payment.status } }); // undo the claim
    // Payment arrived but stock is gone (hold expired and units sold): cancel and refund in full.
    return confirmCapture(payment, entity, via, { forceRefund: true, stockConflict: true });
  }
}

async function confirmCapture(payment, entity, via, { forceRefund = false, stockConflict = false }) {
  const result = await transaction(async (ctx) => {
    const { session } = ctx;
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: { $ne: 'captured' } },
      { $set: { status: 'captured', providerPaymentId: entity.id, capturedAt: new Date((entity.created_at || Date.now() / 1000) * 1000), verifiedVia: via } },
      { new: true, session },
    );
    if (!claimed) return { outcome: 'duplicate' };

    let order = await Order.findById(payment.order).session(session);
    const actor = { type: 'system' };

    if (order.status === S.PENDING && !forceRefund) {
      const committed = await inventory.commitReservation({ type: 'order', id: order._id }, ctx);
      if (!committed) await inventory.commitDirect(order.items, { type: 'order', id: order._id }, ctx);
      order = await orderService.transition(order, S.CONFIRMED, { actor, note: `UPI payment ${entity.id} captured`, set: { paymentStatus: PS.PAID }, ctx });
      await orderService.recordConfirmedOrder(order, ctx);
      await orderService.recordRevenue(order.user, order.pricing.total, ctx);
      ctx.after.push(() => bus.publish(bus.EVENTS.PAYMENT_SUCCEEDED, { orderId: order._id, userId: order.user, orderNumber: order.orderNumber, amount: order.pricing.total }));
      return { outcome: 'confirmed', order };
    }

    // Paid, but the order cannot be fulfilled (cancelled/expired, stock conflict, or non-UPI method).
    const reason = stockConflict ? 'Item went out of stock before payment completed' : entity.method !== 'upi' ? 'Only UPI payments are accepted' : 'Payment received after the order was cancelled';
    if (order.status === S.PENDING) {
      await inventory.releaseReservation({ type: 'order', id: order._id }, 'payment_unusable', ctx);
      await promotions.releaseCoupon(order._id, ctx);
      order = await orderService.transition(order, S.CANCELLED, { actor, note: reason, set: { cancelReason: reason, paymentStatus: PS.PAID, 'flags.stockConflict': stockConflict }, ctx });
    } else {
      order = await Order.findOneAndUpdate({ _id: order._id }, { $set: { paymentStatus: PS.PAID } }, { new: true, session });
    }
    const type = entity.method !== 'upi' ? 'non_upi_payment' : 'late_payment';
    await refunds.createRefund({ order, amount: payment.amount, type, reason, requestedBy: actor, autoApprove: true, idempotencyKey: `${order._id}:${type}:${entity.id}` }, ctx);
    return { outcome: 'refunding', order };
  });
  if (result.outcome !== 'duplicate') {
    await audit.record({ actor: { type: 'system' }, action: `payment.${result.outcome}`, resource: { type: 'order', id: payment.order }, metadata: { providerPaymentId: entity.id, via, method: entity.method } });
  }
  return result;
}

/** Checkout success callback. The signature proves the IDs came from Razorpay; status is then fetched server-side. */
async function verifyCheckout(userId, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) {
  const payment = await Payment.findOne({ providerOrderId: orderId, user: userId });
  if (!payment) throw notFound('Payment');
  if (!gateway.verifyPaymentSignature({ orderId, paymentId, signature })) {
    await audit.record({ actor: { type: 'customer', id: userId }, action: 'payment.signature_invalid', resource: { type: 'payment', id: payment._id } });
    throw badRequest('Payment verification failed', undefined, 'SIGNATURE_INVALID');
  }
  const entity = await gateway.fetchPayment(paymentId);
  if (entity.order_id !== orderId) throw badRequest('Payment does not belong to this order', undefined, 'SIGNATURE_INVALID');
  const result = await handlePaymentEntity(entity, 'signature');
  const order = await Order.findById(payment.order).lean();
  return { outcome: result.outcome, order: orderService.toCustomerView(order) };
}

// ------------------------------------------------------------------ webhooks

/** Claims a webhook event id; returns false when it was already processed (or is in flight). */
async function claimEvent(eventId, event) {
  try {
    await WebhookEvent.create({ provider: 'razorpay', eventId, event, status: 'processing' });
    return true;
  } catch (err) {
    if (err.code !== 11000) throw err;
    const retried = await WebhookEvent.findOneAndUpdate(
      { provider: 'razorpay', eventId, $or: [{ status: 'failed' }, { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 5 * 60000) } }] },
      { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    );
    return Boolean(retried);
  }
}

async function handleWebhook(rawBody, headers) {
  const signature = headers['x-razorpay-signature'];
  if (!gateway.verifyWebhookSignature(rawBody, signature)) throw badRequest('Invalid webhook signature', undefined, 'SIGNATURE_INVALID');
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON');
  }
  const eventId = headers['x-razorpay-event-id'] || sha256(rawBody);
  if (!(await claimEvent(eventId, body.event))) return { duplicate: true };

  try {
    let outcome = 'ignored';
    const p = body.payload || {};
    switch (body.event) {
      case 'payment.authorized':
      case 'payment.captured':
      case 'payment.failed':
      case 'order.paid':
        if (p.payment?.entity) outcome = (await handlePaymentEntity(p.payment.entity, 'webhook')).outcome;
        break;
      case 'refund.created':
      case 'refund.processed':
      case 'refund.failed':
        if (p.refund?.entity) outcome = await refunds.syncFromProvider(p.refund.entity);
        break;
      default:
        break;
    }
    await WebhookEvent.updateOne({ provider: 'razorpay', eventId }, { $set: { status: outcome === 'ignored' ? 'ignored' : 'processed', processedAt: new Date() } });
    return { duplicate: false, outcome };
  } catch (err) {
    await WebhookEvent.updateOne({ provider: 'razorpay', eventId }, { $set: { status: 'failed', error: err.message } });
    throw err;
  }
}

// ------------------------------------------------------------------ reconciliation & expiry (jobs)

/** Pulls the true state of pending UPI orders from Razorpay; expires unpaid orders past their hold. */
async function reconcilePending({ olderThanMs = 2 * 60000, limit = 100 } = {}) {
  const pending = await Order.find({ status: S.PENDING, paymentMethod: PAYMENT_METHOD.UPI, createdAt: { $lt: new Date(Date.now() - olderThanMs) } })
    .select('_id reservationExpiresAt')
    .limit(limit)
    .lean();
  const summary = { checked: 0, confirmed: 0, expired: 0, errors: 0 };
  for (const o of pending) {
    summary.checked++;
    try {
      const payment = await Payment.findOne({ order: o._id });
      if (payment?.providerOrderId) {
        const list = await gateway.fetchOrderPayments(payment.providerOrderId);
        const items = (list?.items || []).sort((a, b) => (a.status === 'captured' ? -1 : 1) - (b.status === 'captured' ? -1 : 1));
        for (const entity of items) {
          const r = await handlePaymentEntity(entity, 'reconciliation');
          if (r.outcome === 'confirmed') summary.confirmed++;
        }
        await Payment.updateOne({ _id: payment._id }, { $set: { lastReconciledAt: new Date() } });
      }
      const fresh = await Order.findById(o._id).select('status reservationExpiresAt').lean();
      if (fresh.status === S.PENDING && fresh.reservationExpiresAt && fresh.reservationExpiresAt < new Date()) {
        await orderService.cancelOrder(o._id, { actor: { type: 'system' }, reason: 'Payment not completed in time' });
        summary.expired++;
      }
    } catch (err) {
      summary.errors++;
      logger.warn({ order: String(o._id), err: err.message }, 'reconciliation failed');
    }
  }
  return summary;
}

// ------------------------------------------------------------------ COD

async function markCodCollected(orderId, { amount, actor, req }) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  if (order.paymentMethod !== PAYMENT_METHOD.COD) throw badRequest('Not a COD order');
  if (amount !== order.pricing.total) throw badRequest(`Collected amount must equal the order total (${order.pricing.total} paise)`, undefined, 'AMOUNT_MISMATCH');
  const updated = await transaction(async (ctx) => {
    let o = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: PS.COD_DUE, status: { $in: [S.SHIPPED, S.OUT_FOR_DELIVERY, S.DELIVERED] } },
      { $set: { paymentStatus: PS.COD_COLLECTED, 'cod.collectedAt': new Date(), 'cod.collectedBy': actor.id, 'cod.collectedAmount': amount } },
      { new: true, session: ctx.session },
    );
    if (!o) throw conflict('COD can be marked collected only once, on a shipped or delivered order', 'INVALID_STATE');
    if (o.status !== S.DELIVERED) o = await orderService.transition(o, S.DELIVERED, { actor, note: 'Delivered, cash collected', ctx });
    await Payment.updateOne({ order: o._id }, { $set: { status: 'cod_collected', capturedAt: new Date() } }, { session: ctx.session });
    await orderService.recordRevenue(o.user, amount, ctx);
    return o;
  });
  await audit.record({ req, actor, action: 'payment.cod_collected', resource: { type: 'order', id: order._id }, metadata: { amount } });
  return updated;
}

async function settleCod(orderIds, remittanceRef, req) {
  const res = await Order.updateMany(
    { _id: { $in: orderIds }, paymentMethod: PAYMENT_METHOD.COD, paymentStatus: { $in: [PS.COD_COLLECTED, PS.PARTIALLY_REFUNDED, PS.REFUNDED] }, 'cod.collectedAt': { $ne: null }, 'cod.settledAt': null },
    { $set: { 'cod.settledAt': new Date(), 'cod.remittanceRef': remittanceRef } },
  );
  await audit.record({ req, action: 'payment.cod_settled', resource: { type: 'cod_remittance', id: remittanceRef }, metadata: { orders: orderIds.length, settled: res.modifiedCount } });
  return { settled: res.modifiedCount };
}

module.exports = { initiateUpi, checkoutPayload, retryPayment, verifyCheckout, handlePaymentEntity, handleWebhook, reconcilePending, markCodCollected, settleCod };
