'use strict';

const { Cart } = require('./cart.model');
const Product = require('../products/product.model');
const Address = require('../addresses/address.model');
const inventory = require('../inventory/inventory.service');
const pricing = require('../pricing/pricing.service');
const { getSettings } = require('../settings/settings');
const { cookieBase } = require('../../middleware/security');
const { randomToken } = require('../../utils/crypto');
const { badRequest, notFound, conflict, forbidden } = require('../../utils/errors');
const { PRODUCT_STATUS } = require('../../constants/statuses');

const GUEST_COOKIE = 'guest_cart';
const GUEST_TTL_DAYS = 30;

function guestId(req) {
  // A guest cart created earlier in this same request (cookie only exists on the response so far).
  if (req.issuedGuestCartId) return req.issuedGuestCartId;
  const v = req.signedCookies?.[GUEST_COOKIE];
  return typeof v === 'string' && /^[\w-]{20,64}$/.test(v) ? v : null;
}

/** Resolves the cart owner: logged-in customer, or the signed guest cookie (created on demand). */
async function ownerFilter(req, res, { create = false } = {}) {
  if (req.auth) {
    if (req.auth.isStaff) throw forbidden('Staff accounts cannot use the cart');
    return { user: req.auth.userId };
  }
  const settings = await getSettings();
  if (!settings.checkout.allowGuestCart) throw forbidden('Please log in to use the cart');
  let gid = guestId(req);
  if (!gid && create) {
    gid = randomToken(24);
    res.cookie(GUEST_COOKIE, gid, { ...cookieBase(), httpOnly: true, signed: true, maxAge: GUEST_TTL_DAYS * 86400000 });
    req.issuedGuestCartId = gid;
  }
  return gid ? { guestId: gid } : null;
}

async function getCartDoc(req, res, { create = false } = {}) {
  const owner = await ownerFilter(req, res, { create });
  if (!owner) return null;
  let cart = await Cart.findOne(owner);
  if (!cart && create) {
    cart = await Cart.findOneAndUpdate(
      owner,
      { $setOnInsert: { ...owner, items: [], ...(owner.guestId ? { expiresAt: new Date(Date.now() + GUEST_TTL_DAYS * 86400000) } : {}) } },
      { upsert: true, new: true },
    );
  }
  return cart;
}

async function resolvePincode(userId, pincode) {
  if (pincode) return pincode;
  if (!userId) return undefined;
  const addr = await Address.findOne({ user: userId }).sort({ isDefault: -1, updatedAt: -1 }).select('pincode').lean();
  return addr?.pincode;
}

async function view(req, res, { pincode, paymentMethod } = {}) {
  const cart = await getCartDoc(req, res);
  if (!cart || !cart.items.length) {
    return { items: [], couponCode: cart?.couponCode || null, giftWrap: false, quote: null };
  }
  const q = await pricing.quote({
    userId: req.auth?.userId,
    items: cart.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    couponCode: cart.couponCode,
    pincode: await resolvePincode(req.auth?.userId, pincode),
    paymentMethod,
    giftWrap: cart.giftWrap,
  });
  return { items: cart.items, couponCode: cart.couponCode || null, giftWrap: cart.giftWrap, giftMessage: cart.giftMessage, quote: pricing.publicQuote(q) };
}

async function loadSellable(sku) {
  const product = await Product.findOne({ 'variants.sku': sku, status: PRODUCT_STATUS.ACTIVE }).select('type variants bundleItems status').lean();
  const variant = product?.variants.find((v) => v.sku === sku);
  if (!product || !variant || variant.status === 'inactive') throw notFound('Product');
  return { product, variant };
}

async function checkQuantity(product, sku, quantity) {
  const settings = await getSettings();
  if (quantity > settings.checkout.maxQuantityPerItem) throw badRequest(`You can buy at most ${settings.checkout.maxQuantityPerItem} of this item`, undefined, 'QTY_LIMIT');
  const avail = (await inventory.productAvailability(product))[sku] ?? 0;
  if (avail < quantity) throw conflict(avail > 0 ? `Only ${avail} left in stock` : 'This item is out of stock', 'OUT_OF_STOCK', { sku, available: avail });
}

async function addItem(req, res, { sku, quantity }) {
  const { product } = await loadSellable(sku);
  const cart = await getCartDoc(req, res, { create: true });
  const settings = await getSettings();
  const existing = cart.items.find((i) => i.sku === sku);
  const nextQty = (existing?.quantity || 0) + quantity;
  await checkQuantity(product, sku, nextQty);
  if (!existing && cart.items.length >= settings.checkout.maxLinesPerOrder) throw badRequest('Your cart is full');
  if (existing) existing.quantity = nextQty;
  else cart.items.push({ product: product._id, sku, quantity });
  await cart.save();
}

async function setQuantity(req, res, sku, quantity) {
  const cart = await getCartDoc(req, res);
  const line = cart?.items.find((i) => i.sku === sku);
  if (!line) throw notFound('Cart item');
  if (quantity === 0) cart.items = cart.items.filter((i) => i.sku !== sku);
  else {
    const { product } = await loadSellable(sku);
    await checkQuantity(product, sku, quantity);
    line.quantity = quantity;
  }
  await cart.save();
}

async function removeItem(req, res, sku) {
  const owner = await ownerFilter(req, res);
  if (owner) await Cart.updateOne(owner, { $pull: { items: { sku } } });
}

async function clear(req, res) {
  const owner = await ownerFilter(req, res);
  if (owner) await Cart.updateOne(owner, { $set: { items: [], couponCode: null, giftWrap: false, giftMessage: null } });
}

async function applyCoupon(req, res, code) {
  const cart = await getCartDoc(req, res);
  if (!cart || !cart.items.length) throw badRequest('Your cart is empty');
  const q = await pricing.quote({ userId: req.auth?.userId, items: cart.items.map((i) => ({ sku: i.sku, quantity: i.quantity })), couponCode: code, checkStock: false });
  if (!q.coupon?.valid) throw badRequest(q.coupon?.message || 'Invalid coupon', { reason: q.coupon?.reason }, 'COUPON_INVALID');
  cart.couponCode = q.coupon.code;
  await cart.save();
  return q.coupon;
}

async function removeCoupon(req, res) {
  const owner = await ownerFilter(req, res);
  if (owner) await Cart.updateOne(owner, { $unset: { couponCode: 1 } });
}

async function setOptions(req, res, { giftWrap, giftMessage }) {
  const cart = await getCartDoc(req, res, { create: true });
  if (giftWrap !== undefined) cart.giftWrap = giftWrap;
  if (giftMessage !== undefined) cart.giftMessage = giftMessage;
  await cart.save();
}

/** Called after customer login/registration: guest lines are merged into the account cart. */
async function mergeGuestCart(req, res, userId) {
  const gid = guestId(req);
  if (!gid) return;
  const guest = await Cart.findOne({ guestId: gid });
  res.clearCookie(GUEST_COOKIE, { ...cookieBase() });
  if (!guest || !guest.items.length) {
    if (guest) await guest.deleteOne();
    return;
  }
  const settings = await getSettings();
  const cart = await Cart.findOneAndUpdate({ user: userId }, { $setOnInsert: { user: userId, items: [] } }, { upsert: true, new: true });
  for (const g of guest.items) {
    const line = cart.items.find((i) => i.sku === g.sku);
    if (line) line.quantity = Math.min(settings.checkout.maxQuantityPerItem, line.quantity + g.quantity);
    else if (cart.items.length < settings.checkout.maxLinesPerOrder) cart.items.push({ product: g.product, sku: g.sku, quantity: g.quantity });
  }
  if (!cart.couponCode && guest.couponCode) cart.couponCode = guest.couponCode;
  await cart.save();
  await guest.deleteOne();
}

module.exports = { view, addItem, setQuantity, removeItem, clear, applyCoupon, removeCoupon, setOptions, mergeGuestCart, getCartDoc, GUEST_COOKIE };
