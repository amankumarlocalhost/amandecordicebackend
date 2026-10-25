'use strict';

const { Campaign, Promotion, Coupon, CouponUsage, CouponRedemption } = require('./promotion.models');
const cache = require('../../services/cache');
const { conflict } = require('../../utils/errors');

/** A promotion/coupon is live when it, and its campaign if any, are active and inside their windows. */
async function activePromotions(now = new Date()) {
  const promos = await cache.wrap(cache.NS.PROMOTIONS, 'active', 30, async () => {
    const list = await Promotion.find({ isActive: true, startsAt: { $lte: new Date(Date.now() + 60000) }, endsAt: { $gte: new Date() } }).lean();
    const campaignIds = [...new Set(list.filter((p) => p.campaign).map((p) => String(p.campaign)))];
    const campaigns = campaignIds.length ? await Campaign.find({ _id: { $in: campaignIds } }).select('isActive startsAt endsAt name').lean() : [];
    const byId = Object.fromEntries(campaigns.map((c) => [String(c._id), c]));
    return list.map((p) => ({ ...p, _campaign: p.campaign ? byId[String(p.campaign)] || null : undefined }));
  });
  return promos.filter((p) => isLive(p, now));
}

function isLive(item, now = new Date()) {
  const inWindow = (x) => new Date(x.startsAt) <= now && new Date(x.endsAt) >= now;
  if (!item.isActive || !inWindow(item)) return false;
  if (item._campaign === null) return false;
  if (item._campaign && (!item._campaign.isActive || !inWindow(item._campaign))) return false;
  return true;
}

async function findCoupon(code) {
  const coupon = await Coupon.findOne({ code: String(code).toUpperCase().trim() }).lean();
  if (!coupon) return null;
  if (coupon.campaign) coupon._campaign = (await Campaign.findById(coupon.campaign).select('isActive startsAt endsAt').lean()) || null;
  return coupon;
}

async function customerUsage(couponId, userId) {
  if (!userId) return 0;
  const u = await CouponUsage.findOne({ coupon: couponId, user: userId }).select('count').lean();
  return u?.count || 0;
}

/**
 * Atomically consumes one global use and one per-customer use. Both guards are conditional
 * updates, so concurrent orders cannot exceed either limit. Must run inside the order transaction.
 */
async function redeemCoupon({ coupon, userId, orderId, discount, session }) {
  const s = session ? { session } : {};
  const global = await Coupon.findOneAndUpdate(
    { _id: coupon._id, isActive: true, $or: [{ usageLimit: null }, { usageLimit: { $exists: false } }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
    { $inc: { usedCount: 1 } },
    { new: true, ...s },
  );
  if (!global) throw conflict('This coupon has reached its usage limit', 'COUPON_EXHAUSTED');
  try {
    await CouponUsage.findOneAndUpdate(
      { coupon: coupon._id, user: userId, count: { $lt: coupon.perCustomerLimit || 1 } },
      { $inc: { count: 1 } },
      { upsert: true, new: true, ...s },
    );
  } catch (err) {
    if (err.code === 11000) {
      if (!session) await Coupon.updateOne({ _id: coupon._id }, { $inc: { usedCount: -1 } });
      throw conflict('You have already used this coupon the maximum number of times', 'COUPON_LIMIT_REACHED');
    }
    throw err;
  }
  await CouponRedemption.create([{ coupon: coupon._id, code: coupon.code, user: userId, order: orderId, discount, status: 'redeemed' }], s);
}

/** Gives the use back (order cancelled before fulfilment / payment failed). Idempotent. */
async function releaseCoupon(orderId, { session } = {}) {
  const s = session ? { session } : {};
  const r = await CouponRedemption.findOneAndUpdate({ order: orderId, status: 'redeemed' }, { $set: { status: 'released' } }, { new: true, ...s });
  if (!r) return false;
  await Coupon.updateOne({ _id: r.coupon, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, s);
  await CouponUsage.updateOne({ coupon: r.coupon, user: r.user, count: { $gt: 0 } }, { $inc: { count: -1 } }, s);
  return true;
}

/** Promotions change storefront prices and the homepage banner, so the storefront is resynced too. */
async function invalidate() {
  await cache.bump(cache.NS.PROMOTIONS, cache.NS.CATALOG);
  const sync = require('../../services/sync');
  sync.changed({ tags: [sync.TAGS.PROMOTIONS, sync.TAGS.CATALOG], events: [{ event: sync.EVENTS.PROMOTIONS_UPDATED, key: 'promotions' }, { event: sync.EVENTS.BANNER_UPDATED, key: 'campaign' }] });
}

module.exports = { activePromotions, isLive, findCoupon, customerUsage, redeemCoupon, releaseCoupon, invalidate };
