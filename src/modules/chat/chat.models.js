'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const conversationSchema = new mongoose.Schema(
  {
    customer: { type: ObjectId, ref: 'User', required: true },
    channel: { type: String, enum: ['ai', 'human'], default: 'ai' },
    status: { type: String, enum: ['open', 'waiting_agent', 'assigned', 'closed'], default: 'open' },
    assignedAgent: { type: ObjectId, ref: 'User' },
    subject: { type: String, maxlength: 200 },
    order: { type: ObjectId, ref: 'Order' },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, maxlength: 140 },
    unread: { customer: { type: Number, default: 0 }, staff: { type: Number, default: 0 } },
    aiSummary: { type: String, maxlength: 4000 }, // rolling summary of older turns (keeps prompts short)
    aiSummaryUpTo: Date,
    ticket: { type: ObjectId, ref: 'SupportTicket' },
    handoffReason: String,
    closedAt: Date,
    closedReason: String,
  },
  { timestamps: true },
);
conversationSchema.index({ customer: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ status: 1, channel: 1, lastMessageAt: -1 });
conversationSchema.index({ assignedAgent: 1, status: 1 });

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: ObjectId, ref: 'Conversation', required: true },
    sender: { type: { type: String, enum: ['customer', 'agent', 'ai', 'system'], required: true }, user: { type: ObjectId, ref: 'User' } },
    kind: { type: String, enum: ['text', 'action_proposal', 'action_result', 'system', 'products'], default: 'text' },
    body: { type: String, maxlength: 4000 },
    attachments: [new mongoose.Schema({ upload: ObjectId, kind: { type: String, enum: ['image', 'video'], default: 'image' }, url: String, thumbUrl: String, posterUrl: String }, { _id: false })],
    payload: mongoose.Schema.Types.Mixed, // structured content: product cards, proposal preview, action result
    clientMessageId: String,
    readAt: Date,
    toolTrace: [new mongoose.Schema({ name: String, ok: Boolean, ms: Number }, { _id: false })], // staff-only diagnostics
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ conversation: 1, 'sender.user': 1, clientMessageId: 1 }, { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } });

const ticketSchema = new mongoose.Schema(
  {
    ticketNumber: { type: String, required: true },
    customer: { type: ObjectId, ref: 'User', required: true },
    subject: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 4000 },
    category: { type: String, enum: ['order', 'delivery', 'return', 'payment', 'product', 'account', 'other'], default: 'other' },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    status: { type: String, enum: ['open', 'in_progress', 'pending_customer', 'resolved', 'closed'], default: 'open' },
    order: { type: ObjectId, ref: 'Order' },
    conversation: { type: ObjectId, ref: 'Conversation' },
    assignedTo: { type: ObjectId, ref: 'User' },
    source: { type: String, enum: ['form', 'chat', 'ai'], default: 'form' },
    notes: [new mongoose.Schema({ by: ObjectId, note: String, at: { type: Date, default: Date.now } }, { _id: false })],
    resolvedAt: Date,
  },
  { timestamps: true },
);
ticketSchema.index({ ticketNumber: 1 }, { unique: true });
ticketSchema.index({ customer: 1, createdAt: -1 });
ticketSchema.index({ status: 1, priority: 1, createdAt: 1 });

module.exports = {
  Conversation: mongoose.model('Conversation', conversationSchema),
  ChatMessage: mongoose.model('ChatMessage', messageSchema),
  SupportTicket: mongoose.model('SupportTicket', ticketSchema),
};
