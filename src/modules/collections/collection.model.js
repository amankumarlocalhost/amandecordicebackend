'use strict';

const mongoose = require('mongoose');
const { seoSchema } = require('../categories/category.model');

/** Merchandising groups: brand lines, gift collections (wedding, housewarming), festive edits. */
const collectionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, enum: ['curated', 'gift', 'festival', 'brand', 'seasonal'], default: 'curated' },
    description: { type: String, maxlength: 2000 },
    image: { media: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload' }, url: String, key: String, mediumUrl: String, thumbUrl: String, alt: { type: String, maxlength: 160 } },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    startsAt: Date,
    endsAt: Date,
    seo: seoSchema,
  },
  { timestamps: true },
);
collectionSchema.index({ slug: 1 }, { unique: true });
collectionSchema.index({ isActive: 1, type: 1, sortOrder: 1 });
collectionSchema.index({ 'image.media': 1 }, { sparse: true });

module.exports = mongoose.model('Collection', collectionSchema);
