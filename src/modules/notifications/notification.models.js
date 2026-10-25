'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;
const channelState = new mongoose.Schema(
  { status: { type: String, enum: ['queued', 'sent', 'skipped', 'failed'] }, reason: String, at: Date },
  { _id: false },
);

const notificationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    category: { type: String, enum: ['orders', 'support', 'marketing', 'security', 'staff'], required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, maxlength: 2000 },
    data: mongoose.Schema.Types.Mixed,
    channels: { email: channelState, sms: channelState, whatsapp: channelState },
    readAt: Date,
    dedupeKey: String,
  },
  { timestamps: true },
);
notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

const templateSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    channel: { type: String, enum: ['inApp', 'email', 'sms', 'whatsapp'], required: true },
    subject: { type: String, maxlength: 200 },
    body: { type: String, required: true, maxlength: 5000 },
    isActive: { type: Boolean, default: true },
    updatedBy: ObjectId,
  },
  { timestamps: true },
);
templateSchema.index({ type: 1, channel: 1 }, { unique: true });

module.exports = {
  Notification: mongoose.model('Notification', notificationSchema),
  NotificationTemplate: mongoose.model('NotificationTemplate', templateSchema),
};
