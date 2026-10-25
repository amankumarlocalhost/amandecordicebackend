'use strict';

const crypto = require('crypto');

const KEY_SECRET = 'test_key_secret_for_signatures';
const WEBHOOK_SECRET = 'test_webhook_secret';
const hmac = (secret, v) => crypto.createHmac('sha256', secret).update(v).digest('hex');
const id = (p) => `${p}_${crypto.randomBytes(7).toString('hex')}`;

/** In-memory stand-in for the Razorpay SDK (same method names/shapes we use). */
function createFakeRazorpay() {
  const orders = new Map();
  const payments = new Map();
  const refunds = new Map();
  const fake = {
    failNextOrderCreate: false,
    failRefundTransient: 0,
    orders: {
      async create({ amount, currency, receipt, notes }) {
        if (fake.failNextOrderCreate) {
          fake.failNextOrderCreate = false;
          throw { statusCode: 503, error: { description: 'Service unavailable' } };
        }
        const o = { id: id('order'), entity: 'order', amount, currency, receipt, notes, status: 'created' };
        orders.set(o.id, o);
        return o;
      },
      async fetchPayments(orderId) {
        return { items: [...payments.values()].filter((p) => p.order_id === orderId) };
      },
    },
    payments: {
      async fetch(paymentId) {
        const p = payments.get(paymentId);
        if (!p) throw { statusCode: 400, error: { description: 'Payment not found' } };
        return { ...p };
      },
      async capture(paymentId) {
        const p = payments.get(paymentId);
        p.status = 'captured';
        return { ...p };
      },
      async refund(paymentId, { amount, notes, receipt }) {
        if (fake.failRefundTransient > 0) {
          fake.failRefundTransient--;
          throw { statusCode: 502, error: { description: 'Bad gateway' } };
        }
        const r = { id: id('rfnd'), entity: 'refund', payment_id: paymentId, amount, notes, receipt, status: 'processed' };
        refunds.set(r.id, r);
        return { ...r };
      },
      async fetchMultipleRefund(paymentId) {
        return { items: [...refunds.values()].filter((r) => r.payment_id === paymentId) };
      },
    },
    /** Simulates the customer paying a Razorpay order. */
    pay(orderId, { method = 'upi', status = 'captured', amount } = {}) {
      const o = orders.get(orderId);
      const p = { id: id('pay'), entity: 'payment', order_id: orderId, amount: amount ?? o.amount, currency: 'INR', status, method, vpa: method === 'upi' ? 'customer@okbank' : undefined, created_at: Math.floor(Date.now() / 1000), error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : undefined, error_description: status === 'failed' ? 'Payment declined by bank' : undefined };
      payments.set(p.id, p);
      return { ...p, signature: hmac(KEY_SECRET, `${orderId}|${p.id}`) };
    },
    refunds,
    orders_: orders,
  };
  return fake;
}

function signedWebhook(event, payload, eventId = id('evt')) {
  const body = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
  return { body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac(WEBHOOK_SECRET, body), 'x-razorpay-event-id': eventId } };
}

/**
 * Scriptable Gemini client. `script` is an array of steps; each step is either
 * { call: { name, args } } (the model requests a tool) or { text } (final answer), or a function
 * (request) => step, or an Error to throw.
 */
function createFakeGemini() {
  const fake = {
    script: [],
    requests: [],
    models: {
      async generateContent(req) {
        fake.requests.push(req);
        let step = fake.script.shift();
        if (typeof step === 'function') step = step(req);
        if (!step) step = { text: 'OK' };
        if (step instanceof Error) throw step;
        if (step.delayMs) await new Promise((r, rej) => {
          const t = setTimeout(r, step.delayMs);
          req.config?.abortSignal?.addEventListener('abort', () => {
            clearTimeout(t);
            const e = new Error('This operation was aborted');
            e.name = 'AbortError';
            rej(e);
          });
        });
        const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20 };
        if (step.call) {
          const calls = [].concat(step.call).map((c, i) => ({ id: `call_${i}`, name: c.name, args: c.args || {} }));
          return { functionCalls: calls, text: undefined, candidates: [{ content: { role: 'model', parts: calls.map((c) => ({ functionCall: c })) } }], usageMetadata };
        }
        return { functionCalls: undefined, text: step.text, candidates: [{ content: { role: 'model', parts: [{ text: step.text }] } }], usageMetadata };
      },
    },
    /** Tool results the agent sent back on the most recent request. */
    lastToolOutputs() {
      const req = fake.requests[fake.requests.length - 1];
      const last = req?.contents?.[req.contents.length - 1];
      return (last?.parts || []).filter((p) => p.functionResponse).map((p) => ({ name: p.functionResponse.name, output: p.functionResponse.response.output }));
    },
  };
  return fake;
}

module.exports = { createFakeRazorpay, createFakeGemini, signedWebhook, hmac, KEY_SECRET, WEBHOOK_SECRET };
