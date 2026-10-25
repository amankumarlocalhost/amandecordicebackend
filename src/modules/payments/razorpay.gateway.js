'use strict';

const env = require('../../config/env');
const { hmacSha256, safeEqual } = require('../../utils/crypto');
const { unavailable } = require('../../utils/errors');

/**
 * Thin wrapper around the official Razorpay SDK. Tests swap the transport with `setClient()`;
 * signature verification always uses the real HMAC logic.
 */
let client = null;

function getClient() {
  if (client) return client;
  if (!env.features.razorpay) throw unavailable('Online UPI payments are not configured', 'PAYMENTS_NOT_CONFIGURED');
  const Razorpay = require('razorpay');
  client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  return client;
}

function setClient(mock) {
  client = mock;
}

function wrap(err) {
  const e = new Error(err?.error?.description || err?.message || 'Razorpay request failed');
  e.status = err?.statusCode;
  e.providerCode = err?.error?.code;
  e.transient = !err?.statusCode || err.statusCode >= 500 || err.statusCode === 429;
  return e;
}

async function call(fn) {
  try {
    return await fn(getClient());
  } catch (err) {
    if (err.code === 'PAYMENTS_NOT_CONFIGURED') throw err;
    throw wrap(err);
  }
}

const createOrder = ({ amount, receipt, notes }) => call((c) => c.orders.create({ amount, currency: 'INR', receipt, notes, partial_payment: false }));
const fetchOrderPayments = (orderId) => call((c) => c.orders.fetchPayments(orderId));
const fetchPayment = (paymentId) => call((c) => c.payments.fetch(paymentId));
const capturePayment = (paymentId, amount) => call((c) => c.payments.capture(paymentId, amount, 'INR'));
const refundPayment = (paymentId, { amount, notes, receipt }) => call((c) => c.payments.refund(paymentId, { amount, speed: 'normal', notes, receipt }));
const fetchRefunds = (paymentId) => call((c) => c.payments.fetchMultipleRefund(paymentId, { count: 100 }));

/** Checkout `razorpay_signature` = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!env.RAZORPAY_KEY_SECRET || !signature) return false;
  return safeEqual(hmacSha256(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature);
}

/** Webhook `X-Razorpay-Signature` = HMAC_SHA256(raw request body, webhook secret). */
function verifyWebhookSignature(rawBody, signature) {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature || !rawBody) return false;
  return safeEqual(hmacSha256(env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
}

/**
 * Options for Razorpay Standard Checkout restricted to UPI only (cards, net banking, wallets,
 * EMI and pay-later hidden). The server additionally rejects/refunds any non-UPI capture.
 */
function upiCheckoutOptions({ providerOrderId, amount, orderNumber, customer, storeName }) {
  return {
    key: env.RAZORPAY_KEY_ID,
    order_id: providerOrderId,
    amount,
    currency: 'INR',
    name: storeName,
    description: `Order ${orderNumber}`,
    prefill: { name: customer?.name, email: customer?.email, contact: customer?.phone },
    method: { upi: true, card: false, netbanking: false, wallet: false, emi: false, paylater: false, cardless_emi: false },
    config: {
      display: {
        blocks: { upi: { name: 'Pay using UPI', instruments: [{ method: 'upi' }] } },
        sequence: ['block.upi'],
        preferences: { show_default_blocks: false },
      },
    },
    notes: { orderNumber },
  };
}

module.exports = {
  setClient,
  createOrder,
  fetchOrderPayments,
  fetchPayment,
  capturePayment,
  refundPayment,
  fetchRefunds,
  verifyPaymentSignature,
  verifyWebhookSignature,
  upiCheckoutOptions,
};
