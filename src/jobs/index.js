'use strict';

const { register, schedule, QUEUES } = require('../queues');
const channels = require('../services/channels');
const logger = require('../config/logger');

let registered = false;

/** Registers every job processor. Each one is idempotent and safe to retry. */
function registerJobs() {
  if (registered) return;
  registered = true;
  const notifications = require('../modules/notifications/notification.service');
  const inventory = require('../modules/inventory/inventory.service');
  const payments = require('../modules/payments/payment.service');
  const refunds = require('../modules/refunds/refund.service');
  const maintenance = require('./maintenance');

  // Notifications
  register(QUEUES.NOTIFICATIONS, 'deliver', notifications.deliver);
  register(QUEUES.NOTIFICATIONS, 'email', (d) => channels.sendEmail(d));
  register(QUEUES.NOTIFICATIONS, 'sms', (d) => channels.sendSms(d));

  // Inventory
  register(QUEUES.INVENTORY, 'refresh', inventory.refreshStock);
  register(QUEUES.INVENTORY, 'replacement-backorders', maintenance.allocateBackorderedReplacements);

  // Payments
  register(QUEUES.PAYMENTS, 'refund.process', refunds.processRefund);
  register(QUEUES.PAYMENTS, 'reconcile', async () => {
    const s = await payments.reconcilePending();
    if (s.checked) logger.info(s, 'UPI reconciliation');
  });
  register(QUEUES.PAYMENTS, 'refunds.reconcile', refunds.reconcileProcessing);

  // Campaigns
  register(QUEUES.CAMPAIGNS, 'tick', maintenance.campaignTick);

  // Maintenance
  register(QUEUES.MAINTENANCE, 'anonymize-users', maintenance.anonymizeDeletedUsers);
  register(QUEUES.MAINTENANCE, 'expire-conversations', maintenance.closeIdleConversations);
  register(QUEUES.MAINTENANCE, 'cleanup-media', maintenance.cleanupMedia);
}

async function registerSchedules() {
  await schedule(QUEUES.PAYMENTS, 'reconcile', 60 * 1000);
  await schedule(QUEUES.PAYMENTS, 'refunds.reconcile', 5 * 60 * 1000);
  await schedule(QUEUES.CAMPAIGNS, 'tick', 60 * 1000);
  await schedule(QUEUES.INVENTORY, 'replacement-backorders', 15 * 60 * 1000);
  await schedule(QUEUES.MAINTENANCE, 'anonymize-users', 6 * 3600 * 1000);
  await schedule(QUEUES.MAINTENANCE, 'expire-conversations', 30 * 60 * 1000);
  await schedule(QUEUES.MAINTENANCE, 'cleanup-media', 6 * 3600 * 1000);
}

module.exports = { registerJobs, registerSchedules };
