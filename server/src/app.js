import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createCore } from './core.js';
import { createMailer } from './mailer.js';
import { PIXEL_GIF, hashKey, now } from './util.js';
import { apiRouter } from './routes/api.js';
import { campaignRouter } from './routes/campaigns.js';
import { docsRouter, docsPublicRouter } from './routes/docs.js';
import { publicPages } from './routes/public.js';
import { createScheduler } from './scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(config, { mailer, log = console.log } = {}) {
  const db = openDb(config.dbPath);
  mailer = mailer || createMailer(config);
  const core = createCore({ db, config, mailer, log });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // CORS: the extension (chrome-extension://) and the web dashboard call the API.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = config.corsOrigins === '*' || config.corsOrigins.split(',').includes(origin);
    if (origin && allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ---- Tracking endpoints (public, no auth) ----
  app.get('/t/:id.gif', (req, res) => {
    try { core.recordOpen(req.params.id, req); } catch (e) { log('open error', e.message); }
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0', Pragma: 'no-cache', Expires: '0' });
    res.end(PIXEL_GIF);
  });
  app.get('/c/:id/:idx', (req, res) => {
    const url = core.recordClick(req.params.id, req.params.idx, req);
    if (!url) return res.status(404).type('text').send('Link not found');
    res.set('Cache-Control', 'no-store').redirect(302, url);
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, time: now(), smtp: mailer.enabled }));

  // ---- Auth for /api ----
  const auth = (req, res, next) => {
    const h = req.headers.authorization || '';
    const key = h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-api-key'] || req.query.key;
    if (!key) return res.status(401).json({ error: 'missing API key' });
    const u = core.Q.get('SELECT * FROM users WHERE api_key_hash=?', hashKey(String(key)));
    if (!u) return res.status(401).json({ error: 'invalid API key' });
    req.user = u; next();
  };

  app.use('/api', express.json({ limit: '5mb' }));
  app.use('/api', apiRouter({ core, config, auth, mailer }));
  app.use('/api', campaignRouter({ core, config, auth, mailer, log }));
  app.use('/api', docsRouter({ core, config, auth }));
  app.use(docsPublicRouter({ core, config }));
  app.use(publicPages({ core, config }));

  // Web dashboard: the same dashboard the extension ships, served for phones/other browsers.
  const dashDir = process.env.DASHBOARD_DIR || path.resolve(here, '../../extension');
  app.use('/app', express.static(dashDir));
  app.use('/vendor/pdfjs', express.static(path.resolve(here, '../node_modules/pdfjs-dist/legacy/build')));
  app.get('/', (req, res) => res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>OpenEnvelope server</title><body style="font:16px system-ui;max-width:560px;margin:60px auto;padding:0 16px"><h1>✓✓ OpenEnvelope</h1><p>This is a self-hosted OpenEnvelope tracking server. Open the <a href="/app/dashboard/dashboard.html">dashboard</a>.</p><p style="color:#666">OpenEnvelope is open source (MIT) and is not affiliated with Mailtrack or Mailsuite.</p>`));

  const scheduler = createScheduler({ core, config, mailer, log });
  return { app, db, core, mailer, scheduler };
}
