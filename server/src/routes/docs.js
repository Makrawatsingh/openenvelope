import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { newId, now, sha256, parseJSON, hashPassword, checkPassword, escapeHtml, storeIp, clientIp, readUA } from '../util.js';
import { page } from './public.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME_EXT = { 'application/pdf': 'pdf', 'video/webm': 'webm', 'video/mp4': 'mp4' };

/** Tracked documents (PDF), video messages, and signature requests — authenticated API. */
export function docsRouter({ core, config, auth }) {
  const r = express.Router();
  const { Q } = core;
  const filesDir = path.join(config.dataDir, 'files');

  r.post('/documents', auth, express.raw({ type: ['application/pdf', 'video/*', 'application/octet-stream'], limit: `${config.maxUploadMb}mb` }), (req, res) => {
    const mime = (req.headers['content-type'] || '').split(';')[0];
    const ext = MIME_EXT[mime];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'send a PDF (application/pdf) or video (video/webm, video/mp4) as the raw body' });
    if (ext === 'pdf' && req.body.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'not a PDF' });
    fs.mkdirSync(filesDir, { recursive: true });
    const id = newId(9);
    const file = path.join(filesDir, `${id}.${ext}`);
    fs.writeFileSync(file, req.body);
    const { name, password, expires_days, watermark, allow_download } = req.query;
    Q.run(`INSERT INTO documents (id,user_id,kind,name,mime,path,bytes,sha256,password_hash,expires_at,watermark,allow_download,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, req.user.id, ext === 'pdf' ? 'pdf' : 'video', name || `${id}.${ext}`, mime, file, req.body.length,
      sha256(req.body), password ? hashPassword(String(password)) : null, expires_days ? now() + Number(expires_days) * 86400_000 : null,
      watermark ? String(watermark).slice(0, 80) : null, allow_download === 'true' ? 1 : 0, now());
    res.status(201).json({ id, kind: ext === 'pdf' ? 'pdf' : 'video', share_url: `${config.baseUrl}/d/${id}`, sha256: sha256(req.body) });
  });

  r.get('/documents', auth, (req, res) => {
    res.json(Q.all('SELECT * FROM documents WHERE user_id=? ORDER BY created_at DESC', req.user.id).map((d) => docOut(d)));
  });
  r.get('/documents/:id', auth, (req, res) => {
    const d = Q.get('SELECT * FROM documents WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const views = Q.all('SELECT id,viewer,started_at,last_ping_at,total_seconds,pages FROM doc_views WHERE doc_id=? ORDER BY started_at DESC', d.id)
      .map((v) => ({ ...v, pages: parseJSON(v.pages, {}) }));
    const perPage = {};
    for (const v of views) for (const [p, s] of Object.entries(v.pages)) perPage[p] = (perPage[p] || 0) + s;
    res.json({ ...docOut(d), view_sessions: views, seconds_per_page: perPage });
  });
  r.put('/documents/:id', auth, (req, res) => {
    const d = Q.get('SELECT * FROM documents WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const { password, expires_days, watermark, allow_download, revoke } = req.body || {};
    if (password !== undefined) Q.run('UPDATE documents SET password_hash=? WHERE id=?', password ? hashPassword(password) : null, d.id);
    if (expires_days !== undefined) Q.run('UPDATE documents SET expires_at=? WHERE id=?', expires_days ? now() + expires_days * 86400_000 : null, d.id);
    if (revoke) Q.run('UPDATE documents SET expires_at=? WHERE id=?', now() - 1, d.id);
    if (watermark !== undefined) Q.run('UPDATE documents SET watermark=? WHERE id=?', watermark || null, d.id);
    if (allow_download !== undefined) Q.run('UPDATE documents SET allow_download=? WHERE id=?', allow_download ? 1 : 0, d.id);
    res.json(docOut(Q.get('SELECT * FROM documents WHERE id=?', d.id)));
  });
  r.delete('/documents/:id', auth, (req, res) => {
    const d = Q.get('SELECT * FROM documents WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    try { fs.unlinkSync(d.path); } catch {}
    Q.run('DELETE FROM documents WHERE id=?', d.id);
    res.json({ deleted: true });
  });

  // ---- Signature requests ----
  r.post('/sign-requests', auth, (req, res) => {
    const { document_id, signer_name, signer_email } = req.body || {};
    const d = Q.get("SELECT * FROM documents WHERE id=? AND user_id=? AND kind='pdf'", document_id, req.user.id);
    if (!d) return res.status(404).json({ error: 'PDF document not found' });
    const id = newId(9), token = newId(18);
    const audit = [{ at: now(), event: 'created', by: req.user.email, document_sha256: d.sha256 }];
    Q.run('INSERT INTO sign_requests (id,token,user_id,doc_id,signer_name,signer_email,created_at,audit) VALUES (?,?,?,?,?,?,?,?)',
      id, token, req.user.id, d.id, signer_name || null, signer_email || null, now(), JSON.stringify(audit));
    if (signer_email) core.upsertContact(req.user.id, signer_email, signer_name);
    res.status(201).json({ id, sign_url: `${config.baseUrl}/s/${token}`, status: 'pending' });
  });
  r.get('/sign-requests', auth, (req, res) => {
    res.json(Q.all('SELECT s.*, d.name doc_name FROM sign_requests s JOIN documents d ON d.id=s.doc_id WHERE s.user_id=? ORDER BY s.created_at DESC', req.user.id)
      .map((s) => ({ id: s.id, doc_id: s.doc_id, doc_name: s.doc_name, signer_name: s.signer_name, signer_email: s.signer_email, status: s.status,
        created_at: s.created_at, viewed_at: s.viewed_at, signed_at: s.signed_at, signed_sha256: s.signed_sha256, audit: parseJSON(s.audit, []),
        sign_url: `${config.baseUrl}/s/${s.token}` })));
  });
  r.get('/sign-requests/:id/signed.pdf', auth, (req, res) => {
    const s = Q.get("SELECT * FROM sign_requests WHERE id=? AND user_id=? AND status='signed'", req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'not signed yet' });
    res.type('application/pdf').set('Content-Disposition', `attachment; filename="signed-${s.id}.pdf"`).send(fs.readFileSync(s.signed_path));
  });

  function docOut(d) {
    const v = Q.get('SELECT COUNT(*) n, SUM(total_seconds) secs FROM doc_views WHERE doc_id=?', d.id);
    return { id: d.id, kind: d.kind, name: d.name, bytes: d.bytes, sha256: d.sha256, created_at: d.created_at, expires_at: d.expires_at,
      password_protected: !!d.password_hash, watermark: d.watermark, allow_download: !!d.allow_download, views: v.n, total_seconds: Math.round(v.secs || 0),
      share_url: `${config.baseUrl}/d/${d.id}` };
  }
  return r;
}

/** Public viewer/sign pages recipients open. */
export function docsPublicRouter({ core, config }) {
  const r = express.Router();
  const { Q } = core;
  r.use('/static', express.static(path.resolve(here, '../../public')));

  const getDoc = (id) => Q.get('SELECT * FROM documents WHERE id=?', id);
  const expired = (d) => d.expires_at && d.expires_at < now();

  r.get('/d/:id', (req, res) => {
    const d = getDoc(req.params.id);
    if (!d) return res.status(404).type('html').send(page('Not found', '<p>This document does not exist.</p>'));
    if (expired(d)) return res.status(410).type('html').send(page('Expired', '<h1>Link expired</h1><p>The sender has expired or revoked access to this file.</p>'));
    res.type('html').send(viewerPage({ id: d.id, kind: d.kind, name: d.name, needsPassword: !!d.password_hash, viewer: req.query.r || '', allowDownload: !!d.allow_download }));
  });

  r.post('/d/:id/open', express.json(), (req, res) => {
    const d = getDoc(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (expired(d)) return res.status(410).json({ error: 'expired' });
    if (!checkPassword(req.body?.password, d.password_hash)) return res.status(403).json({ error: 'wrong password' });
    const s = core.userSettings(d.user_id);
    const sid = newId(16);
    const viewer = String(req.body?.viewer || '').slice(0, 120) || null;
    Q.run('INSERT INTO doc_views (id,doc_id,viewer,started_at,last_ping_at,ip,ua) VALUES (?,?,?,?,?,?,?)', sid, d.id, viewer, now(), now(),
      storeIp(clientIp(req), s.ip_mode || config.ipMode, config.ipSalt), String(req.headers['user-agent'] || '').slice(0, 300));
    if (viewer && /@/.test(viewer)) core.upsertContact(d.user_id, viewer);
    core.addEvent(d.user_id, d.kind === 'video' ? 'video_view' : 'doc_view', { ref_id: d.id, contact_email: viewer && /@/.test(viewer) ? viewer.toLowerCase() : null, meta: { name: d.name, viewer } }, { req });
    const wm = d.watermark ? d.watermark.replace('{viewer}', viewer || 'Confidential') : null;
    res.json({ session: sid, file_url: `/d/${d.id}/file?s=${sid}`, watermark: wm, kind: d.kind });
  });

  r.get('/d/:id/file', (req, res) => {
    const d = getDoc(req.params.id);
    const v = d && Q.get('SELECT id FROM doc_views WHERE id=? AND doc_id=?', String(req.query.s || ''), d.id);
    if (!d || !v || expired(d)) return res.status(403).send('forbidden');
    res.set({ 'Content-Type': d.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': `${d.allow_download ? 'attachment' : 'inline'}; filename="${d.name.replace(/"/g, '')}"` });
    res.sendFile(d.path);
  });

  // Heartbeat from the viewer: adds seconds to the page being read (or to "video" for video messages).
  r.post('/d/:id/ping', express.json(), (req, res) => {
    const { s, page: p, seconds } = req.body || {};
    const v = Q.get('SELECT * FROM doc_views WHERE id=? AND doc_id=?', String(s || ''), req.params.id);
    if (!v) return res.status(404).json({ error: 'no session' });
    const secs = Math.max(0, Math.min(Number(seconds) || 0, 60));
    const pages = parseJSON(v.pages, {});
    const key = String(p ?? 1);
    pages[key] = Math.round(((pages[key] || 0) + secs) * 10) / 10;
    Q.run('UPDATE doc_views SET pages=?, total_seconds=total_seconds+?, last_ping_at=? WHERE id=?', JSON.stringify(pages), secs, now(), v.id);
    res.json({ ok: true });
  });

  // ---- Signing ----
  const getReq = (token) => Q.get('SELECT s.*, d.name doc_name, d.path doc_path, d.sha256 doc_sha FROM sign_requests s JOIN documents d ON d.id=s.doc_id WHERE s.token=?', token);

  r.get('/s/:token', (req, res) => {
    const s = getReq(req.params.token);
    if (!s) return res.status(404).type('html').send(page('Not found', '<p>This signature link is not valid.</p>'));
    if (s.status === 'signed') return res.type('html').send(page('Signed', `<h1>Already signed</h1><p>“${escapeHtml(s.doc_name)}” was signed on ${new Date(s.signed_at).toUTCString()}.</p>`));
    if (!s.viewed_at) {
      const audit = parseJSON(s.audit, []); audit.push({ at: now(), event: 'viewed', ua: String(req.headers['user-agent'] || '').slice(0, 200) });
      Q.run('UPDATE sign_requests SET viewed_at=?, audit=? WHERE id=?', now(), JSON.stringify(audit), s.id);
      core.addEvent(s.user_id, 'sign_viewed', { ref_id: s.id, contact_email: s.signer_email, meta: { name: s.doc_name, signer: s.signer_name || s.signer_email } }, { req });
    }
    res.type('html').send(signPage({ token: s.token, name: s.doc_name, signer: s.signer_name || '' }));
  });
  r.get('/s/:token/file', (req, res) => {
    const s = getReq(req.params.token);
    if (!s) return res.status(404).send('not found');
    res.type('application/pdf').set('Cache-Control', 'private, no-store').sendFile(s.doc_path);
  });
  r.post('/s/:token', express.json({ limit: '2mb' }), async (req, res) => {
    const s = getReq(req.params.token);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.status === 'signed') return res.status(409).json({ error: 'already signed' });
    const { name, signature, agree } = req.body || {};
    if (!agree || !name || !/^data:image\/png;base64,/.test(signature || '')) return res.status(400).json({ error: 'typed name, drawn signature and consent are required' });
    const settings = core.userSettings(s.user_id);
    const t = now();
    const ip = storeIp(clientIp(req), settings.ip_mode || config.ipMode, config.ipSalt);
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    const pdf = await PDFDocument.load(fs.readFileSync(s.doc_path));
    const png = await pdf.embedPng(Buffer.from(signature.split(',')[1], 'base64'));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages = pdf.getPages(); const last = pages[pages.length - 1];
    const { width } = last.getSize();
    const dims = png.scaleToFit(180, 60);
    last.drawImage(png, { x: width - dims.width - 50, y: 70, width: dims.width, height: dims.height });
    last.drawText(`Signed by ${name} · ${new Date(t).toISOString()}`, { x: width - 300, y: 56, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
    // Audit trail page.
    const audit = parseJSON(s.audit, []); audit.push({ at: t, event: 'signed', typed_name: name, ip, ua });
    const ap = pdf.addPage([595, 842]); let y = 790;
    const line = (txt, f = font, size = 10) => { ap.drawText(String(txt).slice(0, 105), { x: 50, y, size, font: f }); y -= size + 7; };
    line('Signature audit trail', bold, 16); y -= 4;
    line(`Document: ${s.doc_name}`); line(`Original SHA-256: ${s.doc_sha}`, font, 8);
    line(`Signer: ${s.signer_name || ''} <${s.signer_email || ''}>   Typed name: ${name}`);
    y -= 6;
    for (const a of audit) line(`${new Date(a.at).toISOString()}  ${a.event}${a.by ? ' by ' + a.by : ''}${a.ip ? '  ip ' + a.ip : ''}${a.ua ? '  ' + a.ua.slice(0, 60) : ''}`, font, 8);
    y -= 8;
    line('Electronic signature captured by the sender\'s self-hosted OpenEnvelope server (simple e-signature).', font, 8);
    line('Not a qualified/advanced e-signature (eIDAS) or a certificate-based digital signature.', font, 8);
    const bytes = Buffer.from(await pdf.save());
    const out = s.doc_path.replace(/\.pdf$/, `.signed-${s.id}.pdf`);
    fs.writeFileSync(out, bytes);
    Q.run("UPDATE sign_requests SET status='signed', signed_at=?, signed_path=?, signed_sha256=?, audit=? WHERE id=?", t, out, sha256(bytes), JSON.stringify(audit), s.id);
    core.addEvent(s.user_id, 'signed', { ref_id: s.id, contact_email: s.signer_email, meta: { name: s.doc_name, signer: name } }, { req });
    res.json({ ok: true, signed_sha256: sha256(bytes) });
  });
  return r;
}

function viewerPage({ id, kind, name, needsPassword, viewer, allowDownload }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)}</title><link rel="stylesheet" href="/static/viewer.css"></head>
<body><header><b>${escapeHtml(name)}</b><span id="pg" class="muted"></span></header>
<main id="app" data-id="${escapeHtml(id)}" data-kind="${kind}" data-needs-password="${needsPassword}" data-viewer="${escapeHtml(viewer)}" data-download="${allowDownload}">
<form id="gate" class="card"><h1>${escapeHtml(name)}</h1>
${needsPassword ? '<label>Password <input id="pw" type="password" required autocomplete="current-password"></label>' : ''}
<label>Your name or email <span class="muted">(optional)</span><input id="who" value="${escapeHtml(viewer)}" autocomplete="email"></label>
<button type="submit">Open ${kind === 'video' ? 'video' : 'document'}</button><p id="err" class="err" role="alert"></p>
<p class="muted small">The sender will see that you opened this ${kind === 'video' ? 'video' : 'file'} and roughly how long you spent ${kind === 'video' ? 'watching' : 'on each page'}.</p></form>
<div id="pages"></div></main><script type="module" src="/static/viewer.js"></script></body></html>`;
}

function signPage({ token, name, signer }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign: ${escapeHtml(name)}</title><link rel="stylesheet" href="/static/viewer.css"></head>
<body><header><b>Signature request: ${escapeHtml(name)}</b></header>
<main id="sign" data-token="${escapeHtml(token)}"><div id="pages"></div>
<form id="signform" class="card"><h2>Sign</h2>
<label>Full name <input id="name" required value="${escapeHtml(signer)}" autocomplete="name"></label>
<p>Draw your signature</p><canvas id="pad" width="500" height="160" aria-label="Signature pad"></canvas>
<p><button type="button" id="clear" class="secondary">Clear</button></p>
<label class="row"><input type="checkbox" id="agree" required> I agree to sign this document electronically.</label>
<button type="submit">Sign document</button><p id="err" class="err" role="alert"></p></form></main>
<script type="module" src="/static/sign.js"></script></body></html>`;
}
