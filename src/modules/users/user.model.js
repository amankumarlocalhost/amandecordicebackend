'use strict';

const mongoose = require('mongoose');
const { ROLES } = require('../../constants/roles');

const channelPrefs = new mongoose.Schema(
  {
    orders: { type: Boolean, default: true },
    support: { type: Boolean, default: true },
    marketing: { type: Boolean, default: false },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 16 },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: Object.values(ROLES), default: ROLES.CUSTOMER, index: true },
    status: {
      type: String,
      enum: ['active', 'suspended', 'deactivated', 'deletion_requested', 'deleted'],
      default: 'active',
      index: true,
    },
    emailVerifiedAt: Date,
    phoneVerifiedAt: Date,
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },
    lastLoginAt: Date,
    passwordChangedAt: Date,
    notificationPreferences: {
      inApp: { type: channelPrefs, default: () => ({ marketing: true }) },
      email: { type: channelPrefs, default: () => ({}) },
      sms: { type: channelPrefs, default: () => ({}) },
      whatsapp: { type: channelPrefs, default: () => ({ orders: false, support: false }) },
    },
    stats: {
      ordersCount: { type: Number, default: 0 },
      totalSpent: { type: Number, default: 0 },
      firstOrderAt: Date,
      lastOrderAt: Date,
    },
    deactivatedAt: Date,
    deletionRequestedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ createdAt: -1 });

userSchema.virtual('isStaff').get(function isStaff() {
  return this.role !== ROLES.CUSTOMER;
});

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    role: this.role,
    status: this.status,
    emailVerified: Boolean(this.emailVerifiedAt),
    phoneVerified: Boolean(this.phoneVerifiedAt),
    notificationPreferences: this.notificationPreferences,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
