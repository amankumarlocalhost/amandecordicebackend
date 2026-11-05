'use strict';

/**
 * Root status page (GET /): a human-friendly "API is running" page in a browser, JSON for API clients
 * (Accept: application/json or ?format=json). It shows only non-sensitive facts — never config values.
 */
const mongoose = require('mongoose');
const env = require('../config/env');
const pkg = require('../../package.json');

const DB_STATES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

function snapshot() {
  const db = DB_STATES[mongoose.connection.readyState] || 'unknown';
  return {
    name: 'Decor Dice API',
    status: db === 'connected' ? 'running' : 'degraded',
    version: pkg.version,
    environment: env.NODE_ENV,
    database: db,
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
    links: { health: '/health/live', readiness: '/health/ready', categories: '/api/v1/categories', products: '/api/v1/products', ...(!env.isProd || process.env.EXPOSE_DOCS === 'true' ? { docs: '/api/docs' } : {}) },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(s, { title = s.status === 'running' ? 'API is running' : 'API is up — database not connected', ok = s.status === 'running', note } = {}) {
  const rows = [
    ['Status', s.status],
    ['Database', s.database],
    ['Environment', s.environment],
    ['Version', s.version],
    ['Uptime', `${s.uptimeSeconds}s`],
    ['Server time', s.time],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.name)} — ${esc(s.status)}</title>
<style>
  :root{--bg:#f8f6f1;--card:#fff;--ink:#252525;--muted:#77736d;--line:#e4ddd1;--ok:#5f6d52;--bad:#a2402e;--accent:#b77b60}
  @media (prefers-color-scheme:dark){:root{--bg:#1d1b19;--card:#262320;--ink:#f1ede6;--muted:#a39d95;--line:#3a3632}}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
  main{width:100%;max-width:480px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
  .badge{display:inline-flex;align-items:center;gap:8px;font-weight:600;color:${ok ? 'var(--ok)' : 'var(--bad)'}}
  .dot{width:10px;height:10px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px color-mix(in srgb,currentColor 18%,transparent)}
  h1{font:600 1.6rem/1.2 Georgia,serif;margin:10px 0 4px}p{color:var(--muted);margin:0 0 18px}
  dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 20px}dt{color:var(--muted)}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;word-break:break-all}
  nav{display:flex;flex-wrap:wrap;gap:8px}a{color:var(--accent);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:13px}a:hover{border-color:var(--accent)}
</style></head>
<body><main>
  <span class="badge"><span class="dot"></span>${ok ? 'Online' : 'Attention needed'}</span>
  <h1>${esc(title)}</h1>
  <p>${esc(note || `${s.name} for the Decor Dice storefront and admin panel.`)}</p>
  <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
  <nav>${Object.entries(s.links).map(([k, v]) => `<a href="${esc(v)}">${esc(k)}</a>`).join('')}</nav>
</main></body></html>`;
}

function handler(req, res) {
  const s = snapshot();
  res.set('Cache-Control', 'no-store');
  if (req.query.format === 'json' || (req.accepts(['html', 'json']) === 'json')) return res.json(s);
  res.type('html').send(page(s));
}

module.exports = { handler, page, snapshot };
