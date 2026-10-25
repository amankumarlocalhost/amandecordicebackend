'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const pincodeSchema = new mongoose.Schema(
  {
    pincode: { type: String, required: true, match: /^[1-9]\d{5}$/ },
    city: String,
    state: String,
    zone: { type: String, maxlength: 30 },
    isActive: { type: Boolean, default: true },
    codAvailable: { type: Boolean, default: true },
    estimatedDays: { type: Number, min: 1, max: 30 },
    extraFee: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);
pincodeSchema.index({ pincode: 1 }, { unique: true });

const shipmentSchema = new mongoose.Schema(
  {
    order: { type: ObjectId, ref: 'Order' },
    replacement: { type: ObjectId, ref: 'Replacement' },
    kind: { type: String, enum: ['forward', 'replacement', 'return_pickup'], default: 'forward' },
    courier: { type: String, default: 'manual' },
    awb: { type: String, trim: true },
    trackingUrl: String,
    status: {
      type: String,
      enum: ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed_attempt', 'rto_initiated', 'rto_delivered', 'cancelled'],
      default: 'created',
    },
    packages: [
      new mongoose.Schema(
        { weightGrams: Number, lengthMm: Number, widthMm: Number, heightMm: Number, contents: [String] },
        { _id: false },
      ),
    ],
    packaging: { requirements: [String], notes: String },
    events: [new mongoose.Schema({ status: String, at: { type: Date, default: Date.now }, location: String, note: String }, { _id: false })],
    deliveredAt: Date,
    proofOfDelivery: { receiverName: String, otpVerified: Boolean, photoUrl: String },
    failedAttempts: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
shipmentSchema.index({ order: 1, kind: 1 });
shipmentSchema.index({ courier: 1, awb: 1 }, { unique: true, partialFilterExpression: { awb: { $type: 'string' } } });
shipmentSchema.index({ status: 1, updatedAt: -1 });

module.exports = {
  ServiceablePincode: mongoose.model('ServiceablePincode', pincodeSchema),
  Shipment: mongoose.model('Shipment', shipmentSchema),
};
