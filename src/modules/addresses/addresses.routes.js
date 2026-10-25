'use strict';

const { z } = require('zod');
const Address = require('./address.model');
const { createRouter } = require('../../utils/router');
const { ok, created } = require('../../utils/response');
const { notFound, badRequest } = require('../../utils/errors');
const { objectId, phoneSchema } = require('../../utils/common');
const shipping = require('../shipping/shipping.service');

const MAX_ADDRESSES = 20;

const addressBody = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: phoneSchema,
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(100).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z.string().regex(/^[1-9]\d{5}$/, 'Invalid PIN code'),
  type: z.enum(['home', 'work', 'other']).default('home'),
  isDefault: z.boolean().optional(),
});

async function setDefault(userId, addressId) {
  await Address.updateMany({ user: userId, _id: { $ne: addressId } }, { $set: { isDefault: false } });
  await Address.updateOne({ _id: addressId, user: userId }, { $set: { isDefault: true } });
}

const api = createRouter({ prefix: '/api/v1/addresses', tag: 'Addresses' });

api.get('/', { summary: 'List my addresses', customer: true }, async (req, res) => {
  ok(res, await Address.find({ user: req.auth.userId }).sort({ isDefault: -1, updatedAt: -1 }).lean());
});

api.post('/', { summary: 'Add an address', customer: true, body: addressBody }, async (req, res) => {
  const count = await Address.countDocuments({ user: req.auth.userId });
  if (count >= MAX_ADDRESSES) throw badRequest(`You can save up to ${MAX_ADDRESSES} addresses`);
  const address = await Address.create({ ...req.body, user: req.auth.userId, isDefault: false });
  if (req.body.isDefault || count === 0) await setDefault(req.auth.userId, address._id);
  const serviceability = await shipping.checkServiceability(address.pincode);
  created(res, { ...(await Address.findById(address._id).lean()), serviceability });
});

api.patch('/:id', { summary: 'Update an address', customer: true, params: z.object({ id: objectId() }), body: addressBody.partial() }, async (req, res) => {
  const { isDefault, ...rest } = req.body;
  const address = await Address.findOneAndUpdate({ _id: req.params.id, user: req.auth.userId }, { $set: rest }, { new: true });
  if (!address) throw notFound('Address');
  if (isDefault) await setDefault(req.auth.userId, address._id);
  ok(res, await Address.findById(address._id).lean(), { message: 'Address updated' });
});

api.post('/:id/default', { summary: 'Make an address the default', customer: true, params: z.object({ id: objectId() }) }, async (req, res) => {
  const exists = await Address.exists({ _id: req.params.id, user: req.auth.userId });
  if (!exists) throw notFound('Address');
  await setDefault(req.auth.userId, req.params.id);
  ok(res, null, { message: 'Default address updated' });
});

api.delete('/:id', { summary: 'Delete an address', customer: true, params: z.object({ id: objectId() }) }, async (req, res) => {
  const address = await Address.findOneAndDelete({ _id: req.params.id, user: req.auth.userId });
  if (!address) throw notFound('Address');
  if (address.isDefault) {
    const next = await Address.findOne({ user: req.auth.userId }).sort({ updatedAt: -1 });
    if (next) await setDefault(req.auth.userId, next._id);
  }
  ok(res, null, { message: 'Address deleted' });
});

module.exports = { router: api, addressBody };
