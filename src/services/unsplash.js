'use strict';

/**
 * Minimal client for the official Unsplash API (https://unsplash.com/documentation).
 * API terms we follow: photos are hotlinked from images.unsplash.com (never re-hosted), the `ixid`
 * parameter on returned URLs is kept, a photo's download_location is called when it is used, and
 * the photographer and Unsplash are credited wherever the photo is shown.
 */

const sharp = require('sharp');
const env = require('../config/env');

const API = 'https://api.unsplash.com';
const IMAGE_HOST = 'images.unsplash.com';
const SIZES = { url: 1600, mediumUrl: 800, thumbUrl: 400 };
const UTM = 'utm_source=atelier_table&utm_medium=referral';

class UnsplashError extends Error {
  constructor(message, { status, rateLimited = false } = {}) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

const isConfigured = () => Boolean(env.UNSPLASH_ACCESS_KEY);

/** Sized delivery URL from a photo's raw URL (keeps ixid; imgix params do the resizing). */
function sized(rawUrl, width, { quality = 80 } = {}) {
  const u = new URL(rawUrl);
  if (u.hostname !== IMAGE_HOST) throw new UnsplashError(`Not an Unsplash image URL: ${u.hostname}`);
  u.searchParams.set('auto', 'format');
  u.searchParams.set('fit', 'crop');
  u.searchParams.set('w', String(width));
  u.searchParams.set('q', String(quality));
  return u.toString();
}

/** Public url / mediumUrl / thumbUrl for a raw Unsplash URL. */
const urls = (rawUrl) => Object.fromEntries(Object.entries(SIZES).map(([k, w]) => [k, sized(rawUrl, w)]));

/** Attribution links must carry UTM parameters (Unsplash API guidelines). */
const withUtm = (link) => (link ? `${link}${link.includes('?') ? '&' : '?'}${UTM}` : link);

let lastRemaining = null;
const rateRemaining = () => lastRemaining;

async function call(path, query = {}) {
  if (!isConfigured()) throw new UnsplashError('UNSPLASH_ACCESS_KEY is not configured');
  const u = path.startsWith('http') ? new URL(path) : new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  if (u.hostname !== 'api.unsplash.com') throw new UnsplashError(`Refusing to call ${u.hostname}`);
  const res = await fetch(u, { headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' }, signal: AbortSignal.timeout(20000) });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null) lastRemaining = Number(remaining);
  if (res.status === 403 && (lastRemaining === 0 || /rate limit/i.test(await res.clone().text()))) throw new UnsplashError('Unsplash rate limit reached', { status: 403, rateLimited: true });
  if (res.status === 401) throw new UnsplashError('Unsplash rejected the access key (401)', { status: 401 });
  if (!res.ok) throw new UnsplashError(`Unsplash API ${res.status}`, { status: res.status });
  return res.json();
}

/** Normalised search result; Unsplash+ (licensed) photos are excluded. */
function toPhoto(r) {
  return {
    id: r.id,
    width: r.width,
    height: r.height,
    description: (r.alt_description || r.description || '').slice(0, 300),
    rawUrl: r.urls?.raw,
    pageUrl: r.links?.html,
    downloadLocation: r.links?.download_location,
    author: r.user?.name,
    authorUrl: r.user?.links?.html,
    tags: (r.tags || []).map((t) => t.title).filter(Boolean),
    premium: Boolean(r.premium || r.plus || (r.urls?.raw && !r.urls.raw.includes(IMAGE_HOST))),
  };
}

async function search(query, { perPage = 30, page = 1, orientation } = {}) {
  const json = await call('/search/photos', { query, per_page: perPage, page, orientation, content_filter: 'high' });
  return (json.results || []).map(toPhoto).filter((p) => !p.premium && p.rawUrl);
}

/** Must be called when a photo is put to use (API guideline "trigger a download"). */
async function trackDownload(downloadLocation) {
  if (!downloadLocation) return false;
  await call(downloadLocation);
  return true;
}

/**
 * Fetches the thumbnail size of a photo and checks it is really an image (status, content type and
 * decodable pixels), so nothing unverified is ever stored.
 */
async function verify(rawUrl) {
  const target = sized(rawUrl, SIZES.thumbUrl);
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(20000) });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    if (!contentType.startsWith('image/')) return { ok: false, reason: `not an image (${contentType || 'no content type'})` };
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: 'image could not be decoded' };
    return { ok: true, contentType, bytes: buf.length, sampleWidth: meta.width, sampleHeight: meta.height };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { isConfigured, search, trackDownload, verify, urls, sized, withUtm, rateRemaining, UnsplashError, IMAGE_HOST };
