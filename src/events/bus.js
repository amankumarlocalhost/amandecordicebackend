'use strict';

const { EventEmitter } = require('events');
const logger = require('../config/logger');

/**
 * In-process domain event bus. Business state is always committed to MongoDB *before* an event
 * is published, so listeners only perform side effects (notifications, cache invalidation,
 * socket pushes) that are safe to lose or repeat. Durable side effects go through queues.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
const pending = new Set();

function on(event, handler) {
  emitter.on(event, (payload) => {
    const p = Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => logger.error({ event, err: err.message }, 'event listener failed'));
    pending.add(p);
    p.finally(() => pending.delete(p));
  });
}

function publish(event, payload) {
  setImmediate(() => emitter.emit(event, payload));
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  while (pending.size) await Promise.allSettled([...pending]);
}

const EVENTS = Object.freeze({
  USER_REGISTERED: 'user.registered',
  ORDER_PLACED: 'order.placed',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_CANCELLED: 'order.cancelled',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  REFUND_UPDATED: 'refund.updated',
  RETURN_UPDATED: 'return.updated',
  REPLACEMENT_UPDATED: 'replacement.updated',
  SHIPMENT_UPDATED: 'shipment.updated',
  STOCK_LOW: 'inventory.low',
  STOCK_RESTOCKED: 'inventory.restocked',
  CATALOG_CHANGED: 'catalog.changed',
  SUPPORT_MESSAGE: 'support.message',
  SECURITY_EVENT: 'security.event',
});

module.exports = { on, publish, flush, EVENTS };
