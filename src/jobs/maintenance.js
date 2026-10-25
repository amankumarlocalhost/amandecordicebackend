'use strict';

const logger = require('../config/logger');
const cache = require('../services/cache');

const DELETION_GRACE_DAYS = 14;

/**
 * Right-to-erasure: after the grace period, personal data is removed while orders, invoices and
 * payments are retained (tax/accounting obligations) with the customer reference anonymised.
 */
async function anonymizeDeletedUsers() {
  const User = require('../modules/users/user.model');
  const Address = require('../modules/addresses/address.model');
  const { Cart, WishlistItem } = require('../modules/cart/cart.model');
  const { Session } = require('../modules/auth/auth.models');
  const cutoff = new Date(Date.now() - DELETION_GRACE_DAYS * 86400000);
  const users = await User.find({ status: 'deletion_requested', deletionRequestedAt: { $lt: cutoff } }).select('_id').limit(100).lean();
  for (const u of users) {
    await Promise.all([Address.deleteMany({ user: u._id }), Cart.deleteMany({ user: u._id }), WishlistItem.deleteMany({ user: u._id }), Session.deleteMany({ user: u._id })]);
    await User.updateOne(
      { _id: u._id },
      { $set: { name: 'Deleted user', status: 'deleted' }, $unset: { email: 1, phone: 1, passwordHash: 1, emailVerifiedAt: 1, phoneVerifiedAt: 1 } },
    );
  }
  if (users.length) logger.info({ count: users.length }, 'anonymised deleted accounts');
}

/** Bumps the promotions cache whenever a campaign/promotion window opens or closes, and announces live campaigns once. */
async function campaignTick() {
  const { Campaign, Promotion, Coupon } = require('../modules/promotions/promotion.models');
  const now = new Date();
  const since = new Date(now.getTime() - 70 * 1000);
  const boundary = { $or: [{ startsAt: { $gt: since, $lte: now } }, { endsAt: { $gt: since, $lte: now } }] };
  const [c, p, k] = await Promise.all([Campaign.exists(boundary), Promotion.exists(boundary), Coupon.exists(boundary)]);
  if (c || p || k) await require('../modules/promotions/promotion.service').invalidate();

  const toAnnounce = await Campaign.find({ isActive: true, startsAt: { $lte: now }, endsAt: { $gt: now }, announcedAt: null }).limit(5);
  for (const campaign of toAnnounce) {
    const claimed = await Campaign.findOneAndUpdate({ _id: campaign._id, announcedAt: null }, { $set: { announcedAt: now } });
    if (!claimed) continue;
    const User = require('../modules/users/user.model');
    const { notify } = require('../modules/notifications/notification.service');
    const cursor = User.find({ role: 'customer', status: 'active', 'notificationPreferences.inApp.marketing': true }).select('_id').lean().cursor();
    let n = 0;
    for await (const u of cursor) {
      await notify({ userId: u._id, type: 'campaign_live', vars: { campaign: campaign.name, description: campaign.description || '' }, data: { campaign: campaign.slug }, dedupeKey: `campaign:${campaign._id}:${u._id}` }).catch(() => {});
      if (++n >= 50000) break;
    }
    logger.info({ campaign: campaign.slug, notified: n }, 'campaign announced');
  }
}

async function allocateBackorderedReplacements() {
  const { allocateAwaitingStock } = require('../modules/replacements/replacement.service');
  await allocateAwaitingStock();
}

async function closeIdleConversations() {
  const { Conversation } = require('../modules/chat/chat.models');
  const cutoff = new Date(Date.now() - 7 * 86400000);
  const r = await Conversation.updateMany({ status: { $in: ['open', 'waiting_agent'] }, lastMessageAt: { $lt: cutoff } }, { $set: { status: 'closed', closedAt: new Date(), closedReason: 'idle' } });
  if (r.modifiedCount) logger.info({ count: r.modifiedCount }, 'closed idle conversations');
}

async function cleanupMedia() {
  await require('../modules/media/media.service').cleanupMedia();
}

module.exports = { anonymizeDeletedUsers, campaignTick, allocateBackorderedReplacements, closeIdleConversations, cleanupMedia };
