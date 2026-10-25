'use strict';

const mongoose = require('mongoose');
const { REFUND_STATUS } = require('../../constants/statuses');

const { ObjectId } = mongoose.Schema.Types;

const paymentSchema = new mongoose.Schema(
  {
    order: { type: ObjectId, ref: 'Order', required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    method: { type: String, enum: ['upi', 'cod'], required: true },
    provider: { type: String, enum: ['razorpay', 'cod'], required: true },
    providerOrderId: String,
    providerPaymentId: String,
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: ['created', 'attempted', 'authorized', 'captured', 'failed', 'expired', 'cod_due', 'cod_collected', 'cod_not_collected'],
      required: true,
    },
    capturedAt: Date,
    verifiedVia: { type: String, enum: ['signature', 'webhook', 'reconciliation'] },
    attempts: [
      new mongoose.Schema(
        { paymentId: String, status: String, method: String, vpaMasked: String, errorCode: String, errorReason: String, at: { type: Date, default: Date.now } },
        { _id: false },
      ),
    ],
    refundedAmount: { type: Number, default: 0 },
    lastReconciledAt: Date,
  },
  { timestamps: true },
);
paymentSchema.index({ order: 1 }, { unique: true });
paymentSchema.index({ providerOrderId: 1 }, { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } });
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } });
paymentSchema.index({ status: 1, createdAt: -1 });

const refundSchema = new mongoose.Schema(
  {
    refundNumber: { type: String, required: true },
    order: { type: ObjectId, ref: 'Order', required: true },
    payment: { type: ObjectId, ref: 'Payment' },
    user: { type: ObjectId, ref: 'User', required: true },
    returnRequest: { type: ObjectId, ref: 'ReturnRequest' },
    amount: { type: Number, required: true, min: 1, validate: Number.isInteger },
    reason: { type: String, maxlength: 500 },
    type: { type: String, enum: ['cancellation', 'return', 'damage', 'missing_item', 'goodwill', 'late_payment', 'non_upi_payment', 'adjustment'], required: true },
    method: { type: String, enum: ['original', 'manual_upi', 'manual_bank'], required: true },
    destination: { vpa: String, accountName: String, accountLast4: String, ifsc: String },
    status: { type: String, enum: Object.values(REFUND_STATUS), required: true },
    providerRefundId: String,
    providerStatus: String,
    manualReference: String,
    requestedBy: { type: { type: String }, id: ObjectId },
    approvedBy: { type: { type: String }, id: ObjectId },
    approvedAt: Date,
    processedAt: Date,
    failureReason: String,
    attempts: { type: Number, default: 0 },
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: true },
);
refundSchema.index({ refundNumber: 1 }, { unique: true });
refundSchema.index({ idempotencyKey: 1 }, { unique: true });
refundSchema.index({ order: 1, createdAt: -1 });
refundSchema.index({ status: 1, createdAt: -1 });
refundSchema.index({ providerRefundId: 1 }, { unique: true, partialFilterExpression: { providerRefundId: { $type: 'string' } } });

const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    event: String,
    status: { type: String, enum: ['processing', 'processed', 'ignored', 'failed'], default: 'processing' },
    error: String,
    attempts: { type: Number, default: 1 },
    processedAt: Date,
  },
  { timestamps: true },
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = {
  Payment: mongoose.model('Payment', paymentSchema),
  Refund: mongoose.model('Refund', refundSchema),
  WebhookEvent: mongoose.model('WebhookEvent', webhookEventSchema),
};
