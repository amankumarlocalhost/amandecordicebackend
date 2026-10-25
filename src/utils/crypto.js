'use strict';

const crypto = require('crypto');

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const hmacSha256 = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function randomDigits(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) out += crypto.randomInt(0, 10);
  return out;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

/** Human-friendly reference such as CRK-261023-7KQ2PX. */
function referenceNumber(prefix) {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${prefix}-${ymd}-${randomCode(6)}`;
}

module.exports = { randomToken, sha256, hmacSha256, safeEqual, randomDigits, randomCode, referenceNumber };
