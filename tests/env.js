'use strict';

// Test-only configuration. These are fake credentials; no live provider is ever called.
Object.assign(process.env, {
  NODE_ENV: 'test',
  ARGON2_MEMORY_KIB: '4096',
  ARGON2_TIME_COST: '1',
  DEV_EXPOSE_OTP: 'true',
  FRONTEND_URL: 'http://localhost:3000',
  APP_URL: 'http://localhost:4000',
  RAZORPAY_KEY_ID: 'rzp_test_fake',
  RAZORPAY_KEY_SECRET: 'test_key_secret_for_signatures',
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  GEMINI_API_KEY: '',
  GEMINI_TIMEOUT_MS: '500',
  GEMINI_MAX_RETRIES: '1',
  SMS_PROVIDER: 'console',
  RUN_WORKERS: 'false',
  RUN_SCHEDULERS: 'false',
  LOG_LEVEL: 'silent',
  STORAGE_DRIVER: 'local', // tests never upload to a real provider
  MEDIA_EXTERNAL_HOSTS: 'cdn.example.com', // fixture product images; real uploads go through review
});
delete process.env.REDIS_URL;
