'use strict';

const Product = require('../products/product.model');
const User = require('../users/user.model');
const inventory = require('../inventory/inventory.service');
const shipping = require('../shipping/shipping.service');
const promotions = require('../promotions/promotion.service');
const { getSettings } = require('../settings/settings');
const { allocate, bpsOf, inclusiveTax } = require('../../utils/money');
const { PRODUCT_STATUS, PAYMENT_METHOD } = require('../../constants/statuses');
const env = require('../../config/env');

/**
 * Single source of truth for every amount shown at cart/checkout and stored on the order.
 * The client sends only SKUs, quantities, a coupon code, address and payment method.
 *
 * Discount precedence (documented business rule):
 *   1. Sale price  – variant.price (≤ MRP) is the starting unit price.
 *   2. Automatic promotions – each line receives at most ONE promotion: the one giving the
 *      customer the largest saving (ties → higher priority). Promotions never stack with each other.
 *   3. Coupon – applied to post-promotion amounts, only on lines where stacking is allowed by
 *      BOTH the coupon (stackableWithPromotions) and the line's promotion (stackableWithCoupons).
 *      Lines without a promotion are always coupon-eligible (subject to the coupon's scope).
 *   4. Shipping – computed on the discounted merchandise total; free-shipping offers zero it.
 *   5. Fees – COD fee and gift wrap.
 *   6. Tax – prices are GST-inclusive; tax is extracted per line (and from fees at the default rate).
 * Every split uses largest-remainder allocation so line amounts always sum to the totals.
 */

function scopeMatches(scope = {}, line) {
  if (scope.excludeProducts?.some((id) => String(id) === String(line.productId))) return false;
  switch (scope.appliesTo || 'all') {
    case 'all':
      return true;
    case 'products':
      return (scope.products || []).some((id) => String(id) === String(line.productId));
    case 'categories':
      return (scope.categories || []).some((id) => line.categoryPath.some((c) => String(c) === String(id)));
    case 'brands':
      return Boolean(line.brand) && (scope.brands || []).includes(line.brand.toLowerCase());
    case 'collections':
      return (scope.collections || []).some((id) => line.collections.some((c) => String(c) === String(id)));
    default:
      return false;
  }
}

function segmentMatches(segment, customer) {
  if (!segment || segment === 'all') return true;
  if (!customer) return false;
  if (segment === 'new_customers') return customer.ordersCount === 0;
  if (segment === 'repeat_customers') return customer.ordersCount > 0;
  return false;
}

/** Discount for a promo/coupon over a set of line bases; returns per-line amounts. */
function computeDiscount(def, bases) {
  const total = bases.reduce((a, b) => a + b, 0);
  if (!total) return { total: 0, perLine: bases.map(() => 0) };
  let amount = 0;
  if (def.discountType === 'percentage') amount = bpsOf(total, def.value);
  else if (def.discountType === 'fixed') amount = def.value;
  if (def.maxDiscount) amount = Math.min(amount, def.maxDiscount);
  amount = Math.min(amount, total);
  return { total: amount, perLine: allocate(amount, bases) };
}

async function loadCustomer(userId) {
  if (!userId) return null;
  const u = await User.findById(userId).select('stats phoneVerifiedAt').lean();
  if (!u) return null;
  // ordersCount is maintained on confirmation; it counts confirmed (non-failed) orders.
  return { id: String(u._id), ordersCount: u.stats?.ordersCount || 0, phoneVerified: Boolean(u.phoneVerifiedAt) };
}

async function buildLines(items, maxQty) {
  const skus = [...new Set(items.map((i) => String(i.sku).toUpperCase()))];
  const products = await Product.find({ 'variants.sku': { $in: skus } }).lean();
  const bySku = new Map();
  for (const p of products) for (const v of p.variants) if (skus.includes(v.sku)) bySku.set(v.sku, { p, v });

  const lines = [];
  const issues = [];
  for (const item of items) {
    const sku = String(item.sku).toUpperCase();
    const hit = bySku.get(sku);
    if (!hit || hit.p.status !== PRODUCT_STATUS.ACTIVE || hit.v.status === 'inactive') {
      issues.push({ sku, code: 'UNAVAILABLE', message: 'This item is no longer available' });
      continue;
    }
    const { p, v } = hit;
    const quantity = Math.min(item.quantity, maxQty);
    if (quantity !== item.quantity) issues.push({ sku, code: 'QTY_LIMIT', message: `Maximum ${maxQty} per item` });
    const comps = p.type === 'bundle' ? p.bundleItems.map((b) => ({ sku: b.sku, quantity: b.quantity, name: b.name, product: b.product })) : [];
    const compProducts = comps.length ? await Product.find({ 'variants.sku': { $in: comps.map((c) => c.sku) } }).select('variants specs packaging isFragile name').lean() : [];
    const compVariant = (sku) => {
      for (const cp of compProducts) {
        const cv = cp.variants.find((x) => x.sku === sku);
        if (cv) return { cp, cv };
      }
      return null;
    };
    const weightGrams =
      v.weightGrams || p.specs?.weightGrams || comps.reduce((sum, c) => sum + (compVariant(c.sku)?.cv.weightGrams || 0) * c.quantity, 0);
    lines.push({
      productId: String(p._id),
      variantId: String(v._id),
      sku,
      name: p.name,
      variantTitle: v.title,
      image: v.images?.[0] || Product.publicImages(p.images)[0]?.thumbUrl || Product.publicImages(p.images)[0]?.url,
      slug: p.slug,
      quantity,
      mrp: v.mrp,
      unitPrice: v.price,
      subtotal: v.price * quantity,
      categoryPath: p.categoryPath || [],
      brand: p.brand,
      collections: p.collections || [],
      gstRateBps: p.tax?.gstRateBps,
      hsnCode: p.tax?.hsnCode,
      isFragile: p.isFragile !== false,
      material: p.specs?.material,
      piecesPerSet: p.specs?.piecesPerSet,
      weightGrams,
      dimensions: v.dimensions || p.specs?.dimensions,
      packaging: p.packaging,
      giftWrapAvailable: p.giftWrapAvailable,
      returnPolicy: p.returnPolicy,
      bundleComponents: comps,
    });
  }
  return { lines, issues };
}

function applyPromotions(lines, promos, customer) {
  const assigned = new Array(lines.length).fill(null);
  const discounts = new Array(lines.length).fill(0);
  const applied = [];
  let freeShipping = null;
  const merchTotal = lines.reduce((a, l) => a + l.subtotal, 0);

  const candidates = promos
    .filter((p) => p.discountType !== 'free_shipping' && segmentMatches(p.segment, customer))
    .map((p) => ({ p, idx: lines.map((l, i) => (scopeMatches(p.scope, l) ? i : -1)).filter((i) => i >= 0) }))
    .filter((c) => c.idx.length);

  // Greedy best-saving-first assignment; recompute on remaining lines each round.
  for (;;) {
    let best = null;
    for (const c of candidates) {
      const free = c.idx.filter((i) => assigned[i] === null);
      if (!free.length) continue;
      const base = free.reduce((a, i) => a + lines[i].subtotal, 0);
      if (base < (c.p.minCartValue || 0)) continue;
      const d = computeDiscount(c.p, free.map((i) => lines[i].subtotal));
      if (d.total <= 0) continue;
      if (!best || d.total > best.d.total || (d.total === best.d.total && (c.p.priority || 0) > (best.c.p.priority || 0))) best = { c, d, free };
    }
    if (!best) break;
    best.free.forEach((lineIdx, k) => {
      assigned[lineIdx] = best.c.p;
      discounts[lineIdx] = best.d.perLine[k];
    });
    applied.push({ id: String(best.c.p._id), name: best.c.p.name, badge: best.c.p.badge, campaign: best.c.p._campaign?.name, discount: best.d.total, skus: best.free.map((i) => lines[i].sku) });
  }

  for (const p of promos.filter((x) => x.discountType === 'free_shipping' && segmentMatches(x.segment, customer))) {
    const eligible = lines.filter((l) => scopeMatches(p.scope, l)).reduce((a, l) => a + l.subtotal, 0);
    if (eligible > 0 && merchTotal >= (p.minCartValue || 0)) {
      freeShipping = { source: 'promotion', id: String(p._id), name: p.name };
      break;
    }
  }
  return { assigned, discounts, applied, freeShipping };
}

async function evaluateCoupon({ code, lines, assigned, promoDiscounts, customer, paymentMethod }) {
  const coupon = await promotions.findCoupon(code);
  const fail = (reason, message) => ({ result: { code: String(code).toUpperCase(), valid: false, reason, message }, coupon });
  if (!coupon) return fail('NOT_FOUND', 'Invalid coupon code');
  if (!promotions.isLive(coupon)) return fail('INACTIVE', 'This coupon is not active');
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return fail('EXHAUSTED', 'This coupon has reached its usage limit');
  if (!customer && (coupon.firstOrderOnly || coupon.segment !== 'all')) return fail('LOGIN_REQUIRED', 'Log in to use this coupon');
  if (customer) {
    if ((await promotions.customerUsage(coupon._id, customer.id)) >= (coupon.perCustomerLimit || 1)) return fail('ALREADY_USED', 'You have already used this coupon');
    if (coupon.firstOrderOnly && customer.ordersCount > 0) return fail('FIRST_ORDER_ONLY', 'This coupon is valid on your first order only');
  }
  if (!segmentMatches(coupon.segment, customer)) return fail('SEGMENT', 'This coupon is not available for your account');
  if (paymentMethod && coupon.paymentMethods?.length && !coupon.paymentMethods.includes(paymentMethod)) {
    return fail('PAYMENT_METHOD', `Valid only with ${coupon.paymentMethods.map((m) => m.toUpperCase()).join(' / ')} payments`);
  }

  const eligibleIdx = lines
    .map((l, i) => {
      if (!scopeMatches(coupon.scope, l)) return -1;
      const promo = assigned[i];
      if (promo && !(coupon.stackableWithPromotions && promo.stackableWithCoupons !== false)) return -1;
      return i;
    })
    .filter((i) => i >= 0);
  if (!eligibleIdx.length) return fail('NOT_APPLICABLE', 'This coupon does not apply to items in your cart (or cannot be combined with current offers)');
  const bases = eligibleIdx.map((i) => lines[i].subtotal - promoDiscounts[i]);
  const eligibleTotal = bases.reduce((a, b) => a + b, 0);
  if (eligibleTotal < (coupon.minCartValue || 0)) {
    return fail('MIN_CART', `Add items worth ₹${((coupon.minCartValue - eligibleTotal) / 100).toFixed(2)} more to use this coupon`);
  }
  const perLine = new Array(lines.length).fill(0);
  let total = 0;
  let freeShipping = false;
  if (coupon.discountType === 'free_shipping') freeShipping = true;
  else {
    const d = computeDiscount(coupon, bases);
    total = d.total;
    eligibleIdx.forEach((lineIdx, k) => (perLine[lineIdx] = d.perLine[k]));
  }
  return {
    coupon,
    perLine,
    freeShipping,
    result: { code: coupon.code, valid: true, id: String(coupon._id), description: coupon.description, discount: total, freeShipping },
  };
}

/**
 * @returns quote with lines, totals, payment options, and blocking `issues`.
 */
async function quote({ userId, items, couponCode, pincode, paymentMethod, giftWrap = false, checkStock = true }) {
  const settings = await getSettings();
  const [customer, { lines, issues }, promos] = await Promise.all([loadCustomer(userId), buildLines(items, settings.checkout.maxQuantityPerItem), promotions.activePromotions()]);

  if (checkStock && lines.length) {
    const avail = await inventory.getAvailability([...new Set(inventory.expandLines(lines).map((i) => i.sku))]);
    const needed = new Map(inventory.expandLines(lines).map((i) => [i.sku, i.quantity]));
    for (const l of lines) {
      const comps = l.bundleComponents.length ? l.bundleComponents.map((c) => c.sku) : [l.sku];
      const short = comps.find((s) => (avail[s] ?? 0) < needed.get(s));
      if (short) {
        const units = l.bundleComponents.length
          ? Math.min(...l.bundleComponents.map((c) => Math.floor((avail[c.sku] ?? 0) / c.quantity)))
          : avail[l.sku] ?? 0;
        l.available = units;
        issues.push({ sku: l.sku, code: units > 0 ? 'INSUFFICIENT_STOCK' : 'OUT_OF_STOCK', message: units > 0 ? `Only ${units} left` : 'Out of stock', available: units });
      }
    }
  }

  const { assigned, discounts: promoDiscounts, applied, freeShipping: promoFreeShipping } = applyPromotions(lines, promos, customer);

  let couponEval = null;
  if (couponCode) couponEval = await evaluateCoupon({ code: couponCode, lines, assigned, promoDiscounts, customer, paymentMethod });
  const couponPerLine = couponEval?.perLine || new Array(lines.length).fill(0);

  const defaultRate = settings.tax.defaultGstRateBps;
  const pricedLines = lines.map((l, i) => {
    const promotionDiscount = promoDiscounts[i];
    const couponDiscount = couponPerLine[i];
    const total = l.subtotal - promotionDiscount - couponDiscount;
    const gstRateBps = l.gstRateBps ?? defaultRate;
    return {
      ...l,
      promotion: assigned[i] ? { id: String(assigned[i]._id), name: assigned[i].name } : null,
      promotionDiscount,
      couponDiscount,
      total,
      gstRateBps,
      taxAmount: inclusiveTax(total, gstRateBps),
    };
  });

  const mrpTotal = pricedLines.reduce((a, l) => a + l.mrp * l.quantity, 0);
  const subtotal = pricedLines.reduce((a, l) => a + l.subtotal, 0);
  const promotionDiscount = pricedLines.reduce((a, l) => a + l.promotionDiscount, 0);
  const couponDiscount = pricedLines.reduce((a, l) => a + l.couponDiscount, 0);
  const merchandiseTotal = subtotal - promotionDiscount - couponDiscount;

  const freeShipping = promoFreeShipping || (couponEval?.freeShipping ? { source: 'coupon', id: couponEval.result.id } : null);
  const ship = await shipping.calculateShipping({ lines: pricedLines, merchandiseTotal, pincode, freeShipping: Boolean(freeShipping) });
  if (pincode && ship.serviceability && !ship.serviceability.serviceable) issues.push({ code: 'PINCODE_NOT_SERVICEABLE', message: `We do not deliver to ${pincode} yet` });

  const giftWrapAllowed = settings.giftWrap.enabled && pricedLines.some((l) => l.giftWrapAvailable);
  const giftWrapFee = giftWrap && giftWrapAllowed ? settings.giftWrap.fee : 0;
  const preFeeTotal = merchandiseTotal + ship.fee + giftWrapFee;

  // Payment options are evaluated on the pre-COD-fee total.
  const upiAvailable = settings.upi.enabled && env.features.razorpay;
  const codReasons = [];
  if (!settings.cod.enabled) codReasons.push('COD is currently unavailable');
  if (preFeeTotal + settings.cod.fee > settings.cod.maxOrderValue) codReasons.push(`COD is available for orders up to ₹${settings.cod.maxOrderValue / 100}`);
  if (preFeeTotal < settings.cod.minOrderValue) codReasons.push(`COD needs a minimum order of ₹${settings.cod.minOrderValue / 100}`);
  if (ship.serviceability && !ship.serviceability.codAvailable) codReasons.push('COD is not available for this PIN code');
  if (settings.cod.requireVerifiedPhone && customer && !customer.phoneVerified) codReasons.push('Verify your phone number to use COD');
  const paymentOptions = {
    upi: { available: upiAvailable, ...(upiAvailable ? {} : { reason: 'Online UPI payments are not configured' }) },
    cod: { available: codReasons.length === 0, fee: settings.cod.fee, ...(codReasons.length ? { reason: codReasons[0] } : {}) },
  };

  const codFee = paymentMethod === PAYMENT_METHOD.COD ? settings.cod.fee : 0;
  const chargesTax = inclusiveTax(ship.fee + giftWrapFee + codFee, defaultRate);
  const taxTotal = pricedLines.reduce((a, l) => a + l.taxAmount, 0) + chargesTax;
  const total = preFeeTotal + codFee;

  if (couponCode && couponEval && !couponEval.result.valid) issues.push({ code: 'COUPON_INVALID', message: couponEval.result.message });
  if (paymentMethod && !paymentOptions[paymentMethod]?.available) {
    issues.push({ code: 'PAYMENT_METHOD_UNAVAILABLE', message: paymentOptions[paymentMethod]?.reason || 'Payment method unavailable' });
  }

  return {
    currency: 'INR',
    lines: pricedLines,
    totals: {
      mrpTotal,
      subtotal,
      saleSavings: mrpTotal - subtotal,
      promotionDiscount,
      couponDiscount,
      merchandiseTotal,
      shippingFee: ship.fee,
      giftWrapFee,
      codFee,
      taxTotal,
      chargesTax,
      total,
      totalSavings: mrpTotal - subtotal + promotionDiscount + couponDiscount + (ship.freeShippingApplied ? ship.grossFee : 0),
    },
    appliedPromotions: applied,
    coupon: couponEval?.result || null,
    _coupon: couponEval?.result?.valid ? couponEval.coupon : null,
    shipping: { fee: ship.fee, grossFee: ship.grossFee, freeShippingApplied: ship.freeShippingApplied, freeShippingThreshold: ship.freeShippingThreshold, breakdown: ship.breakdown, weights: ship.weights, serviceability: ship.serviceability, freeShippingSource: freeShipping },
    giftWrap: { available: giftWrapAllowed, selected: giftWrapFee > 0, fee: settings.giftWrap.fee },
    paymentOptions,
    issues,
  };
}

/** Public projection of a quote (removes internal fields). */
function publicQuote(q) {
  const { _coupon, ...rest } = q;
  return {
    ...rest,
    lines: q.lines.map(({ categoryPath, collections, packaging, bundleComponents, returnPolicy, dimensions, ...l }) => ({
      ...l,
      bundleComponents: bundleComponents.length ? bundleComponents.map((c) => ({ sku: c.sku, quantity: c.quantity, name: c.name })) : undefined,
    })),
  };
}

module.exports = { quote, publicQuote, scopeMatches, computeDiscount, applyPromotions, segmentMatches };
