'use strict';

const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, maxlength: 16 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    landmark: { type: String, trim: true, maxlength: 100 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    state: { type: String, required: true, trim: true, maxlength: 80 },
    pincode: { type: String, required: true, match: /^[1-9]\d{5}$/ },
    country: { type: String, default: 'IN', enum: ['IN'] },
    type: { type: String, enum: ['home', 'work', 'other'], default: 'home' },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);
addressSchema.index({ user: 1, isDefault: -1, updatedAt: -1 });

module.exports = mongoose.model('Address', addressSchema);
