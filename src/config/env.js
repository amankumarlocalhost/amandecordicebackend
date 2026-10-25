'use strict';

const path = require('path');
const { z } = require('zod');

if (process.env.NODE_ENV !== 'test') require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const DEV_SECRET = 'dev-only-insecure-secret-change-me-0123456789';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/crockery'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(50),
  MONGODB_AUTO_INDEX: bool(true),
  REDIS_URL: optionalString,

  JWT_ACCESS_SECRET: z.string().min(32).default(DEV_SECRET),
  JWT_REFRESH_SECRET: z.string().min(32).default(DEV_SECRET + '-refresh'),
  COOKIE_SECRET: z.string().min(32).default(DEV_SECRET + '-cookie'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: optionalString,
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_SECURE: bool(undefined),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).max(262144).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(1).max(10).default(2),

  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_ADMIN_MODEL: optionalString,
  GEMINI_FALLBACK_MODEL: optionalString,
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(8),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_DAILY_CUSTOMER_REQUESTS: z.coerce.number().int().positive().default(60),
  AI_DAILY_ADMIN_REQUESTS: z.coerce.number().int().positive().default(400),

  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,

  STORAGE_DRIVER: z.enum(['local', 's3', 'cloudinary']).default('local'),
  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  CLOUDINARY_UPLOAD_FOLDER: z.string().regex(/^[\w-]+(\/[\w-]+)*$/, 'Folder may contain letters, digits, _, - and /').default('crockery'),
  MEDIA_MAX_VIDEO_MB: z.coerce.number().int().min(1).max(500).default(50),
  MEDIA_MAX_VIDEO_SECONDS: z.coerce.number().int().min(5).max(3600).default(120),
  OBJECT_STORAGE_ENDPOINT: optionalString,
  OBJECT_STORAGE_REGION: z.string().default('ap-south-1'),
  OBJECT_STORAGE_BUCKET: optionalString,
  OBJECT_STORAGE_ACCESS_KEY: optionalString,
  OBJECT_STORAGE_SECRET_KEY: optionalString,
  OBJECT_STORAGE_PUBLIC_URL: optionalString,
  // Catalog media review: signed private-preview lifetime, min image side, cleanup retention, and
  // external image hosts admins may reference directly (comma-separated; empty = uploads only).
  MEDIA_PREVIEW_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(600),
  MEDIA_MIN_DIMENSION: z.coerce.number().int().min(1).max(4000).default(200),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MEDIA_EXTERNAL_HOSTS: z.string().default(''),
  // Official Unsplash API access key, used only by the catalog image import (scripts/seed-catalog.js).
  UNSPLASH_ACCESS_KEY: optionalString,

  // Storefront cache invalidation: the backend POSTs changed cache tags here after publishing.
  FRONTEND_REVALIDATE_URL: optionalString,
  REVALIDATE_SECRET: optionalString,

  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  EMAIL_FROM: z.string().default('Decor Dice <no-reply@example.com>'),
  SMS_PROVIDER: z.enum(['none', 'console']).default('console'),
  WHATSAPP_PROVIDER: z.enum(['none', 'console']).default('none'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  CHECKOUT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(15),

  RUN_WORKERS: bool(true),
  RUN_SCHEDULERS: bool(true),
  DEV_EXPOSE_OTP: bool(false),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';

  if (env.COOKIE_SECURE === undefined) env.COOKIE_SECURE = isProd;

  if (isProd) {
    const problems = [];
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'COOKIE_SECRET']) {
      if (env[key].startsWith(DEV_SECRET)) problems.push(`${key} must be set to a strong unique secret`);
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) problems.push('JWT secrets must differ');
    if (!env.REDIS_URL) problems.push('REDIS_URL is required in production (rate limits, queues, sockets)');
    if (!process.env.MONGODB_URI) problems.push('MONGODB_URI is required in production');
    if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (env.DEV_EXPOSE_OTP) problems.push('DEV_EXPOSE_OTP must be false in production');
    if (env.STORAGE_DRIVER === 's3' && !env.OBJECT_STORAGE_BUCKET) problems.push('OBJECT_STORAGE_BUCKET is required');
    if (env.STORAGE_DRIVER === 'local') problems.push('STORAGE_DRIVER=local is not allowed in production (use cloudinary or s3)');
    if (env.FRONTEND_REVALIDATE_URL && (!env.REVALIDATE_SECRET || env.REVALIDATE_SECRET.length < 32)) problems.push('REVALIDATE_SECRET (32+ chars) is required with FRONTEND_REVALIDATE_URL');
    if (problems.length) throw new Error(`Unsafe production configuration:\n  ${problems.join('\n  ')}`);
  }
  if (env.STORAGE_DRIVER === 'cloudinary' && !(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET)) {
    throw new Error('STORAGE_DRIVER=cloudinary requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET');
  }
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  }

  env.isProd = isProd;
  env.isTest = env.NODE_ENV === 'test';
  env.frontendOrigins = env.FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean);
  env.mediaExternalHosts = env.MEDIA_EXTERNAL_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  env.features = {
    razorpay: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    razorpayWebhooks: Boolean(env.RAZORPAY_WEBHOOK_SECRET),
    gemini: Boolean(env.GEMINI_API_KEY),
    redis: Boolean(env.REDIS_URL),
    smtp: Boolean(env.SMTP_HOST),
    s3: env.STORAGE_DRIVER === 's3',
    cloudinary: env.STORAGE_DRIVER === 'cloudinary',
  };
  return Object.freeze(env);
}

module.exports = load();
