'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const cartSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User' },
    guestId: { type: String },
    items: [
      new mongoose.Schema(
        {
          product: { type: ObjectId, ref: 'Product', required: true },
          sku: { type: String, required: true, uppercase: true },
          quantity: { type: Number, required: true, min: 1, max: 500, validate: Number.isInteger },
          addedAt: { type: Date, default: Date.now },
        },
        { _id: false },
      ),
    ],
    couponCode: { type: String, uppercase: true, trim: true },
    giftWrap: { type: Boolean, default: false },
    giftMessage: { type: String, maxlength: 300 },
    expiresAt: Date, // guests only
  },
  { timestamps: true },
);
cartSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
cartSchema.index({ guestId: 1 }, { unique: true, partialFilterExpression: { guestId: { $type: 'string' } } });
cartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const wishlistSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    product: { type: ObjectId, ref: 'Product', required: true },
    sku: String,
  },
  { timestamps: true },
);
wishlistSchema.index({ user: 1, product: 1 }, { unique: true });
wishlistSchema.index({ user: 1, createdAt: -1 });

module.exports = { Cart: mongoose.model('Cart', cartSchema), WishlistItem: mongoose.model('WishlistItem', wishlistSchema) };
