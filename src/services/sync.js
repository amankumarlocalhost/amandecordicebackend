'use strict';

const env = require('../config/env');
const logger = require('../config/logger');

/**
 * Storefront synchronisation after a committed admin change.
 *
 *   1. Services call `changed()` only AFTER the database write succeeded.
 *   2. Changes are coalesced for a short window (bulk edits produce one flush, not hundreds).
 *   3. The storefront's server cache is invalidated first (POST FRONTEND_REVALIDATE_URL with tags),
 *   4. then a minimal public event is broadcast on the `/public` Socket.IO namespace, so open
 *      browsers that refetch already get fresh data.
 *
 * Public events carry identifiers only (never drafts, prices or pending media); clients refetch
 * authoritative data from the public API. Losing an event is harmless: clients also refetch on
 * reconnect and the server caches expire on their own.
 */

const PUBLIC_NAMESPACE = '/public';
const FLUSH_MS = env.isTest ? 5 : 120;

/** Storefront cache tags (must match the frontend's lib/api/server.js). */
const TAGS = Object.freeze({
  CATALOG: 'catalog',
  CATEGORIES: 'categories',
  COLLECTIONS: 'collections',
  PROMOTIONS: 'promotions',
  SETTINGS: 'settings',
  PAGES: 'pages',
  product: (slug) => `product:${slug}`,
  content: (key) => `content:${key}`,
  page: (slug) => `page:${slug}`,
});

const EVENTS = Object.freeze({
  PRODUCT_PUBLISHED: 'product:published',
  PRODUCT_UPDATED: 'product:updated',
  PRODUCT_UNPUBLISHED: 'product:unpublished',
  CATEGORY_UPDATED: 'category:updated',
  COLLECTION_UPDATED: 'collection:updated',
  HOMEPAGE_UPDATED: 'homepage:updated',
  CONTENT_UPDATED: 'content:updated',
  BANNER_UPDATED: 'banner:updated',
  INVENTORY_UPDATED: 'inventory:updated',
  PROMOTIONS_UPDATED: 'promotions:updated',
  PAGE_UPDATED: 'page:updated',
});

let seq = 0;
let timer = null;
let flushing = Promise.resolve();
const pendingTags = new Set();
const pendingEvents = new Map(); // `${event}:${id}` -> payload (dedupes repeated edits within a window)
const listeners = new Set(); // in-process observers (tests, metrics)

function changed({ tags = [], events = [] }) {
  for (const t of tags) if (t && t.length <= 256) pendingTags.add(t);
  for (const e of events) {
    if (!e?.event) continue;
    const payload = { ...e, at: new Date().toISOString() };
    pendingEvents.set(`${e.event}:${e.id || e.key || e.slug || ''}`, payload);
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      flushing = flushing.then(flush).catch((err) => logger.error({ err: err.message }, 'sync flush failed'));
    }, FLUSH_MS);
    timer.unref?.();
  }
}

async function revalidate(tags) {
  if (!env.FRONTEND_REVALIDATE_URL || !tags.length) return { skipped: true };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(env.FRONTEND_REVALIDATE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-revalidate-secret': env.REVALIDATE_SECRET || '' },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return { ok: true };
      if (res.status < 500) {
        logger.error({ status: res.status }, 'storefront revalidation rejected (check REVALIDATE_SECRET)');
        return { ok: false };
      }
    } catch (err) {
      if (attempt === 3) logger.warn({ err: err.message, tags }, 'storefront revalidation failed; caches will expire on their own');
    }
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  return { ok: false };
}

function publicTarget() {
  const { getTarget } = require('../sockets/emitter');
  const t = getTarget();
  return t ? t.of(PUBLIC_NAMESPACE) : null;
}

async function flush() {
  const tags = [...pendingTags];
  const events = [...pendingEvents.values()];
  pendingTags.clear();
  pendingEvents.clear();
  if (!tags.length && !events.length) return;
  await revalidate(tags);
  const target = publicTarget();
  for (const e of events) {
    const payload = { ...e, v: ++seq };
    target?.emit(e.event, payload);
    target?.emit('sync', payload); // single catch-all channel for simple clients
    for (const l of listeners) l(payload);
  }
}

/** Resolves once everything queued so far has been flushed (tests, graceful shutdown). */
async function settle() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    flushing = flushing.then(flush);
  }
  await flushing;
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

module.exports = { changed, settle, subscribe, TAGS, EVENTS, PUBLIC_NAMESPACE };
