import { createApp } from '../src/app.js';
import { createMailer } from '../src/mailer.js';
import { hashKey, newId, now } from '../src/util.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export async function startServer(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openenvelope-test-'));
  const config = { port: 0, baseUrl: '', dataDir, dbPath: path.join(dataDir, 't.db'), adminToken: 'admin-secret', allowSignup: false,
    ipMode: 'hash', ipSalt: 'test-salt', smtpUrl: 'json', smtpFrom: 'openenvelope@test.local', schedulerIntervalMs: 999999, maxUploadMb: 5, corsOrigins: '*', ...extra };
  const mailer = createMailer(config);
  const ctx = createApp(config, { mailer, log: () => {} });
  const server = await new Promise((res) => { const s = ctx.app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = base; // tracked URLs must point at the live test server
  const key = 'oe_test_' + newId(8);
  ctx.core.Q.run('INSERT INTO users (id,email,name,api_key_hash,created_at) VALUES (?,?,?,?,?)', 'u1', 'me@example.com', 'Me', hashKey(key), now());
  const api = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${key}`, ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : ct.includes('pdf') ? Buffer.from(await r.arrayBuffer()) : await r.text() };
  };
  const hit = (p, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', extraHeaders = {}) =>
    fetch(base + p, { headers: { 'user-agent': ua, ...extraHeaders }, redirect: 'manual' });
  return { ...ctx, config, base, key, api, hit, mailer, close: () => new Promise((r) => server.close(r)) };
}

export const GMAIL_PROXY_UA = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';

/** Tiny one-page PDF built with pdf-lib for document tests. */
export async function samplePdf(pages = 2) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const pdf = await PDFDocument.create(); const f = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) pdf.addPage([300, 400]).drawText(`Proposal page ${i}`, { x: 40, y: 340, size: 18, font: f });
  return Buffer.from(await pdf.save());
}
// 1x1 transparent PNG as a "drawn signature".
export const SIG_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
