'use strict';

const { Notification, NotificationTemplate } = require('./notification.models');
const User = require('../users/user.model');
const channels = require('../../services/channels');
const { emitToUser } = require('../../sockets/emitter');
const { enqueue, QUEUES } = require('../../queues');
const logger = require('../../config/logger');

/** Built-in templates; admins can override any (type, channel) pair via NotificationTemplate. */
const DEFAULTS = {
  welcome: { category: 'orders', title: 'Welcome to {{store}}', body: 'Hi {{name}}, your account is ready. Happy shopping!' },
  order_confirmed: { category: 'orders', title: 'Order {{orderNumber}} confirmed', body: 'Thank you! Your order of {{amount}} is confirmed{{codNote}}.' },
  payment_success: { category: 'orders', title: 'Payment received for {{orderNumber}}', body: 'We received your UPI payment of {{amount}}. Your order is confirmed.' },
  payment_failed: { category: 'orders', title: 'Payment failed', body: 'Your UPI payment for order {{orderNumber}} did not go through. You can retry from your orders page before the hold expires.' },
  order_packed: { category: 'orders', title: 'Order {{orderNumber}} packed', body: 'Your items have been carefully packed and will ship soon.' },
  order_shipped: { category: 'orders', title: 'Order {{orderNumber}} shipped', body: 'Your order is on its way.' },
  order_out_for_delivery: { category: 'orders', title: 'Out for delivery', body: 'Order {{orderNumber}} will be delivered today.{{codNote}}' },
  order_delivered: { category: 'orders', title: 'Order {{orderNumber}} delivered', body: 'Delivered! If anything arrived broken or chipped, report it within {{damageDays}} days from your orders page or chat.' },
  order_delivery_failed: { category: 'orders', title: 'Delivery attempt failed', body: 'The courier could not deliver order {{orderNumber}}. They will try again or contact you.' },
  order_cancelled: { category: 'orders', title: 'Order {{orderNumber}} cancelled', body: 'Your order was cancelled. {{refundNote}}' },
  refund_status: { category: 'orders', title: 'Refund update: {{status}}', body: 'Refund of {{amount}} for order {{orderNumber}} is {{status}}.' },
  return_status: { category: 'orders', title: 'Request {{requestNumber}}: {{status}}', body: '{{message}}' },
  replacement_status: { category: 'orders', title: 'Replacement {{replacementNumber}}: {{status}}', body: 'Your replacement for order {{orderNumber}} is {{status}}.' },
  back_in_stock: { category: 'marketing', title: '{{productName}} is back in stock', body: 'The item you wanted is available again. Grab it before it sells out.' },
  support_reply: { category: 'support', title: 'New message from support', body: '{{preview}}' },
  security_alert: { category: 'security', title: 'Security alert', body: '{{message}}' },
  campaign_live: { category: 'marketing', title: '{{campaign}} is live!', body: '{{description}}' },
  low_stock: { category: 'staff', title: 'Low stock: {{sku}}', body: 'Only {{available}} left (threshold {{threshold}}).' },
  return_review_needed: { category: 'staff', title: 'Return {{requestNumber}} needs review', body: '{{reason}}' },
};

const render = (tpl, vars) => String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? '').toString());

async function templateFor(type, channel) {
  const t = await NotificationTemplate.findOne({ type, channel, isActive: true }).lean();
  return t || null;
}

/**
 * Creates a durable in-app notification, pushes it over Socket.IO, and queues external channels
 * the user opted into — only to verified destinations and only where a provider is configured.
 */
async function notify({ userId, type, vars = {}, data = {}, dedupeKey, channels: forced }) {
  const def = DEFAULTS[type];
  if (!def) throw new Error(`Unknown notification type ${type}`);
  const custom = await templateFor(type, 'inApp');
  const title = render(custom?.subject || def.title, vars);
  const body = render(custom?.body || def.body, vars);

  let doc;
  try {
    doc = await Notification.create({ user: userId, type, category: def.category, title, body, data, dedupeKey });
  } catch (err) {
    if (err.code === 11000) return null; // duplicate event (retry / redelivery)
    throw err;
  }
  emitToUser(userId, 'notification:new', { id: doc._id, type, title, body, data, createdAt: doc.createdAt });

  if (def.category === 'staff') return doc;
  const user = await User.findById(userId).select('email phone emailVerifiedAt phoneVerifiedAt notificationPreferences status').lean();
  if (!user || user.status === 'deleted') return doc;
  const prefs = user.notificationPreferences || {};
  const wants = (ch) => (def.category === 'security' ? true : prefs[ch]?.[def.category] === true);
  const configured = channels.configured();
  const plan = {
    email: (forced?.includes('email') || wants('email')) && user.email && user.emailVerifiedAt && configured.email,
    sms: (forced?.includes('sms') || wants('sms')) && user.phone && user.phoneVerifiedAt && configured.sms && def.category !== 'marketing',
    whatsapp: wants('whatsapp') && user.phone && user.phoneVerifiedAt && configured.whatsapp,
  };
  const set = {};
  for (const [ch, go] of Object.entries(plan)) {
    if (!go) continue;
    set[`channels.${ch}`] = { status: 'queued', at: new Date() };
    await enqueue(QUEUES.NOTIFICATIONS, 'deliver', { notificationId: String(doc._id), channel: ch }, { jobId: `n-${doc._id}-${ch}` });
  }
  if (Object.keys(set).length) await Notification.updateOne({ _id: doc._id }, { $set: set });
  return doc;
}

/** Job: sends one channel of a notification and records the outcome. */
async function deliver({ notificationId, channel }) {
  const n = await Notification.findById(notificationId).lean();
  if (!n || n.channels?.[channel]?.status === 'sent') return;
  const user = await User.findById(n.user).select('email phone').lean();
  const tpl = await templateFor(n.type, channel);
  const vars = { ...(n.data || {}), title: n.title, body: n.body };
  const subject = tpl?.subject ? render(tpl.subject, vars) : n.title;
  const text = tpl?.body ? render(tpl.body, vars) : `${n.title}\n\n${n.body}`;
  let result;
  if (channel === 'email') result = await channels.sendEmail({ to: user.email, subject, text });
  else if (channel === 'sms') result = await channels.sendSms({ to: user.phone, text: text.slice(0, 300) });
  else result = await channels.sendWhatsApp({ to: user.phone, text });
  await Notification.updateOne(
    { _id: n._id },
    { $set: { [`channels.${channel}`]: { status: result.delivered ? 'sent' : 'skipped', reason: result.reason, at: new Date() } } },
  );
}

async function notifyStaff(permission, { type, vars, data, dedupeKey }) {
  const { ROLE_PERMISSIONS } = require('../../constants/roles');
  const roles = Object.entries(ROLE_PERMISSIONS).filter(([, perms]) => perms.includes(permission)).map(([r]) => r);
  const staff = await User.find({ role: { $in: roles }, status: 'active' }).select('_id').limit(50).lean();
  const { emitToStaff } = require('../../sockets/emitter');
  emitToStaff(permission, 'staff:alert', { type, vars, data });
  for (const s of staff) {
    await notify({ userId: s._id, type, vars, data, dedupeKey: dedupeKey ? `${dedupeKey}:${s._id}` : undefined }).catch((err) => logger.warn({ err: err.message }, 'staff notify failed'));
  }
}

module.exports = { notify, deliver, notifyStaff, DEFAULTS, render };
