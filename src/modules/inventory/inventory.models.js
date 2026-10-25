'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;
const qty = { type: Number, default: 0, min: 0, validate: Number.isInteger };

/**
 * Stock buckets per SKU:
 *  onHand     – physically present and sellable (includes reserved units)
 *  reserved   – held for unpaid / unshipped orders; available = onHand - reserved
 *  quarantine – returned or RTO units awaiting inspection (never sellable automatically)
 *  damaged    – broken in warehouse or failed inspection
 *  unusable   – written off
 *  sold       – lifetime units shipped/committed (informational)
 */
const inventorySchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, uppercase: true },
    product: { type: ObjectId, ref: 'Product', required: true },
    variantId: { type: ObjectId },
    onHand: qty,
    reserved: qty,
    quarantine: qty,
    damaged: qty,
    unusable: qty,
    sold: qty,
    lowStockThreshold: { type: Number, min: 0 },
    lowStockAlertedAt: Date,
    location: { type: String, maxlength: 60 },
  },
  { timestamps: true },
);
inventorySchema.index({ sku: 1 }, { unique: true });
inventorySchema.index({ product: 1 });

const movementSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true },
    product: { type: ObjectId, ref: 'Product' },
    type: {
      type: String,
      required: true,
      enum: [
        'initial',
        'adjustment',
        'purchase_receipt',
        'reserve',
        'release',
        'commit',
        'cancel_restock',
        'return_quarantine',
        'disposition_restock',
        'disposition_damaged',
        'disposition_unusable',
        'warehouse_damage',
        'replacement_out',
      ],
    },
    quantity: { type: Number, required: true },
    delta: { onHand: Number, reserved: Number, quarantine: Number, damaged: Number, unusable: Number, sold: Number },
    after: { onHand: Number, reserved: Number, quarantine: Number },
    reason: { type: String, maxlength: 300 },
    ref: { type: { type: String }, id: String },
    actor: { type: { type: String }, id: ObjectId },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
movementSchema.index({ sku: 1, createdAt: -1 });
movementSchema.index({ 'ref.type': 1, 'ref.id': 1 });
movementSchema.index({ type: 1, createdAt: -1 });

const reservationSchema = new mongoose.Schema(
  {
    ref: { type: { type: String, enum: ['order', 'replacement'], required: true }, id: { type: ObjectId, required: true } },
    items: [new mongoose.Schema({ sku: String, quantity: Number }, { _id: false })],
    status: { type: String, enum: ['active', 'committed', 'released'], default: 'active' },
    expiresAt: Date,
    releasedReason: String,
  },
  { timestamps: true },
);
reservationSchema.index({ 'ref.type': 1, 'ref.id': 1 }, { unique: true });
reservationSchema.index({ status: 1, expiresAt: 1 });

const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    contactName: String,
    email: String,
    phone: String,
    gstin: String,
    address: String,
    leadTimeDays: Number,
    notes: { type: String, maxlength: 2000 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const purchaseSchema = new mongoose.Schema(
  {
    supplier: { type: ObjectId, ref: 'Supplier', required: true },
    reference: { type: String, required: true, maxlength: 60 },
    items: [new mongoose.Schema({ sku: String, quantity: Number, unitCost: Number }, { _id: false })],
    receivedAt: { type: Date, default: Date.now },
    notes: String,
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
purchaseSchema.index({ supplier: 1, reference: 1 }, { unique: true });

const backInStockSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    product: { type: ObjectId, ref: 'Product', required: true },
    sku: { type: String, required: true },
    notifiedAt: Date,
  },
  { timestamps: true },
);
backInStockSchema.index({ user: 1, sku: 1 }, { unique: true });
backInStockSchema.index({ sku: 1, notifiedAt: 1 });

module.exports = {
  Inventory: mongoose.model('Inventory', inventorySchema),
  InventoryMovement: mongoose.model('InventoryMovement', movementSchema),
  StockReservation: mongoose.model('StockReservation', reservationSchema),
  Supplier: mongoose.model('Supplier', supplierSchema),
  PurchaseRecord: mongoose.model('PurchaseRecord', purchaseSchema),
  BackInStockSubscription: mongoose.model('BackInStockSubscription', backInStockSchema),
};
