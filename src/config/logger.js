'use strict';

const pino = require('pino');
const env = require('./env');

const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-csrf-token"]',
    'req.headers["x-razorpay-signature"]',
    'res.headers["set-cookie"]',
    '*.password',
    '*.newPassword',
    '*.currentPassword',
    '*.passwordHash',
    '*.otp',
    '*.code',
    '*.token',
    '*.refreshToken',
    '*.accessToken',
    '*.razorpay_signature',
    '*.apiKey',
    '*.secret',
  ],
  censor: '[REDACTED]',
};

/** pino-pretty is a dev dependency: use it only where it is installed (never on Vercel/serverless). */
function prettyAvailable() {
  if (env.NODE_ENV !== 'development' || process.env.VERCEL) return false;
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact,
  base: { service: 'crockery-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: prettyAvailable() ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } : undefined,
});

module.exports = logger;
