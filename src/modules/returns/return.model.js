'use strict';

const mongoose = require('mongoose');
const { RETURN_STATUS, RETURN_REASONS } = require('../../constants/statuses');

const { ObjectId } = mongoose.Schema.Types;

const returnSchema = new mongoose.Schema(
  {
    requestNumber: { type: String, required: true },
    order: { type: ObjectId, ref: 'Order', required: true },
    orderNumber: String,
    user: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['return', 'replacement', 'missing_item'], required: true },
    preferredResolution: { type: String, enum: ['refund', 'replacement'], required: true },
    reason: { type: String, enum: Object.values(RETURN_REASONS), required: true },
    description: { type: String, maxlength: 2000 },
    items: [
      new mongoose.Schema(
        {
          orderItemId: { type: ObjectId, required: true },
          sku: String,
          name: String,
          quantity: { type: Number, min: 1, required: true },
          unitValue: Number, // paise actually paid per unit (after discounts)
          reason: { type: String, enum: Object.values(RETURN_REASONS) },
          missingComponents: [new mongoose.Schema({ sku: String, name: String, quantity: Number }, { _id: false })],
        },
        { _id: false },
      ),
    ],
    claimValue: { type: Number, default: 0 },
    photos: [new mongoose.Schema({ upload: ObjectId, kind: { type: String, enum: ['image', 'video'], default: 'image' }, url: String, thumbUrl: String, posterUrl: String }, { _id: false })],
    status: { type: String, enum: Object.values(RETURN_STATUS), required: true },
    source: { type: String, enum: ['customer', 'ai', 'admin'], default: 'customer' },
    autoApproved: { type: Boolean, default: false },
    reviewReasons: [String],
    riskFlags: [String],
    policySnapshot: { windowDays: Number, damageWindowDays: Number, deadline: Date, requirePhotos: Boolean, pickupRequired: Boolean, allowChangeOfMind: Boolean },
    pickup: { required: Boolean, scheduledAt: Date, courier: String, awb: String, instructions: String },
    inspection: {
      result: { type: String, enum: ['confirmed', 'partially_confirmed', 'not_confirmed'] },
      notes: String,
      dispositions: [new mongoose.Schema({ sku: String, quantity: Number, decision: { type: String, enum: ['restock', 'damaged', 'unusable'] } }, { _id: false })],
      by: ObjectId,
      at: Date,
    },
    resolution: {
      type: { type: String, enum: ['refund', 'partial_refund', 'replacement', 'rejected'] },
      amount: Number,
      note: String,
      decidedBy: { type: { type: String }, id: ObjectId },
      decidedAt: Date,
    },
    refund: { type: ObjectId, ref: 'Refund' },
    replacement: { type: ObjectId, ref: 'Replacement' },
    timeline: [new mongoose.Schema({ status: String, at: { type: Date, default: Date.now }, by: { type: { type: String }, id: ObjectId }, note: String }, { _id: false })],
    idempotencyKey: String,
    assignedTo: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
returnSchema.index({ requestNumber: 1 }, { unique: true });
returnSchema.index({ order: 1, status: 1 });
returnSchema.index({ user: 1, createdAt: -1 });
returnSchema.index({ status: 1, createdAt: -1 });
returnSchema.index({ 'items.sku': 1, reason: 1, createdAt: -1 });
returnSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

module.exports = mongoose.model('ReturnRequest', returnSchema);
