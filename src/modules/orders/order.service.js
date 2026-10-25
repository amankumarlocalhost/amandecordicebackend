'use strict';

const Order = require('./order.model');
const User = require('../users/user.model');
const inventory = require('../inventory/inventory.service');
const promotions = require('../promotions/promotion.service');
const audit = require('../audit/audit');
const bus = require('../../events/bus');
const { transaction } = require('../../config/database');
const { ORDER_STATUS: S, ORDER_TRANSITIONS, CUSTOMER_CANCELLABLE, PAYMENT_STATUS: PS, PAYMENT_METHOD } = require('../../constants/statuses');
const { conflict, notFound, forbidden } = require('../../utils/errors');
const { isObjectId } = require('../../utils/common');

const TIMESTAMP_FIELDS = { [S.CONFIRMED]: 'confirmedAt', [S.SHIPPED]: 'shippedAt', [S.DELIVERED]: 'deliveredAt', [S.CANCELLED]: 'cancelledAt' };

function canTransition(from, to) {
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}

/**
 * Validated, race-safe status change: the update is conditional on the status we read, so two
 * concurrent writers cannot both move the order. Events are published after commit.
 */
async function transition(order, to, { actor = { type: 'system' }, note, set = {}, ctx } = {}) {
  const from = order.status;
  if (!canTransition(from, to)) throw conflict(`Order cannot move from ${from} to ${to}`, 'INVALID_TRANSITION', { from, to });
  const stamp = TIMESTAMP_FIELDS[to];
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: from },
    {
      $set: { status: to, ...(stamp && !order[stamp] ? { [stamp]: new Date() } : {}), ...set },
      $push: { statusHistory: { from, to, by: { type: actor.type, id: actor.id }, note } },
    },
    { new: true, session: ctx?.session },
  );
  if (!updated) throw conflict('The order was updated by someone else. Please refresh.', 'CONCURRENT_UPDATE');
  const publish = () => bus.publish(bus.EVENTS.ORDER_STATUS_CHANGED, { orderId: updated._id, userId: updated.user, orderNumber: updated.orderNumber, from, to });
  if (ctx?.after) ctx.after.push(publish);
  else publish();
  return updated;
}

/** Customer-safe lookup: by id or order number, always scoped to the owner. */
async function findOwned(userId, ref, { lean = false } = {}) {
  const filter = isObjectId(ref) ? { _id: ref } : { orderNumber: String(ref).toUpperCase() };
  let q = Order.findOne({ ...filter, user: userId });
  if (lean) q = q.lean();
  const order = await q;
  if (!order) throw notFound('Order');
  return order;
}

async function recordConfirmedOrder(order, ctx) {
  await User.updateOne(
    { _id: order.user },
    { $inc: { 'stats.ordersCount': 1 }, $set: { 'stats.lastOrderAt': new Date() }, $min: { 'stats.firstOrderAt': new Date() } },
    { session: ctx?.session },
  );
}

async function recordRevenue(userId, amount, ctx) {
  await User.updateOne({ _id: userId }, { $inc: { 'stats.totalSpent': amount } }, { session: ctx?.session });
}

/**
 * Cancels an order and unwinds stock, coupon and payment.
 *  - pending (unpaid UPI): release the reservation; a capture that arrives later is refunded.
 *  - confirmed/processing/packed: committed stock goes back on the shelf; paid UPI is refunded.
 */
async function cancelOrder(orderRef, { actor, reason, customerId }) {
  const order = customerId ? await findOwned(customerId, orderRef) : await Order.findById(orderRef);
  if (!order) throw notFound('Order');
  if (customerId && !CUSTOMER_CANCELLABLE.includes(order.status)) {
    throw conflict(
      order.status === S.PACKED ? 'Your order is already packed. Please contact support to cancel it.' : `Orders that are ${order.status.replace(/_/g, ' ')} cannot be cancelled`,
      'NOT_CANCELLABLE',
    );
  }
  if (!canTransition(order.status, S.CANCELLED) || order.status === S.RTO) {
    throw conflict(`Orders that are ${order.status} cannot be cancelled here`, 'NOT_CANCELLABLE');
  }
  const refunds = require('../refunds/refund.service');

  const result = await transaction(async (ctx) => {
    const fresh = await Order.findById(order._id).session(ctx.session);
    const wasPending = fresh.status === S.PENDING;
    let paymentStatus = fresh.paymentStatus;
    if (fresh.paymentMethod === PAYMENT_METHOD.COD) paymentStatus = PS.COD_NOT_COLLECTED;
    else if (wasPending) paymentStatus = PS.FAILED;

    const updated = await transition(fresh, S.CANCELLED, {
      actor,
      note: reason,
      set: { cancelReason: reason, cancelledBy: { type: actor.type, id: actor.id }, paymentStatus },
      ctx,
    });
    if (wasPending) await inventory.releaseReservation({ type: 'order', id: fresh._id }, 'order_cancelled', ctx);
    else await inventory.restockCancelled(fresh.items, { type: 'order', id: fresh._id }, ctx);
    await promotions.releaseCoupon(fresh._id, ctx);

    if (wasPending && fresh.paymentMethod === PAYMENT_METHOD.UPI) {
      const { Payment } = require('../payments/payment.models');
      await Payment.updateOne({ order: fresh._id, status: { $in: ['created', 'attempted', 'failed'] } }, { $set: { status: 'expired' } }, { session: ctx.session });
    }
    let refund = null;
    if (fresh.paymentMethod === PAYMENT_METHOD.UPI && [PS.PAID, PS.PARTIALLY_REFUNDED].includes(fresh.paymentStatus)) {
      const amount = fresh.pricing.total - fresh.pricing.refundCommitted;
      if (amount > 0) {
        refund = await refunds.createRefund(
          { order: updated, amount, type: 'cancellation', reason: reason || 'Order cancelled', requestedBy: actor, autoApprove: true, idempotencyKey: `${fresh._id}:cancellation` },
          ctx,
        );
      }
    }
    ctx.after.push(() => bus.publish(bus.EVENTS.ORDER_CANCELLED, { orderId: fresh._id, userId: fresh.user, orderNumber: fresh.orderNumber, reason, refundId: refund?._id }));
    return { order: updated, refund };
  });

  await audit.record({ actor, action: 'order.cancel', resource: { type: 'order', id: order._id }, metadata: { reason, refund: result.refund?.refundNumber } });
  return result;
}

/** Staff status change with domain side effects for delivery outcomes. */
async function staffTransition(orderId, to, { actor, note, req }) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  if (to === S.CANCELLED) return (await cancelOrder(orderId, { actor, reason: note || 'Cancelled by staff' })).order;
  if ([S.SHIPPED].includes(to) && !order.shipment) throw conflict('Create a shipment (with AWB) before marking the order shipped', 'SHIPMENT_REQUIRED');
  if ([S.RETURN_REQUESTED, S.RETURNED, S.REPLACEMENT_PROCESSING].includes(to)) {
    throw forbidden('Return and replacement statuses are driven by the returns workflow');
  }
  const updated = await transaction((ctx) => transition(order, to, { actor, note, ctx }));
  await audit.record({ req, actor, action: 'order.status', resource: { type: 'order', id: order._id }, metadata: { from: order.status, to, note } });
  return updated;
}

/** RTO parcel received back at the warehouse: units go to quarantine, order is closed. */
async function receiveRto(orderId, { actor, note, req }) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  if (order.status !== S.RTO) throw conflict('Order is not in return-to-origin', 'INVALID_TRANSITION');
  const refunds = require('../refunds/refund.service');
  const updated = await transaction(async (ctx) => {
    await inventory.quarantine(order.items, { type: 'order', id: order._id }, { session: ctx.session, reason: 'rto_received' });
    await promotions.releaseCoupon(order._id, ctx);
    const paymentStatus = order.paymentMethod === PAYMENT_METHOD.COD ? PS.COD_NOT_COLLECTED : order.paymentStatus;
    const u = await transition(order, S.CANCELLED, { actor, note: note || 'Returned to origin', set: { cancelReason: 'returned_to_origin', paymentStatus }, ctx });
    if (order.paymentMethod === PAYMENT_METHOD.UPI && order.paymentStatus === PS.PAID) {
      const amount = order.pricing.total - order.pricing.refundCommitted;
      if (amount > 0) {
        await refunds.createRefund({ order: u, amount, type: 'cancellation', reason: 'Returned to origin (undelivered)', requestedBy: actor, autoApprove: true, idempotencyKey: `${order._id}:rto` }, ctx);
      }
    }
    return u;
  });
  await audit.record({ req, actor, action: 'order.rto_received', resource: { type: 'order', id: order._id } });
  return updated;
}

/** Customer-facing order shape (no internal notes or staff ids). */
function toCustomerView(o) {
  return {
    id: o._id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    items: o.items.map((i) => ({
      id: i._id,
      product: i.product,
      sku: i.sku,
      name: i.name,
      variantTitle: i.variantTitle,
      slug: i.slug,
      image: i.image,
      quantity: i.quantity,
      mrp: i.mrp,
      unitPrice: i.unitPrice,
      promotionDiscount: i.promotionDiscount,
      couponDiscount: i.couponDiscount,
      total: i.total,
      taxAmount: i.taxAmount,
      gstRateBps: i.gstRateBps,
      bundleComponents: i.bundleComponents,
      returnPolicy: i.returnPolicy,
      claimedQty: i.claimedQty,
    })),
    shippingAddress: o.shippingAddress,
    pricing: o.pricing,
    coupon: o.coupon?.code ? { code: o.coupon.code, discount: o.coupon.discount } : null,
    promotions: o.promotions,
    giftWrap: o.giftWrap,
    giftMessage: o.giftMessage,
    estimatedDeliveryDate: o.estimatedDeliveryDate,
    reservationExpiresAt: o.status === S.PENDING ? o.reservationExpiresAt : undefined,
    timeline: (o.statusHistory || []).map((h) => ({ status: h.to, at: h.at })),
    cancelReason: o.cancelReason,
    createdAt: o.createdAt,
    confirmedAt: o.confirmedAt,
    shippedAt: o.shippedAt,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
    cancellable: CUSTOMER_CANCELLABLE.includes(o.status),
  };
}

module.exports = { canTransition, transition, findOwned, cancelOrder, staffTransition, receiveRto, recordConfirmedOrder, recordRevenue, toCustomerView };
