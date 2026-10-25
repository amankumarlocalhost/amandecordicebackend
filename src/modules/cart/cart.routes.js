'use strict';

const { z } = require('zod');
const service = require('./cart.service');
const { WishlistItem } = require('./cart.model');
const Product = require('../products/product.model');
const productService = require('../products/product.service');
const { createRouter } = require('../../utils/router');
const { ok } = require('../../utils/response');
const { notFound } = require('../../utils/errors');
const { objectId, paginationSchema, pageMeta } = require('../../utils/common');
const { PRODUCT_STATUS } = require('../../constants/statuses');

const sku = z.string().trim().toUpperCase().min(2).max(64);

const cart = createRouter({ prefix: '/api/v1/cart', tag: 'Cart' });
const viewQuery = z.object({ pincode: z.string().regex(/^[1-9]\d{5}$/).optional(), paymentMethod: z.enum(['upi', 'cod']).optional() });

cart.get('/', { summary: 'Cart with a fresh server-side price quote (guest or customer)', auth: 'optional', query: viewQuery }, async (req, res) => {
  ok(res, await service.view(req, res, req.query));
});

cart.post('/items', { summary: 'Add an item (increments quantity)', auth: 'optional', body: z.object({ sku, quantity: z.number().int().min(1).max(100).default(1) }) }, async (req, res) => {
  await service.addItem(req, res, req.body);
  ok(res, await service.view(req, res), { message: 'Added to cart' });
});

cart.patch('/items/:sku', { summary: 'Set quantity (0 removes)', auth: 'optional', params: z.object({ sku }), body: z.object({ quantity: z.number().int().min(0).max(500) }) }, async (req, res) => {
  await service.setQuantity(req, res, req.params.sku, req.body.quantity);
  ok(res, await service.view(req, res), { message: 'Cart updated' });
});

cart.delete('/items/:sku', { summary: 'Remove an item', auth: 'optional', params: z.object({ sku }) }, async (req, res) => {
  await service.removeItem(req, res, req.params.sku);
  ok(res, await service.view(req, res), { message: 'Removed from cart' });
});

cart.delete('/', { summary: 'Clear the cart', auth: 'optional' }, async (req, res) => {
  await service.clear(req, res);
  ok(res, await service.view(req, res), { message: 'Cart cleared' });
});

cart.post('/coupon', { summary: 'Apply a coupon (validated server-side)', auth: 'optional', body: z.object({ code: z.string().trim().min(3).max(30) }) }, async (req, res) => {
  const coupon = await service.applyCoupon(req, res, req.body.code);
  ok(res, { coupon, cart: await service.view(req, res) }, { message: 'Coupon applied' });
});

cart.delete('/coupon', { summary: 'Remove the coupon', auth: 'optional' }, async (req, res) => {
  await service.removeCoupon(req, res);
  ok(res, await service.view(req, res), { message: 'Coupon removed' });
});

cart.patch('/options', { summary: 'Gift wrap and gift message', auth: 'optional', body: z.object({ giftWrap: z.boolean(), giftMessage: z.string().trim().max(300) }).partial() }, async (req, res) => {
  await service.setOptions(req, res, req.body);
  ok(res, await service.view(req, res), { message: 'Cart updated' });
});

// ------------------------------------------------------------------ wishlist
const wish = createRouter({ prefix: '/api/v1/wishlist', tag: 'Wishlist' });

wish.get('/', { summary: 'My wishlist', customer: true, query: paginationSchema }, async (req, res) => {
  const { page, limit } = req.query;
  const filter = { user: req.auth.userId };
  const [rows, total] = await Promise.all([WishlistItem.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), WishlistItem.countDocuments(filter)]);
  const products = await Product.find({ _id: { $in: rows.map((r) => r.product) } }).select(Product.PUBLIC_PROJECTION).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const items = rows.map((r) => {
    const p = byId.get(String(r.product));
    return { productId: r.product, sku: r.sku, addedAt: r.createdAt, product: p && p.status === PRODUCT_STATUS.ACTIVE ? productService.listCard(p) : null, available: Boolean(p && p.status === PRODUCT_STATUS.ACTIVE) };
  });
  ok(res, items, { meta: pageMeta(page, limit, total) });
});

wish.post('/', { summary: 'Add to wishlist', customer: true, body: z.object({ productId: objectId(), sku: sku.optional() }) }, async (req, res) => {
  if (!(await Product.exists({ _id: req.body.productId, status: PRODUCT_STATUS.ACTIVE }))) throw notFound('Product');
  await WishlistItem.updateOne({ user: req.auth.userId, product: req.body.productId }, { $set: { sku: req.body.sku } }, { upsert: true });
  ok(res, null, { message: 'Added to wishlist' });
});

wish.delete('/:productId', { summary: 'Remove from wishlist', customer: true, params: z.object({ productId: objectId() }) }, async (req, res) => {
  await WishlistItem.deleteOne({ user: req.auth.userId, product: req.params.productId });
  ok(res, null, { message: 'Removed from wishlist' });
});

wish.post('/:productId/move-to-cart', { summary: 'Move a wishlist item to the cart', customer: true, params: z.object({ productId: objectId() }), body: z.object({ sku }) }, async (req, res) => {
  await service.addItem(req, res, { sku: req.body.sku, quantity: 1 });
  await WishlistItem.deleteOne({ user: req.auth.userId, product: req.params.productId });
  ok(res, await service.view(req, res), { message: 'Moved to cart' });
});

module.exports = { routers: [cart, wish] };
