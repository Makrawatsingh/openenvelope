import express from 'express';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { newId, hashKey, now, parseJSON, sha256 } from '../util.js';
import { mergeSettings, DEFAULT_SETTINGS } from '../core.js';
import { buildDigest } from '../digest.js';

export function apiRouter({ core, config, auth, mailer }) {
  const r = express.Router();
  const { Q } = core;

  // ---- Accounts ----
  r.post('/users', (req, res) => {
    const admin = (req.headers.authorization || '') === `Bearer ${config.adminToken}` && config.adminToken;
    if (!admin && !config.allowSignup) return res.status(403).json({ error: 'signup disabled; use ADMIN_TOKEN or `npm run create-user`' });
    const { email, name } = req.body || {};
    if (!email || !/@/.test(email)) return res.status(400).json({ error: 'email required' });
    if (Q.get('SELECT id FROM users WHERE email=?', email)) return res.status(409).json({ error: 'user exists' });
    const key = 'oe_' + newId(24);
    const id = newId();
    Q.run('INSERT INTO users (id,email,name,api_key_hash,created_at) VALUES (?,?,?,?,?)', id, email, name || null, hashKey(key), now());
    res.status(201).json({ id, email, api_key: key });
  });

  r.get('/me', auth, (req, res) => {
    const u = req.user;
    res.json({ id: u.id, email: u.email, name: u.name, settings: mergeSettings(u.settings), server: { base_url: config.baseUrl, smtp: mailer.enabled, ip_mode: config.ipMode } });
  });

  r.put('/settings', auth, (req, res) => {
    const cur = mergeSettings(req.user.settings);
    const body = req.body || {};
    const next = { ...cur };
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in body) next[k] = k === 'alerts' ? { ...cur.alerts, ...body.alerts } : body[k];
    if (next.ip_mode && !['hash', 'full', 'none'].includes(next.ip_mode)) return res.status(400).json({ error: 'ip_mode must be hash|full|none' });
    Q.run('UPDATE users SET settings=? WHERE id=?', JSON.stringify(next), req.user.id);
    res.json(next);
  });

  // ---- Tracked emails ----
  // 1) Reserve an id when a compose window opens (so the pixel URL is known before Send).
  r.post('/emails/reserve', auth, (req, res) => {
    const id = newId(12);
    Q.run('INSERT INTO emails (id,user_id,status,created_at) VALUES (?,?,?,?)', id, req.user.id, 'reserved', now());
    res.status(201).json({ id, pixel_url: `${config.baseUrl}/t/${id}.gif` });
  });

  // 2) Right before Send: register metadata + links, get tracked link URLs back.
  r.post('/emails/:id/prepare', auth, (req, res) => {
    const e = Q.get('SELECT * FROM emails WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const { subject = '', recipients = [], urls = [], remind_hours, remind_mode, thread_id, buttons = [] } = req.body || {};
    const s = mergeSettings(req.user.settings);
    const hours = remind_hours ?? s.default_reminder_hours;
    const t = now();
    const recips = recipients.map((x) => String(x).toLowerCase());
    Q.run(`UPDATE emails SET status='sent', subject=?, recipients=?, sent_at=?, remind_at=?, thread_id=COALESCE(?, thread_id),
           contact_email=? WHERE id=?`, subject, JSON.stringify(recips), t, hours > 0 ? t + hours * 3600_000 : null, thread_id || null,
      recips.length === 1 ? recips[0] : null, e.id);
    if (remind_mode === 'no_reply') Q.run("UPDATE emails SET remind_mode='no_reply' WHERE id=?", e.id);
    recips.forEach((x) => core.upsertContact(req.user.id, x));
    Q.run('DELETE FROM links WHERE email_id=?', e.id);
    const links = core.registerLinks(e.id, urls);
    const btns = core.registerLinks(e.id, buttons, 'button');
    res.json({ id: e.id, pixel_url: `${config.baseUrl}/t/${e.id}.gif`, links, buttons: btns });
  });

  // Mark "I am looking at my own sent email right now" so the proxy fetch it triggers is not counted.
  r.post('/emails/:id/self-view', auth, (req, res) => {
    const secs = Math.min(Number(req.body?.seconds || 30), 120);
    const info = Q.run('UPDATE emails SET self_view_until=? WHERE id=? AND user_id=?', now() + secs * 1000, req.params.id, req.user.id);
    // The proxy fetch can race ahead of this ping: re-label opens from the last 5 s as the sender's own.
    const recent = Q.all("SELECT id FROM events WHERE email_id=? AND user_id=? AND type='open' AND ts>=?", req.params.id, req.user.id, now() - 5000);
    if (recent.length) {
      Q.run(`UPDATE events SET type='self_open' WHERE id IN (${recent.map(() => '?').join(',')})`, ...recent.map((x) => x.id));
      Q.run('UPDATE emails SET open_count=MAX(open_count-?,0) WHERE id=?', recent.length, req.params.id);
      Q.run("UPDATE emails SET first_open_at=(SELECT MIN(ts) FROM events WHERE email_id=? AND type='open'), last_open_at=(SELECT MAX(ts) FROM events WHERE email_id=? AND type='open') WHERE id=?", req.params.id, req.params.id, req.params.id);
    }
    res.json({ ok: info.changes > 0, relabelled: recent.length });
  });

  r.put('/emails/:id', auth, (req, res) => {
    const { remind_hours, remind_mode, thread_id, replied } = req.body || {};
    const e = Q.get('SELECT * FROM emails WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    if (remind_hours !== undefined) Q.run('UPDATE emails SET remind_at=?, reminder_sent=0 WHERE id=?', remind_hours > 0 ? now() + remind_hours * 3600_000 : null, e.id);
    if (thread_id) Q.run('UPDATE emails SET thread_id=? WHERE id=?', thread_id, e.id);
    if (remind_mode) Q.run('UPDATE emails SET remind_mode=? WHERE id=?', remind_mode === 'no_reply' ? 'no_reply' : 'no_open', e.id);
    if (replied && !e.replied_at) {
      Q.run('UPDATE emails SET replied_at=? WHERE id=?', now(), e.id);
      core.addEvent(req.user.id, 'reply', { email_id: e.id, contact_email: e.contact_email, subject: e.subject });
    }
    res.json(core.emailSummary(Q.get('SELECT * FROM emails WHERE id=?', e.id)));
  });

  r.get('/emails', auth, (req, res) => {
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const qs = req.query.q ? `%${req.query.q}%` : null;
    const rows = Q.all(`SELECT * FROM emails WHERE user_id=? AND status!='reserved' ${req.query.campaign ? 'AND campaign_id=?' : "AND (campaign_id IS NULL OR ?='')"}
      ${qs ? 'AND (subject LIKE ? OR recipients LIKE ?)' : ''} ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ?`,
      req.user.id, req.query.campaign || '', ...(qs ? [qs, qs] : []), limit);
    res.json(rows.map(core.emailSummary));
  });

  r.get('/emails/lookup', auth, (req, res) => {
    // For the Gmail list view: find tracked emails by thread id or subject.
    const { thread_id, subject } = req.query;
    const rows = thread_id ? Q.all("SELECT * FROM emails WHERE user_id=? AND thread_id=? AND status!='reserved'", req.user.id, thread_id)
      : Q.all("SELECT * FROM emails WHERE user_id=? AND subject=? AND status!='reserved' ORDER BY sent_at DESC LIMIT 5", req.user.id, subject || '');
    res.json(rows.map(core.emailSummary));
  });

  r.get('/emails/:id', auth, (req, res) => {
    const e = Q.get('SELECT * FROM emails WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const events = Q.all("SELECT id,type,ts,device,client,country,via_proxy,ip,meta,contact_email FROM events WHERE email_id=? ORDER BY ts", e.id)
      .map((x) => ({ ...x, meta: parseJSON(x.meta, null) }));
    const links = Q.all('SELECT idx,url,kind,click_count FROM links WHERE email_id=? ORDER BY idx', e.id);
    res.json({ ...core.emailSummary(e), events, links });
  });

  r.delete('/emails/:id', auth, (req, res) => {
    Q.run('DELETE FROM events WHERE email_id=? AND user_id=?', req.params.id, req.user.id);
    const info = Q.run('DELETE FROM emails WHERE id=? AND user_id=?', req.params.id, req.user.id);
    res.json({ deleted: info.changes > 0 });
  });

  // "Certified email" style record: a PDF of the tracking history with a SHA-256 fingerprint.
  // This is a self-issued activity record, NOT a legally qualified certified-delivery service.
  r.get('/emails/:id/certificate', auth, async (req, res) => {
    const e = Q.get('SELECT * FROM emails WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    const events = Q.all("SELECT type,ts,client,device FROM events WHERE email_id=? AND type IN ('open','click') ORDER BY ts", e.id);
    const record = { email_id: e.id, subject: e.subject, recipients: parseJSON(e.recipients, []), sent_at: e.sent_at, events };
    const fp = sha256(JSON.stringify(record));
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    let page = pdf.addPage([595, 842]); let y = 790;
    const line = (t, f = font, size = 10) => { if (y < 60) { page = pdf.addPage([595, 842]); y = 790; } page.drawText(String(t).slice(0, 110), { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.1) }); y -= size + 6; };
    line('OpenEnvelope email activity record', bold, 16); y -= 6;
    line(`Subject: ${e.subject || '(none)'}`); line(`Recipients: ${record.recipients.join(', ')}`);
    line(`Sent (server time): ${e.sent_at ? new Date(e.sent_at).toISOString() : 'n/a'}`);
    line(`Opens: ${e.open_count}   Clicks: ${e.click_count}`); y -= 6;
    line('Events', bold, 12);
    for (const ev of events) line(`${new Date(ev.ts).toISOString()}  ${ev.type}  ${ev.client || ''} ${ev.device || ''}`);
    y -= 10; line(`Record fingerprint (SHA-256): ${fp}`, font, 8);
    line('Self-issued by the sender\'s own OpenEnvelope server. Not a qualified/legal certified-delivery service.', font, 8);
    line('Opens are inferred from image loads and can be blocked, proxied or pre-fetched by mail clients.', font, 8);
    res.type('application/pdf').set('Content-Disposition', `attachment; filename="openenvelope-record-${e.id}.pdf"`).send(Buffer.from(await pdf.save()));
  });

  // ---- Events feed (notifications) ----
  r.get('/events', auth, (req, res) => {
    const since = Number(req.query.since || 0);
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const rows = Q.all(`SELECT ev.*, e.subject FROM events ev LEFT JOIN emails e ON e.id=ev.email_id
      WHERE ev.user_id=? AND ev.id>? AND ev.type NOT IN ('self_open','prefetch') ORDER BY ev.id ${since ? 'ASC' : 'DESC'} LIMIT ?`, req.user.id, since, limit);
    res.json(rows.map((x) => { const ev = { ...x, meta: parseJSON(x.meta, null) }; delete ev.user_id; delete ev.ua; ev.text = core.describe(ev); return ev; }));
  });

  // Server-sent events for the web dashboard (real-time).
  r.get('/stream', auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    const fn = (userId, ev) => { if (userId === req.user.id) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    core.listeners.add(fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); core.listeners.delete(fn); });
  });

  r.get('/stats', auth, (req, res) => {
    const days = Number(req.query.days || 30);
    const since = now() - days * 86400_000;
    const u = req.user.id;
    const sent = Q.get("SELECT COUNT(*) n, SUM(open_count>0) opened, SUM(click_count>0) clicked FROM emails WHERE user_id=? AND status='sent' AND sent_at>=?", u, since);
    const opens = Q.get("SELECT COUNT(*) n FROM events WHERE user_id=? AND type='open' AND ts>=?", u, since).n;
    const clicks = Q.get("SELECT COUNT(*) n FROM events WHERE user_id=? AND type='click' AND ts>=?", u, since).n;
    const byHour = Q.all("SELECT CAST(strftime('%H', ts/1000, 'unixepoch') AS INTEGER) h, COUNT(*) n FROM events WHERE user_id=? AND type='open' AND ts>=? GROUP BY h", u, since);
    res.json({ days, sent: sent.n, opened: sent.opened || 0, clicked: sent.clicked || 0, open_rate: sent.n ? (sent.opened || 0) / sent.n : 0,
      click_rate: sent.n ? (sent.clicked || 0) / sent.n : 0, opens, clicks, opens_by_utc_hour: byHour });
  });

  r.get('/digest/preview', auth, (req, res) => {
    const d = buildDigest(core, req.user, req.query.period || 'daily');
    if (req.query.format === 'html') return res.type('html').send(d.html);
    res.json(d);
  });

  // ---- Contacts (self-organised CRM), lists, notes, privacy ----
  r.get('/contacts', auth, (req, res) => {
    const rows = Q.all(`SELECT c.*, (SELECT COUNT(*) FROM events ev WHERE ev.user_id=c.user_id AND ev.contact_email=c.email AND ev.type='open') opens,
      (SELECT COUNT(*) FROM events ev WHERE ev.user_id=c.user_id AND ev.contact_email=c.email AND ev.type='click') clicks
      FROM contacts c WHERE c.user_id=? ${req.query.list ? "AND c.lists LIKE ?" : ''} ORDER BY COALESCE(c.last_activity_at, c.created_at) DESC`,
      req.user.id, ...(req.query.list ? [`%"${req.query.list}"%`] : []));
    res.json(rows.map((c) => ({ ...c, lists: parseJSON(c.lists, []), user_id: undefined, unsubscribed: !!c.unsubscribed, do_not_track: !!c.do_not_track, bounced: !!c.bounced })));
  });
  r.get('/lists', auth, (req, res) => {
    const counts = {};
    for (const c of Q.all('SELECT lists FROM contacts WHERE user_id=?', req.user.id)) for (const l of parseJSON(c.lists, [])) counts[l] = (counts[l] || 0) + 1;
    res.json(Object.entries(counts).map(([name, count]) => ({ name, count })));
  });
  r.put('/contacts/:email', auth, (req, res) => {
    const email = req.params.email.toLowerCase();
    core.upsertContact(req.user.id, email, req.body?.name);
    const { name, notes, lists, do_not_track, unsubscribed } = req.body || {};
    if (name !== undefined) Q.run('UPDATE contacts SET name=? WHERE user_id=? AND email=?', name, req.user.id, email);
    if (notes !== undefined) Q.run('UPDATE contacts SET notes=? WHERE user_id=? AND email=?', notes, req.user.id, email);
    if (lists !== undefined) Q.run('UPDATE contacts SET lists=? WHERE user_id=? AND email=?', JSON.stringify(lists), req.user.id, email);
    if (do_not_track !== undefined) Q.run('UPDATE contacts SET do_not_track=? WHERE user_id=? AND email=?', do_not_track ? 1 : 0, req.user.id, email);
    if (unsubscribed !== undefined) Q.run('UPDATE contacts SET unsubscribed=? WHERE user_id=? AND email=?', unsubscribed ? 1 : 0, req.user.id, email);
    res.json(Q.get('SELECT email,name,notes,lists,do_not_track,unsubscribed FROM contacts WHERE user_id=? AND email=?', req.user.id, email));
  });
  // Privacy: export everything held about one contact, or erase it.
  r.get('/contacts/:email/export', auth, (req, res) => {
    const email = req.params.email.toLowerCase();
    res.json({ contact: Q.get('SELECT * FROM contacts WHERE user_id=? AND email=?', req.user.id, email) || null,
      emails: Q.all("SELECT id,subject,sent_at,open_count,click_count FROM emails WHERE user_id=? AND (contact_email=? OR recipients LIKE ?)", req.user.id, email, `%"${email}"%`),
      events: Q.all('SELECT type,ts,client,device,country FROM events WHERE user_id=? AND contact_email=?', req.user.id, email) });
  });
  r.delete('/contacts/:email', auth, (req, res) => {
    const email = req.params.email.toLowerCase();
    const ev = Q.run('DELETE FROM events WHERE user_id=? AND contact_email=?', req.user.id, email).changes;
    Q.run('DELETE FROM contacts WHERE user_id=? AND email=?', req.user.id, email);
    res.json({ erased: true, events_deleted: ev });
  });

  // ---- Templates ----
  r.get('/templates', auth, (req, res) => res.json(Q.all('SELECT * FROM templates WHERE user_id=? ORDER BY created_at DESC', req.user.id)));
  r.post('/templates', auth, (req, res) => {
    const { name, subject = '', body = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = newId();
    Q.run('INSERT INTO templates (id,user_id,name,subject,body,created_at) VALUES (?,?,?,?,?,?)', id, req.user.id, name, subject, body, now());
    res.status(201).json(Q.get('SELECT * FROM templates WHERE id=?', id));
  });
  r.put('/templates/:id', auth, (req, res) => {
    const { name, subject, body } = req.body || {};
    Q.run('UPDATE templates SET name=COALESCE(?,name), subject=COALESCE(?,subject), body=COALESCE(?,body) WHERE id=? AND user_id=?', name ?? null, subject ?? null, body ?? null, req.params.id, req.user.id);
    res.json(Q.get('SELECT * FROM templates WHERE id=?', req.params.id));
  });
  r.delete('/templates/:id', auth, (req, res) => res.json({ deleted: Q.run('DELETE FROM templates WHERE id=? AND user_id=?', req.params.id, req.user.id).changes > 0 }));

  // ---- Polls (one-click answers inside an email) ----
  r.post('/polls', auth, (req, res) => {
    const { question, options } = req.body || {};
    if (!question || !Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'question and 2+ options required' });
    const id = newId(9);
    Q.run('INSERT INTO polls (id,user_id,question,options,created_at) VALUES (?,?,?,?,?)', id, req.user.id, question, JSON.stringify(options), now());
    const links = options.map((o, i) => ({ option: o, url: `${config.baseUrl}/p/${id}/${i}` }));
    const html = `<div style="border:1px solid #ddd;border-radius:8px;padding:12px;max-width:420px"><p style="margin:0 0 8px;font-weight:600">${core.escapeHtml(question)}</p>` +
      links.map((l) => `<a href="${l.url}" style="display:inline-block;margin:4px 6px 4px 0;padding:8px 14px;border-radius:6px;background:#1a73e8;color:#fff;text-decoration:none">${core.escapeHtml(l.option)}</a>`).join('') + '</div>';
    res.status(201).json({ id, links, html });
  });
  r.get('/polls', auth, (req, res) => res.json(Q.all('SELECT * FROM polls WHERE user_id=? ORDER BY created_at DESC', req.user.id).map((p) => pollResult(p))));
  r.get('/polls/:id', auth, (req, res) => {
    const p = Q.get('SELECT * FROM polls WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json(pollResult(p));
  });
  function pollResult(p) {
    const opts = parseJSON(p.options, []);
    const votes = Q.all('SELECT option_idx, COUNT(*) n FROM poll_votes WHERE poll_id=? GROUP BY option_idx', p.id);
    return { id: p.id, question: p.question, created_at: p.created_at, options: opts.map((o, i) => ({ option: o, votes: votes.find((v) => v.option_idx === i)?.n || 0 })) };
  }

  // Debug: what the server tried to email (digests/alerts) — handy when SMTP isn't configured yet.
  r.get('/outbox', auth, (req, res) => res.json(mailer.sent.slice(-20).map((m) => ({ to: m.to, subject: m.subject, skipped: m.skipped || null }))));

  return r;
}
