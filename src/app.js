'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const env = require('./config/env');
const logger = require('./config/logger');
const { requestId, sanitizeInput, csrfProtection } = require('./middleware/security');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { limits } = require('./middleware/rateLimit');
const { moduleRouters } = require('./routes');
const health = require('./routes/health');
const registry = require('./docs/registry');
const storage = require('./services/storage');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url.startsWith('/health') },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
    }),
  );
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: { directives: { 'img-src': ["'self'", 'data:', 'https:'], 'script-src': ["'self'"] } },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || env.frontendOrigins.includes(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id', 'X-Client-Type'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );
  app.use(compression());

  // Webhooks need the exact raw bytes for HMAC verification.
  app.use('/api/v1/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(sanitizeInput);

  app.use('/health', health.router);
  // Root status page ("API is running"), e.g. the Vercel deployment URL.
  app.get('/', require('./routes/status').handler);
  if (env.STORAGE_DRIVER === 'local') app.use('/uploads', express.static(storage.LOCAL_ROOT, { maxAge: '30d', immutable: true, fallthrough: false, dotfiles: 'deny' }));

  app.use('/api', limits.api);
  app.use(csrfProtection);
  for (const r of moduleRouters()) app.use(r.prefix, r.router);

  app.get('/api/docs.json', (req, res) => res.json(registry.buildSpec({ serverUrl: env.APP_URL })));
  if (!env.isProd || process.env.EXPOSE_DOCS === 'true') {
    app.use('/api/docs', swaggerUi.serveFiles(null, { swaggerUrl: '/api/docs.json' }), swaggerUi.setup(null, { swaggerUrl: '/api/docs.json' }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
