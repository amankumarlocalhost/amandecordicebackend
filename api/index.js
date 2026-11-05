'use strict';

/**
 * Vercel serverless entry. Reuses the same Express app as src/server.js, minus what a serverless
 * function cannot host: no Socket.IO, no background workers, no schedulers (run those on a
 * long-lived host with `npm run worker` if you need them).
 *
 * The app and the MongoDB connection are created once per warm instance and reused across requests.
 */

let ready = null;

async function init() {
  const { connectDatabase } = require('../src/config/database');
  const { registerListeners } = require('../src/events/listeners');
  const { registerJobs } = require('../src/jobs');
  const { createApp } = require('../src/app');
  await connectDatabase();
  registerListeners();
  registerJobs();
  return createApp();
}

/** Shown when the API cannot start; reports the problem without exposing any configuration values. */
function startupErrorPage(res, err) {
  const msg = String(err && err.message ? err.message : err)
    // keep variable names, drop anything that looks like a connection string or URL
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    .slice(0, 800);
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  res.statusCode = 503;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Decor Dice API — not ready</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f6f1;color:#252525;font:15px/1.5 system-ui,sans-serif;padding:16px}main{max-width:560px;width:100%;background:#fff;border:1px solid #e4ddd1;border-radius:12px;padding:28px}h1{font:600 1.5rem Georgia,serif;margin:0 0 8px;color:#a2402e}pre{white-space:pre-wrap;background:#f8f6f1;border:1px solid #e4ddd1;border-radius:8px;padding:12px;font-size:13px}</style></head>
<body><main><h1>API is deployed but could not start</h1><p>Fix the configuration below in Vercel → Project → Settings → Environment Variables, then redeploy.</p><pre>${esc(msg)}</pre></main></body></html>`);
}

module.exports = async (req, res) => {
  try {
    if (!ready) ready = init();
    const app = await ready;
    return app(req, res);
  } catch (err) {
    ready = null; // retry on the next request
    console.error('API startup failed:', err);
    return startupErrorPage(res, err);
  }
};
