'use strict';

const mongoose = require('mongoose');
const { REPLACEMENT_STATUS } = require('../../constants/statuses');

const { ObjectId } = mongoose.Schema.Types;

/** A no-charge replacement shipment linked to the original order and the approved claim. */
const replacementSchema = new mongoose.Schema(
  {
    replacementNumber: { type: String, required: true },
    returnRequest: { type: ObjectId, ref: 'ReturnRequest', required: true },
    order: { type: ObjectId, ref: 'Order', required: true },
    orderNumber: String,
    user: { type: ObjectId, ref: 'User', required: true },
    items: [new mongoose.Schema({ orderItemId: ObjectId, sku: String, name: String, quantity: Number }, { _id: false })],
    status: { type: String, enum: Object.values(REPLACEMENT_STATUS), required: true },
    shippingAddress: mongoose.Schema.Types.Mixed,
    shipment: { type: ObjectId, ref: 'Shipment' },
    stockAllocatedAt: Date,
    shippedAt: Date,
    deliveredAt: Date,
    timeline: [new mongoose.Schema({ status: String, at: { type: Date, default: Date.now }, note: String }, { _id: false })],
  },
  { timestamps: true },
);
replacementSchema.index({ replacementNumber: 1 }, { unique: true });
replacementSchema.index({ returnRequest: 1 }, { unique: true }); // one replacement per approved claim
replacementSchema.index({ order: 1 });
replacementSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Replacement', replacementSchema);
