'use strict';

const bus = require('./bus');
const { EVENTS } = bus;
const { formatINR } = require('../utils/money');
const cache = require('../services/cache');

let registered = false;

/** Maps domain events to notifications and cache invalidation. All handlers are idempotent. */
function registerListeners() {
  if (registered) return;
  registered = true;
  const { notify, notifyStaff } = require('../modules/notifications/notification.service');
  const { getSettings } = require('../modules/settings/settings');
  const Order = require('../modules/orders/order.model');
  const Product = require('../modules/products/product.model');
  const { PERMISSIONS } = require('../constants/roles');

  bus.on(EVENTS.USER_REGISTERED, async ({ userId }) => {
    const s = await getSettings();
    const User = require('../modules/users/user.model');
    const u = await User.findById(userId).select('name').lean();
    await notify({ userId, type: 'welcome', vars: { name: u?.name, store: s.store.name }, dedupeKey: `welcome:${userId}` });
  });

  bus.on(EVENTS.ORDER_PLACED, async ({ orderId, userId, orderNumber, paymentMethod, total }) => {
    if (paymentMethod !== 'cod') return; // UPI orders are confirmed on payment
    await notify({ userId, type: 'order_confirmed', vars: { orderNumber, amount: formatINR(total), codNote: ' — please keep cash/UPI ready at delivery' }, data: { orderId, orderNumber }, dedupeKey: `order_confirmed:${orderId}` });
  });

  bus.on(EVENTS.PAYMENT_SUCCEEDED, async ({ orderId, userId, orderNumber, amount }) => {
    await notify({ userId, type: 'payment_success', vars: { orderNumber, amount: formatINR(amount) }, data: { orderId, orderNumber }, dedupeKey: `payment_success:${orderId}` });
  });

  bus.on(EVENTS.PAYMENT_FAILED, async ({ orderId, userId }) => {
    const o = await Order.findById(orderId).select('orderNumber').lean();
    await notify({ userId, type: 'payment_failed', vars: { orderNumber: o?.orderNumber }, data: { orderId } });
  });

  const STATUS_TYPES = { packed: 'order_packed', shipped: 'order_shipped', out_for_delivery: 'order_out_for_delivery', delivered: 'order_delivered', delivery_failed: 'order_delivery_failed' };
  bus.on(EVENTS.ORDER_STATUS_CHANGED, async ({ orderId, userId, orderNumber, to }) => {
    const type = STATUS_TYPES[to];
    if (!type) return;
    const s = await getSettings();
    const o = await Order.findById(orderId).select('paymentMethod paymentStatus pricing.total').lean();
    const codNote = o?.paymentMethod === 'cod' && o.paymentStatus === 'cod_due' ? ` Amount payable: ${formatINR(o.pricing.total)}.` : '';
    await notify({ userId, type, vars: { orderNumber, codNote, damageDays: s.returns.damageReportWindowDays }, data: { orderId, orderNumber, status: to }, dedupeKey: `${type}:${orderId}` });
  });

  bus.on(EVENTS.ORDER_CANCELLED, async ({ orderId, userId, orderNumber, refundId }) => {
    await notify({ userId, type: 'order_cancelled', vars: { orderNumber, refundNote: refundId ? 'A refund to your UPI account has been initiated.' : '' }, data: { orderId, orderNumber }, dedupeKey: `order_cancelled:${orderId}` });
  });

  bus.on(EVENTS.REFUND_UPDATED, async ({ refundId, userId, orderId, status, amount }) => {
    const o = await Order.findById(orderId).select('orderNumber').lean();
    const label = { approved: 'approved', processing: 'being processed', processed: 'completed', failed: 'delayed — our team is looking into it', rejected: 'rejected', awaiting_destination: 'waiting for your UPI ID / bank details', pending_approval: 'under review' }[status] || status;
    await notify({ userId, type: 'refund_status', vars: { amount: formatINR(amount), orderNumber: o?.orderNumber, status: label }, data: { refundId, orderId, status }, dedupeKey: `refund:${refundId}:${status}` });
  });

  bus.on(EVENTS.RETURN_UPDATED, async ({ returnId, userId, requestNumber, status, message, needsReview, reason }) => {
    if (userId) await notify({ userId, type: 'return_status', vars: { requestNumber, status: status.replace(/_/g, ' '), message }, data: { returnId, status }, dedupeKey: `return:${returnId}:${status}` });
    if (needsReview) await notifyStaff(PERMISSIONS.RETURNS_WRITE, { type: 'return_review_needed', vars: { requestNumber, reason }, data: { returnId }, dedupeKey: `return_review:${returnId}` });
  });

  bus.on(EVENTS.REPLACEMENT_UPDATED, async ({ replacementId, userId, replacementNumber, orderNumber, status }) => {
    await notify({ userId, type: 'replacement_status', vars: { replacementNumber, orderNumber, status: status.replace(/_/g, ' ') }, data: { replacementId, status }, dedupeKey: `replacement:${replacementId}:${status}` });
  });

  bus.on(EVENTS.STOCK_LOW, async ({ sku, available, threshold }) => {
    await notifyStaff(PERMISSIONS.INVENTORY_WRITE, { type: 'low_stock', vars: { sku, available, threshold }, data: { sku } });
  });

  bus.on(EVENTS.STOCK_RESTOCKED, async ({ sku, product, userIds }) => {
    const p = await Product.findById(product).select('name slug').lean();
    for (const userId of userIds) {
      await notify({ userId, type: 'back_in_stock', vars: { productName: p?.name }, data: { sku, slug: p?.slug }, dedupeKey: `bis:${sku}:${userId}:${new Date().toISOString().slice(0, 10)}` });
    }
  });

  bus.on(EVENTS.SUPPORT_MESSAGE, async ({ userId, conversationId, preview, fromStaff }) => {
    if (fromStaff) await notify({ userId, type: 'support_reply', vars: { preview: preview.slice(0, 140) }, data: { conversationId } });
  });

  bus.on(EVENTS.SECURITY_EVENT, async ({ userId, type }) => {
    const messages = { password_changed: 'Your password was changed. If this was not you, reset it immediately.', password_reset: 'Your password was reset and all sessions were signed out.', refresh_reuse: 'We detected unusual sign-in activity and signed you out for safety.' };
    await notify({ userId, type: 'security_alert', vars: { message: messages[type] || 'Security event on your account.' }, data: { type } });
  });

  bus.on(EVENTS.CATALOG_CHANGED, async () => {
    await cache.bump(cache.NS.CATALOG);
  });
}

module.exports = { registerListeners };
