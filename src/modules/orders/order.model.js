'use strict';

const mongoose = require('mongoose');
const { ORDER_STATUS, PAYMENT_STATUS, PAYMENT_METHOD } = require('../../constants/statuses');

const { ObjectId } = mongoose.Schema.Types;
const int = { type: Number, default: 0, min: 0, validate: Number.isInteger };

/** Immutable purchase-time snapshot. Later catalog changes never alter these values. */
const orderItemSchema = new mongoose.Schema({
  product: { type: ObjectId, ref: 'Product', required: true },
  variantId: ObjectId,
  sku: { type: String, required: true },
  name: { type: String, required: true },
  variantTitle: String,
  slug: String,
  image: String,
  quantity: { type: Number, required: true, min: 1 },
  mrp: int,
  unitPrice: int,
  subtotal: int,
  promotionDiscount: int,
  couponDiscount: int,
  total: int,
  gstRateBps: int,
  hsnCode: String,
  taxAmount: int,
  isFragile: Boolean,
  material: String,
  piecesPerSet: Number,
  weightGrams: Number,
  bundleComponents: [new mongoose.Schema({ sku: String, quantity: Number, name: String }, { _id: false })],
  returnPolicy: { returnable: Boolean, windowDays: Number, replacementOnly: Boolean },
  claimedQty: { ...int }, // units under an open or approved return/replacement claim
  refundedAmount: int,
});

const addressSnapshot = new mongoose.Schema(
  { fullName: String, phone: String, line1: String, line2: String, landmark: String, city: String, state: String, pincode: String, country: String },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    items: { type: [orderItemSchema], validate: [(v) => v.length > 0, 'Order needs items'] },
    shippingAddress: { type: addressSnapshot, required: true },
    pricing: {
      mrpTotal: int,
      subtotal: int,
      promotionDiscount: int,
      couponDiscount: int,
      merchandiseTotal: int,
      shippingFee: int,
      giftWrapFee: int,
      codFee: int,
      taxTotal: int,
      total: int,
      refundCommitted: int, // sum of refunds created and not rejected/failed (prevents over-refunding)
      refundedTotal: int, // confirmed by the provider / payout
    },
    coupon: { code: String, id: ObjectId, discount: Number },
    promotions: [new mongoose.Schema({ id: ObjectId, name: String, discount: Number }, { _id: false })],
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    paymentStatus: { type: String, enum: Object.values(PAYMENT_STATUS), required: true },
    status: { type: String, enum: Object.values(ORDER_STATUS), required: true },
    statusHistory: [
      new mongoose.Schema(
        { from: String, to: String, at: { type: Date, default: Date.now }, by: { type: { type: String }, id: ObjectId }, note: String },
        { _id: false },
      ),
    ],
    reservationExpiresAt: Date,
    policySnapshot: {
      returnWindowDays: Number,
      damageReportWindowDays: Number,
      allowChangeOfMind: Boolean,
      pickupRequiredForReturn: Boolean,
      pickupRequiredForDamage: Boolean,
    },
    giftWrap: { type: Boolean, default: false },
    giftMessage: String,
    packaging: { requirements: [String], notes: String },
    estimatedDeliveryDate: Date,
    shipment: { type: ObjectId, ref: 'Shipment' },
    confirmedAt: Date,
    shippedAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    cancelledBy: { type: { type: String }, id: ObjectId },
    cod: { collectedAt: Date, collectedBy: ObjectId, collectedAmount: Number, settledAt: Date, remittanceRef: String },
    checkoutKey: { type: String },
    payment: { type: ObjectId, ref: 'Payment' },
    flags: { stockConflict: Boolean, highValue: Boolean },
    adminNotes: [new mongoose.Schema({ note: String, by: ObjectId, at: { type: Date, default: Date.now } }, { _id: false })],
  },
  { timestamps: true },
);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ paymentMethod: 1, paymentStatus: 1, createdAt: -1 });
orderSchema.index({ user: 1, checkoutKey: 1 }, { unique: true, partialFilterExpression: { checkoutKey: { $type: 'string' } } });
orderSchema.index({ status: 1, reservationExpiresAt: 1 }, { partialFilterExpression: { status: 'pending' } });
orderSchema.index({ 'items.sku': 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
