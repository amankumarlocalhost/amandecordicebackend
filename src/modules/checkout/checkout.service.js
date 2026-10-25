'use strict';

const mongoose = require('mongoose');
const Order = require('../orders/order.model');
const Address = require('../addresses/address.model');
const { Cart } = require('../cart/cart.model');
const { Payment } = require('../payments/payment.models');
const pricing = require('../pricing/pricing.service');
const inventory = require('../inventory/inventory.service');
const promotions = require('../promotions/promotion.service');
const paymentService = require('../payments/payment.service');
const orderService = require('../orders/order.service');
const shipping = require('../shipping/shipping.service');
const audit = require('../audit/audit');
const bus = require('../../events/bus');
const logger = require('../../config/logger');
const { getSettings } = require('../settings/settings');
const { transaction } = require('../../config/database');
const { referenceNumber } = require('../../utils/crypto');
const { addMinutes } = require('../../utils/common');
const { badRequest, conflict, notFound, AppError } = require('../../utils/errors');
const { ORDER_STATUS: S, PAYMENT_STATUS: PS, PAYMENT_METHOD } = require('../../constants/statuses');

async function loadCheckoutInputs(userId, addressId) {
  const [cart, address] = await Promise.all([Cart.findOne({ user: userId }), Address.findOne({ _id: addressId, user: userId }).lean()]);
  if (!cart || !cart.items.length) throw badRequest('Your cart is empty', undefined, 'CART_EMPTY');
  if (!address) throw notFound('Address');
  return { cart, address };
}

async function quoteForCheckout(userId, { addressId, paymentMethod }) {
  const { cart, address } = await loadCheckoutInputs(userId, addressId);
  const q = await pricing.quote({
    userId,
    items: cart.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    couponCode: cart.couponCode,
    pincode: address.pincode,
    paymentMethod,
    giftWrap: cart.giftWrap,
  });
  return { q, cart, address };
}

async function existingOrderResponse(order) {
  const payment = await Payment.findOne({ order: order._id });
  const view = orderService.toCustomerView(order.toObject ? order.toObject() : order);
  if (order.paymentMethod === PAYMENT_METHOD.UPI && order.status === S.PENDING && payment?.providerOrderId) {
    return { order: view, payment: await paymentService.checkoutPayload(order, payment), duplicate: true };
  }
  return { order: view, payment: null, duplicate: true };
}

/**
 * Places an order from the customer's cart.
 *  - Idempotent per (customer, Idempotency-Key): repeated submissions return the same order.
 *  - Every amount is recomputed here; `expectedTotal` (what the customer saw) guards against stale prices.
 *  - Stock reservation, coupon redemption, order creation and cart clearing commit atomically.
 *  - COD orders are confirmed immediately; UPI orders stay pending until payment is verified server-side.
 */
async function placeOrder(userId, { addressId, paymentMethod, expectedTotal, idempotencyKey, giftMessage }, req) {
  const prior = await Order.findOne({ user: userId, checkoutKey: idempotencyKey });
  if (prior) return existingOrderResponse(prior);

  const settings = await getSettings();
  const { q, cart, address } = await quoteForCheckout(userId, { addressId, paymentMethod });

  if (!q.lines.length) throw conflict('None of the items in your cart are available', 'CART_UNAVAILABLE', { issues: q.issues });
  if (q.issues.length) throw new AppError(409, 'CHECKOUT_BLOCKED', q.issues[0].message, { issues: q.issues, quote: pricing.publicQuote(q) });
  if (q.lines.length > settings.checkout.maxLinesPerOrder) throw badRequest('Too many items in one order');
  if (expectedTotal !== undefined && expectedTotal !== q.totals.total) {
    throw new AppError(409, 'PRICE_CHANGED', 'Prices or offers changed since you last viewed your cart. Please review the updated total.', { quote: pricing.publicQuote(q) });
  }

  const isUpi = paymentMethod === PAYMENT_METHOD.UPI;
  const now = new Date();
  const serviceability = q.shipping.serviceability;
  const orderDoc = {
    orderNumber: referenceNumber('CRK'),
    user: userId,
    items: q.lines.map((l) => ({
      product: l.productId,
      variantId: l.variantId,
      sku: l.sku,
      name: l.name,
      variantTitle: l.variantTitle,
      slug: l.slug,
      image: l.image,
      quantity: l.quantity,
      mrp: l.mrp,
      unitPrice: l.unitPrice,
      subtotal: l.subtotal,
      promotionDiscount: l.promotionDiscount,
      couponDiscount: l.couponDiscount,
      total: l.total,
      gstRateBps: l.gstRateBps,
      hsnCode: l.hsnCode,
      taxAmount: l.taxAmount,
      isFragile: l.isFragile,
      material: l.material,
      piecesPerSet: l.piecesPerSet,
      weightGrams: l.weightGrams,
      bundleComponents: l.bundleComponents.map((c) => ({ sku: c.sku, quantity: c.quantity, name: c.name })),
      returnPolicy: {
        returnable: l.returnPolicy?.returnable !== false,
        windowDays: l.returnPolicy?.windowDays ?? settings.returns.defaultWindowDays,
        replacementOnly: Boolean(l.returnPolicy?.replacementOnly),
      },
    })),
    shippingAddress: {
      fullName: address.fullName,
      phone: address.phone,
      line1: address.line1,
      line2: address.line2,
      landmark: address.landmark,
      city: address.city,
      state: address.state,
      pincode: address.pincode,
      country: address.country,
    },
    pricing: {
      mrpTotal: q.totals.mrpTotal,
      subtotal: q.totals.subtotal,
      promotionDiscount: q.totals.promotionDiscount,
      couponDiscount: q.totals.couponDiscount,
      merchandiseTotal: q.totals.merchandiseTotal,
      shippingFee: q.totals.shippingFee,
      giftWrapFee: q.totals.giftWrapFee,
      codFee: q.totals.codFee,
      taxTotal: q.totals.taxTotal,
      total: q.totals.total,
    },
    coupon: q._coupon ? { code: q._coupon.code, id: q._coupon._id, discount: q.totals.couponDiscount } : undefined,
    promotions: q.appliedPromotions.map((p) => ({ id: p.id, name: p.name, discount: p.discount })),
    paymentMethod,
    paymentStatus: isUpi ? PS.PENDING : PS.COD_DUE,
    status: isUpi ? S.PENDING : S.CONFIRMED,
    statusHistory: [{ from: null, to: isUpi ? S.PENDING : S.CONFIRMED, by: { type: 'customer', id: userId }, note: 'Order placed' }],
    reservationExpiresAt: isUpi ? addMinutes(now, settings.checkout.reservationMinutes) : undefined,
    confirmedAt: isUpi ? undefined : now,
    policySnapshot: {
      returnWindowDays: settings.returns.defaultWindowDays,
      damageReportWindowDays: settings.returns.damageReportWindowDays,
      allowChangeOfMind: settings.returns.allowChangeOfMind,
      pickupRequiredForReturn: settings.returns.pickupRequiredForReturn,
      pickupRequiredForDamage: settings.returns.pickupRequiredForDamage,
    },
    giftWrap: q.giftWrap.selected,
    giftMessage: q.giftWrap.selected ? giftMessage || cart.giftMessage : undefined,
    packaging: shipping.packagingPlan(q.lines),
    estimatedDeliveryDate: serviceability?.estimatedDeliveryDate ? new Date(serviceability.estimatedDeliveryDate) : undefined,
    checkoutKey: idempotencyKey,
    flags: { highValue: q.totals.total >= 2500000 },
  };

  let order;
  try {
    order = await transaction(async (ctx) => {
      const opts = { session: ctx.session };
      const orderId = new mongoose.Types.ObjectId();
      const paymentId = new mongoose.Types.ObjectId();
      const [created] = await Order.create([{ ...orderDoc, _id: orderId, payment: paymentId }], opts);
      await Payment.create([{ _id: paymentId, order: orderId, user: userId, method: paymentMethod, provider: isUpi ? 'razorpay' : 'cod', amount: created.pricing.total, status: isUpi ? 'created' : 'cod_due' }], opts);
      await Cart.updateOne({ _id: cart._id }, { $set: { items: [], couponCode: null, giftWrap: false, giftMessage: null } }, opts);
      if (!isUpi) await orderService.recordConfirmedOrder(created, ctx);
      // Hot, contended documents (coupon counter, SKU stock) are written last so their write locks
      // are held for the shortest possible time before commit.
      if (q._coupon) await promotions.redeemCoupon({ coupon: q._coupon, userId, orderId, discount: q.totals.couponDiscount, session: ctx.session });
      const ref = { type: 'order', id: orderId };
      if (isUpi) await inventory.reserve(q.lines, ref, { expiresAt: created.reservationExpiresAt, session: ctx.session });
      else await inventory.commitDirect(q.lines, ref, { session: ctx.session }); // COD: confirmed now → take stock in one guarded update
      ctx.after.push(() => bus.publish(bus.EVENTS.ORDER_PLACED, { orderId, userId, orderNumber: created.orderNumber, paymentMethod, total: created.pricing.total }));
      return created;
    });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.checkoutKey) {
      const dup = await Order.findOne({ user: userId, checkoutKey: idempotencyKey });
      if (dup) return existingOrderResponse(dup);
    }
    throw err;
  }

  await audit.record({ req, action: 'order.placed', resource: { type: 'order', id: order._id }, metadata: { orderNumber: order.orderNumber, total: order.pricing.total, paymentMethod } });

  if (!isUpi) return { order: orderService.toCustomerView(order.toObject()), payment: { provider: 'cod', amountDue: order.pricing.total } };

  try {
    const payment = await paymentService.initiateUpi(order);
    return { order: orderService.toCustomerView(order.toObject()), payment: await paymentService.checkoutPayload(order, payment) };
  } catch (err) {
    // The order and stock hold stay valid; the customer can retry payment until the hold expires.
    logger.error({ err: err.message, order: order.orderNumber }, 'Razorpay order creation failed');
    return {
      order: orderService.toCustomerView(order.toObject()),
      payment: null,
      paymentError: { code: 'PAYMENT_INIT_FAILED', message: 'We could not start the UPI payment. Please retry from your order page.' },
    };
  }
}

module.exports = { quoteForCheckout, placeOrder };
