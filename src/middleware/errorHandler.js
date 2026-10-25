'use strict';

const { ZodError } = require('zod');
const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');
const { AppError } = require('../utils/errors');

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (err instanceof mongoose.Error.CastError) return new AppError(400, 'INVALID_ID', `Invalid value for ${err.path}`);
  if (err instanceof mongoose.Error.ValidationError) {
    return new AppError(
      400,
      'VALIDATION_ERROR',
      'Data validation failed',
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  }
  if (err && err.code === 11000) {
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    return new AppError(409, 'DUPLICATE', `A record with this ${fields.join(', ') || 'value'} already exists`, { fields });
  }
  if (err && err.name === 'MulterError') {
    return new AppError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_ERROR', err.message);
  }
  if (err && err.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  if (err && err.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Malformed JSON body');
  // http-errors raised by middleware such as express.static (e.g. a missing upload file).
  const httpStatus = err?.status || err?.statusCode;
  if (err && err.expose && httpStatus >= 400 && httpStatus < 500) return new AppError(httpStatus, httpStatus === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', httpStatus === 404 ? 'Not found' : 'Bad request');
  return null;
}

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'Route not found', error: { code: 'ROUTE_NOT_FOUND' }, requestId: req.id });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const appErr = toAppError(err);
  if (!appErr) {
    (req.log || logger).error({ err, requestId: req.id }, 'Unhandled error');
    require('../modules/admin/error-log').recordError(req, 500, err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong. Please try again.',
      error: { code: 'INTERNAL_ERROR', ...(env.isProd ? {} : { debug: err.message }) },
      requestId: req.id,
    });
  }
  if (appErr.status >= 500) {
    (req.log || logger).error({ err, requestId: req.id }, appErr.message);
    require('../modules/admin/error-log').recordError(req, appErr.status, appErr);
  }
  return res.status(appErr.status).json({
    success: false,
    message: appErr.message,
    error: { code: appErr.code, ...(appErr.details ? { details: appErr.details } : {}) },
    requestId: req.id,
  });
}

module.exports = { errorHandler, notFoundHandler, toAppError };
