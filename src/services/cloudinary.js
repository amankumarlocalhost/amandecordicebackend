'use strict';

const env = require('../config/env');

/**
 * Cloudinary adapter for images and videos. Credentials stay server-side; uploads are signed by
 * the SDK. Display sizes are delivered as Cloudinary transformations (f_auto/q_auto), so only one
 * sanitised master is stored per image. Tests inject a fake client with `setClient`.
 */
let client = null;

function getClient() {
  if (!client) {
    client = require('cloudinary').v2;
    client.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
  }
  return client;
}

function setClient(fake) {
  client = fake;
}

/**
 * `type: 'authenticated'` stores the asset privately (catalog media awaiting review): it can only be
 * delivered through signed URLs. Approval renames it to the public `upload` type.
 */
function upload(buffer, { resourceType, folder, publicId, type = 'upload' }) {
  return new Promise((resolve, reject) => {
    const stream = getClient().uploader.upload_stream(
      {
        resource_type: resourceType,
        type,
        folder: `${env.CLOUDINARY_UPLOAD_FOLDER}/${folder}`,
        public_id: publicId,
        overwrite: false,
        unique_filename: false,
        use_filename: false,
        // Videos: generate the streaming-friendly MP4 rendition right away.
        ...(resourceType === 'video' ? { eager: [{ format: 'mp4', quality: 'auto', width: 1280, crop: 'limit' }], eager_async: true } : {}),
      },
      (err, res) => (err ? reject(Object.assign(new Error(err.message || 'Cloudinary upload failed'), { status: err.http_code })) : resolve(res)),
    );
    stream.end(buffer);
  });
}

const url = (publicId, opts) => getClient().url(publicId, { secure: true, ...opts });

function imageUrls(publicId, version) {
  const t = (width) => url(publicId, { version, transformation: [{ width, crop: 'limit', fetch_format: 'auto', quality: 'auto' }] });
  return { url: t(1600), mediumUrl: t(800), thumbUrl: t(300) };
}

function videoUrls(publicId, version) {
  return {
    url: url(publicId, { resource_type: 'video', version, format: 'mp4', transformation: [{ width: 1280, crop: 'limit', quality: 'auto' }] }),
    posterUrl: url(publicId, { resource_type: 'video', version, format: 'jpg', transformation: [{ start_offset: '1', width: 800, crop: 'limit', quality: 'auto' }] }),
    thumbUrl: url(publicId, { resource_type: 'video', version, format: 'jpg', transformation: [{ start_offset: '1', width: 300, crop: 'limit', quality: 'auto' }] }),
  };
}

async function destroy(publicId, resourceType = 'image', type = 'upload') {
  return getClient().uploader.destroy(publicId, { resource_type: resourceType, type, invalidate: true });
}

/** Signed delivery URL for a private (authenticated) asset, used only for admin review previews. */
function privateUrl(publicId, { resourceType = 'image', version, width = 800, format } = {}) {
  return url(publicId, {
    resource_type: resourceType,
    type: 'authenticated',
    sign_url: true,
    version,
    ...(format ? { format } : {}),
    transformation: [{ width, crop: 'limit', ...(resourceType === 'image' ? { fetch_format: 'auto', quality: 'auto' } : { quality: 'auto' }) }],
  });
}

/** Makes a private asset public (approval). Resolves to the provider result (new version). */
function publish(publicId, resourceType = 'image') {
  return getClient().uploader.rename(publicId, publicId, { resource_type: resourceType, type: 'authenticated', to_type: 'upload', invalidate: true, overwrite: false });
}

module.exports = { upload, imageUrls, videoUrls, destroy, privateUrl, publish, setClient };
