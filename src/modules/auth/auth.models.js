'use strict';

const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

/** One document per login session; the refresh token rotates inside it. */
const sessionSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true },
    prevTokenHash: String,
    rotatedAt: Date,
    isStaff: { type: Boolean, default: false },
    userAgent: { type: String, maxlength: 300 },
    ip: String,
    lastUsedAt: Date,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
  },
  { timestamps: true },
);
sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ prevTokenHash: 1 }, { sparse: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

/** OTPs and single-use links. Only hashes are stored. */
const oneTimeCodeSchema = new mongoose.Schema(
  {
    purpose: {
      type: String,
      enum: ['verify_phone', 'login_phone', 'reset_password_phone', 'verify_email', 'reset_password_email'],
      required: true,
    },
    target: { type: String, required: true },
    user: { type: ObjectId, ref: 'User' },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    expiresAt: { type: Date, required: true },
    consumedAt: Date,
  },
  { timestamps: true },
);
oneTimeCodeSchema.index({ target: 1, purpose: 1, createdAt: -1 });
oneTimeCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const Session = mongoose.model('Session', sessionSchema);
const OneTimeCode = mongoose.model('OneTimeCode', oneTimeCodeSchema);

module.exports = { Session, OneTimeCode };
