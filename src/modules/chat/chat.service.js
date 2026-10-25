'use strict';

const { Conversation, ChatMessage, SupportTicket } = require('./chat.models');
const Order = require('../orders/order.model');
const media = require('../media/media');
const bus = require('../../events/bus');
const logger = require('../../config/logger');
const { emitToConversation, emitToStaff, emitToUser } = require('../../sockets/emitter');
const { clean } = require('../reviews/reviews');
const { referenceNumber } = require('../../utils/crypto');
const { forbidden, notFound, conflict, badRequest } = require('../../utils/errors');
const { PERMISSIONS } = require('../../constants/roles');

const MAX_BODY = 2000;

function senderType(auth) {
  return auth.isStaff ? 'agent' : 'customer';
}

/** Every read/write goes through this: customers only see their own conversations; staff need support:read. */
async function authorize(auth, conversationId, { write = false } = {}) {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw notFound('Conversation');
  if (auth.isStaff) {
    const need = write ? PERMISSIONS.SUPPORT_WRITE : PERMISSIONS.SUPPORT_READ;
    if (!auth.permissions.includes(need)) throw forbidden();
  } else if (String(conv.customer) !== String(auth.userId)) {
    throw notFound('Conversation'); // do not reveal existence
  }
  return conv;
}

function toDto(m, { staff = false } = {}) {
  return {
    id: m._id,
    conversationId: m.conversation,
    sender: { type: m.sender.type, ...(m.sender.type === 'agent' ? { name: 'Support' } : {}) },
    kind: m.kind,
    body: m.body,
    attachments: m.attachments?.map((x) => ({ kind: x.kind || 'image', url: x.url, thumbUrl: x.thumbUrl, posterUrl: x.posterUrl })),
    payload: m.payload,
    clientMessageId: m.clientMessageId,
    readAt: m.readAt,
    createdAt: m.createdAt,
    ...(staff ? { toolTrace: m.toolTrace } : {}),
  };
}

function convDto(c) {
  return { id: c._id, channel: c.channel, status: c.status, subject: c.subject, order: c.order, lastMessageAt: c.lastMessageAt, lastMessagePreview: c.lastMessagePreview, unread: c.unread, ticket: c.ticket, createdAt: c.createdAt };
}

async function startConversation(userId, { channel = 'ai', orderId, subject } = {}) {
  let order;
  if (orderId) {
    order = await Order.findOne({ _id: orderId, user: userId }).select('_id orderNumber').lean();
    if (!order) throw notFound('Order');
  }
  const existing = await Conversation.findOne({ customer: userId, status: { $ne: 'closed' } }).sort({ lastMessageAt: -1 });
  if (existing) {
    if (order && !existing.order) {
      existing.order = order._id;
      await existing.save();
    }
    return existing;
  }
  const { getSettings } = require('../settings/settings');
  const settings = await getSettings();
  const conv = await Conversation.create({ customer: userId, channel: channel === 'ai' && settings.ai.customerEnabled ? 'ai' : 'human', status: channel === 'human' ? 'waiting_agent' : 'open', order: order?._id, subject });
  if (conv.channel === 'human') emitToStaff(PERMISSIONS.SUPPORT_READ, 'support:conversation', { id: conv._id, status: conv.status });
  return conv;
}

async function addSystemMessage(conv, body, { kind = 'system', payload, senderTypeOverride = 'system', toolTrace } = {}) {
  const m = await ChatMessage.create({ conversation: conv._id, sender: { type: senderTypeOverride }, kind, body, payload, toolTrace });
  await Conversation.updateOne({ _id: conv._id }, { $set: { lastMessageAt: m.createdAt, lastMessagePreview: (body || '').slice(0, 140) }, $inc: { 'unread.customer': 1 } });
  emitToConversation(conv._id, 'chat:message', toDto(m));
  return m;
}

/**
 * Persists a message. Re-sent messages (same clientMessageId after a reconnect) return the stored
 * copy and never trigger a second AI turn or business action.
 */
async function postMessage(auth, conversationId, { body, attachmentIds = [], clientMessageId }) {
  const conv = await authorize(auth, conversationId, { write: true });
  if (conv.status === 'closed') throw conflict('This conversation is closed. Start a new one.', 'CONVERSATION_CLOSED');
  const text = clean(body || '').slice(0, MAX_BODY);
  if (!text && !attachmentIds.length) throw badRequest('Message is empty');
  if (clientMessageId) {
    const dup = await ChatMessage.findOne({ conversation: conv._id, 'sender.user': auth.userId, clientMessageId }).lean();
    if (dup) return { message: toDto(dup), duplicate: true, conversation: conv };
  }
  const uploads = attachmentIds.length ? await media.resolveOwnedUploads(attachmentIds, auth.userId, ['chat', 'return']) : [];
  let m;
  try {
    m = await ChatMessage.create({
      conversation: conv._id,
      sender: { type: senderType(auth), user: auth.userId },
      body: text,
      attachments: uploads.map(media.toRef),
      clientMessageId,
    });
  } catch (err) {
    if (err.code === 11000 && clientMessageId) {
      const dup = await ChatMessage.findOne({ conversation: conv._id, 'sender.user': auth.userId, clientMessageId }).lean();
      return { message: toDto(dup), duplicate: true, conversation: conv };
    }
    throw err;
  }
  const fromStaff = auth.isStaff;
  const update = { $set: { lastMessageAt: m.createdAt, lastMessagePreview: (text || (uploads.some((u) => u.kind === 'video') ? '🎥 Video' : '📷 Photo')).slice(0, 140) }, $inc: { [fromStaff ? 'unread.customer' : 'unread.staff']: 1 } };
  if (fromStaff && conv.status === 'waiting_agent') update.$set = { ...update.$set, status: 'assigned', assignedAgent: auth.userId };
  await Conversation.updateOne({ _id: conv._id }, update);
  const dto = toDto(m);
  emitToConversation(conv._id, 'chat:message', dto);
  if (fromStaff) {
    emitToUser(conv.customer, 'chat:unread', { conversationId: conv._id });
    bus.publish(bus.EVENTS.SUPPORT_MESSAGE, { userId: conv.customer, conversationId: conv._id, preview: text || 'Photo', fromStaff: true });
  } else if (conv.channel === 'human') {
    emitToStaff(PERMISSIONS.SUPPORT_READ, 'support:message', { conversationId: conv._id, preview: dto.body?.slice(0, 140) });
  }

  if (!fromStaff && conv.channel === 'ai' && conv.status === 'open') {
    const assistant = require('../ai/customer.assistant');
    assistant.respond(conv._id, m._id).catch((err) => logger.error({ err: err.message, conv: String(conv._id) }, 'AI reply failed'));
  }
  return { message: dto, duplicate: false, conversation: conv };
}

async function history(auth, conversationId, { before, limit = 30 }) {
  const conv = await authorize(auth, conversationId);
  const filter = { conversation: conv._id, ...(before ? { createdAt: { $lt: new Date(before) } } : {}) };
  const items = await ChatMessage.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).lean();
  return { conversation: convDto(conv), messages: items.reverse().map((m) => toDto(m, { staff: auth.isStaff })) };
}

async function markRead(auth, conversationId) {
  const conv = await authorize(auth, conversationId);
  const otherSide = auth.isStaff ? { $in: ['customer'] } : { $in: ['agent', 'ai', 'system'] };
  const now = new Date();
  await ChatMessage.updateMany({ conversation: conv._id, 'sender.type': otherSide, readAt: null }, { $set: { readAt: now } });
  await Conversation.updateOne({ _id: conv._id }, { $set: { [auth.isStaff ? 'unread.staff' : 'unread.customer']: 0 } });
  emitToConversation(conv._id, 'chat:read', { conversationId: conv._id, by: senderType(auth), at: now });
}

async function createTicket(customerId, { subject, description, category = 'other', priority = 'normal', orderId, conversationId, source = 'form' }) {
  let order;
  if (orderId) {
    order = await Order.findOne({ _id: orderId, user: customerId }).select('_id').lean();
    if (!order) throw notFound('Order');
  }
  const ticket = await SupportTicket.create({ ticketNumber: referenceNumber('TKT'), customer: customerId, subject: clean(subject), description: clean(description), category, priority, order: order?._id, conversation: conversationId, source });
  emitToStaff(PERMISSIONS.SUPPORT_READ, 'support:ticket', { id: ticket._id, ticketNumber: ticket.ticketNumber, priority });
  return ticket;
}

/** Moves an AI conversation to the human queue (customer request, AI escalation, or AI outage). */
async function handoff(conversationId, { reason, by = 'customer', category = 'other' } = {}) {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw notFound('Conversation');
  if (conv.channel === 'human' && conv.status !== 'open') return conv;
  let ticketId = conv.ticket;
  if (!ticketId) {
    const t = await createTicket(conv.customer, { subject: `Chat escalation: ${reason || 'customer request'}`.slice(0, 200), description: conv.aiSummary || reason, category, conversationId: conv._id, orderId: conv.order, source: by === 'ai' ? 'ai' : 'chat' });
    ticketId = t._id;
  }
  const updated = await Conversation.findOneAndUpdate({ _id: conv._id }, { $set: { channel: 'human', status: 'waiting_agent', handoffReason: reason, ticket: ticketId } }, { new: true });
  await addSystemMessage(updated, 'You are being connected to our support team. An agent will reply here shortly.');
  emitToStaff(PERMISSIONS.SUPPORT_READ, 'support:conversation', { id: updated._id, status: 'waiting_agent', reason });
  return updated;
}

async function assign(conversationId, agentId) {
  const conv = await Conversation.findOneAndUpdate({ _id: conversationId, status: { $in: ['waiting_agent', 'assigned', 'open'] } }, { $set: { status: 'assigned', channel: 'human', assignedAgent: agentId } }, { new: true });
  if (!conv) throw notFound('Conversation');
  await addSystemMessage(conv, 'A support agent has joined the conversation.');
  return conv;
}

async function close(auth, conversationId, reason = 'resolved') {
  const conv = await authorize(auth, conversationId, { write: auth.isStaff });
  if (conv.status === 'closed') return conv;
  conv.status = 'closed';
  conv.closedAt = new Date();
  conv.closedReason = reason;
  await conv.save();
  await addSystemMessage(conv, 'This conversation has been closed. You can start a new chat anytime.');
  return conv;
}

module.exports = { authorize, toDto, convDto, startConversation, addSystemMessage, postMessage, history, markRead, createTicket, handoff, assign, close };
