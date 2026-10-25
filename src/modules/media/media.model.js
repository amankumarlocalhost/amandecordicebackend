'use strict';

const mongoose = require('mongoose');
const { MEDIA_STATUS } = require('../../constants/statuses');

const { ObjectId } = mongoose.Schema.Types;

/** Purposes uploaded by staff for the storefront; these go through review. Customer purposes do not. */
const CATALOG_PURPOSES = ['product', 'category', 'collection', 'banner', 'content'];
const CUSTOMER_PURPOSES = ['review', 'return', 'chat'];

const historySchema = new mongoose.Schema(
  { action: { type: String, required: true }, by: { type: ObjectId, ref: 'User' }, at: { type: Date, default: Date.now }, note: { type: String, maxlength: 500 } },
  { _id: false },
);

const uploadSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: [...CATALOG_PURPOSES, ...CUSTOMER_PURPOSES], required: true },
    kind: { type: String, enum: ['image', 'video'], default: 'image' },
    // 'unsplash' = a hotlinked Unsplash photo (their API terms forbid re-hosting); nothing is stored by us.
    provider: { type: String, enum: ['local', 's3', 'cloudinary', 'unsplash'], default: 'local' },
    key: { type: String, required: true }, // storage key, Cloudinary public_id, or unsplash:<photo id>
    version: Number, // Cloudinary asset version (changes when a private asset is published)
    // Public delivery URLs. Empty while the asset is private (pending review / rejected).
    url: String,
    thumbUrl: String,
    mediumUrl: String,
    posterUrl: String, // videos
    durationSec: Number, // videos
    width: Number,
    height: Number,
    bytes: Number,
    contentType: String,
    originalName: { type: String, maxlength: 160 },
    isPrivate: { type: Boolean, default: false },
    /** Intended placement, shown to reviewers (e.g. the product the image was uploaded for). */
    target: { type: { type: String, enum: ['product', 'category', 'collection', 'campaign', 'content'] }, id: String },
    review: {
      status: { type: String, enum: Object.values(MEDIA_STATUS) },
      reviewedBy: { type: ObjectId, ref: 'User' },
      reviewedAt: Date,
      reason: { type: String, maxlength: 500 },
      replacementRequested: Boolean,
    },
    /**
     * Where an imported (not uploaded) image came from, for attribution and audit. rawUrl is the
     * hotlink base; it is only copied to the public url fields once a reviewer approves the image.
     */
    source: {
      type: new mongoose.Schema(
        {
          provider: { type: String, enum: ['unsplash'] },
          photoId: String,
          pageUrl: String,
          rawUrl: String,
          downloadLocation: String,
          author: { type: String, maxlength: 120 },
          authorUrl: String,
          description: { type: String, maxlength: 300 },
          query: { type: String, maxlength: 120 },
          verifiedAt: Date,
          downloadTrackedAt: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },
    replaces: { type: ObjectId, ref: 'Upload' },
    replacedBy: { type: ObjectId, ref: 'Upload' },
    supersededAt: Date,
    history: { type: [historySchema], default: undefined },
  },
  { timestamps: true },
);
uploadSchema.index({ owner: 1, purpose: 1, createdAt: -1 });
uploadSchema.index({ 'review.status': 1, createdAt: -1 });
uploadSchema.index({ purpose: 1, 'review.status': 1, createdAt: -1 });
uploadSchema.index({ 'target.type': 1, 'target.id': 1 });
uploadSchema.index({ url: 1 }, { sparse: true });
uploadSchema.index({ 'source.provider': 1, 'source.photoId': 1 }, { sparse: true });

const Upload = mongoose.model('Upload', uploadSchema);

module.exports = { Upload, CATALOG_PURPOSES, CUSTOMER_PURPOSES };
