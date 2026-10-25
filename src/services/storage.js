'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const env = require('../config/env');

/**
 * Object storage adapter. `local` writes under ./uploads and is served by Express (development);
 * `s3` targets AWS S3 or any S3-compatible service (R2, MinIO, Wasabi, DigitalOcean Spaces).
 *
 * Private objects (catalog media awaiting review) live outside the public area: under
 * ./uploads-private locally (never served statically) and under the `private/` prefix on S3
 * (the bucket policy must deny public reads on `private/*`). They are only read back through the
 * API's signed preview endpoint, and `promote` moves them to the public area on approval.
 */

const LOCAL_ROOT = path.resolve(__dirname, '../../uploads');
const LOCAL_PRIVATE_ROOT = path.resolve(__dirname, '../../uploads-private');
const S3_PRIVATE_PREFIX = 'private/';
let s3 = null;

function getS3() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: env.OBJECT_STORAGE_REGION,
      endpoint: env.OBJECT_STORAGE_ENDPOINT,
      forcePathStyle: Boolean(env.OBJECT_STORAGE_ENDPOINT),
      credentials:
        env.OBJECT_STORAGE_ACCESS_KEY && env.OBJECT_STORAGE_SECRET_KEY
          ? { accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY }
          : undefined,
    });
  }
  return s3;
}

function publicUrl(key) {
  if (env.STORAGE_DRIVER === 's3') {
    const base = env.OBJECT_STORAGE_PUBLIC_URL || `https://${env.OBJECT_STORAGE_BUCKET}.s3.${env.OBJECT_STORAGE_REGION}.amazonaws.com`;
    return `${base.replace(/\/$/, '')}/${key}`;
  }
  return `${env.APP_URL.replace(/\/$/, '')}/uploads/${key}`;
}

function safeKey(key) {
  const normalized = path.posix.normalize(key).replace(/^(\.\.(\/|$))+/, '');
  if (normalized.startsWith('/') || normalized.includes('..')) throw new Error('Invalid storage key');
  return normalized;
}

const s3Key = (key, isPrivate) => (isPrivate ? `${S3_PRIVATE_PREFIX}${key}` : key);
const localPath = (key, isPrivate) => path.join(isPrivate ? LOCAL_PRIVATE_ROOT : LOCAL_ROOT, key);

async function put(key, buffer, contentType, { cacheControl = 'public, max-age=31536000, immutable', private: isPrivate = false } = {}) {
  key = safeKey(key);
  if (env.STORAGE_DRIVER === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3().send(
      new PutObjectCommand({
        Bucket: env.OBJECT_STORAGE_BUCKET,
        Key: s3Key(key, isPrivate),
        Body: buffer,
        ContentType: contentType,
        CacheControl: isPrivate ? 'private, no-store' : cacheControl,
      }),
    );
  } else {
    const file = localPath(key, isPrivate);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buffer);
  }
  return { key, url: isPrivate ? null : publicUrl(key) };
}

async function remove(key, { private: isPrivate = false } = {}) {
  key = safeKey(key);
  if (env.STORAGE_DRIVER === 's3') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getS3().send(new DeleteObjectCommand({ Bucket: env.OBJECT_STORAGE_BUCKET, Key: s3Key(key, isPrivate) }));
  } else {
    await fs.rm(localPath(key, isPrivate), { force: true });
  }
}

/** Moves a private object to the public area (same key). Idempotent: an already-public object is left as is. */
async function promote(key) {
  key = safeKey(key);
  if (env.STORAGE_DRIVER === 's3') {
    const { CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getS3().send(
      new CopyObjectCommand({
        Bucket: env.OBJECT_STORAGE_BUCKET,
        CopySource: `${env.OBJECT_STORAGE_BUCKET}/${encodeURI(s3Key(key, true))}`,
        Key: key,
        CacheControl: 'public, max-age=31536000, immutable',
        MetadataDirective: 'REPLACE',
        ContentType: 'image/webp',
      }),
    );
    await getS3().send(new DeleteObjectCommand({ Bucket: env.OBJECT_STORAGE_BUCKET, Key: s3Key(key, true) }));
  } else {
    const from = localPath(key, true);
    const to = localPath(key, false);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (err) {
      if (err.code === 'ENOENT' && fsSync.existsSync(to)) return { key, url: publicUrl(key) };
      if (err.code === 'EXDEV') {
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      } else throw err;
    }
  }
  return { key, url: publicUrl(key) };
}

/** Reads an object as a Buffer (used by the signed private-preview endpoint). Returns null when missing. */
async function read(key, { private: isPrivate = false } = {}) {
  key = safeKey(key);
  if (env.STORAGE_DRIVER === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const res = await getS3().send(new GetObjectCommand({ Bucket: env.OBJECT_STORAGE_BUCKET, Key: s3Key(key, isPrivate) }));
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }
  try {
    return await fs.readFile(localPath(key, isPrivate));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

module.exports = { put, remove, promote, read, publicUrl, LOCAL_ROOT, LOCAL_PRIVATE_ROOT };
