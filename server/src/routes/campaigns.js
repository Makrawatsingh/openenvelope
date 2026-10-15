import express from 'express';
import { newId, now, parseJSON, parseCSV, renderTemplate, htmlToText } from '../util.js';

/**
 * Mail merge campaigns. Each recipient gets their own tracked copy (own pixel, own links,
 * own unsubscribe link), so you see exactly who opened. Sending happens either
 *  - through the Gmail API from the Chrome extension (send_via "gmail"), or
 *  - through SMTP from this server (send_via "smtp"; also works for scheduled sends while your browser is closed).
 */
export function campaignRouter({ core, config, auth, mailer, log }) {
  const r = express.Router();
  const { Q } = core;

  r.post('/campaigns', auth, async (req, res) => {
    let { name, subject, body, rows, csv, sheet_url, list, send_via = 'gmail', schedule_at, email_column } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
    try {
      if (!rows && csv) rows = parseCSV(csv);
      if (!rows && sheet_url) rows = parseCSV(await fetchSheetCsv(sheet_url));
      if (!rows && list) rows = Q.all('SELECT email, name FROM contacts WHERE user_id=? AND lists LIKE ?', req.user.id, `%"${list}"%`);
    } catch (e) { return res.status(400).json({ error: 'could not read recipients: ' + e.message }); }
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'no recipients (rows, csv, sheet_url or list)' });
    const col = email_column || Object.keys(rows[0]).find((k) => /^e-?mail( address)?$/i.test(k.trim())) || Object.keys(rows[0]).find((k) => /mail/i.test(k));
    if (!col) return res.status(400).json({ error: 'no email column found' });
    const id = newId(9);
    const status = schedule_at ? 'scheduled' : 'ready';
    Q.run('INSERT INTO campaigns (id,user_id,name,subject_tpl,body_tpl,send_via,status,schedule_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, req.user.id, name || subject, subject, body, send_via, status, schedule_at ? Number(new Date(schedule_at)) : null, now());
    let skipped = [];
    const seen = new Set();
    for (const row of rows) {
      const to = String(row[col] || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || seen.has(to)) { skipped.push({ to, reason: seen.has(to) ? 'duplicate' : 'invalid email' }); continue; }
      seen.add(to);
      const c = Q.get('SELECT unsubscribed, bounced FROM contacts WHERE user_id=? AND email=?', req.user.id, to);
      if (c?.unsubscribed) { skipped.push({ to, reason: 'unsubscribed' }); continue; }
      core.upsertContact(req.user.id, to, row.name || row.Name || row.first_name || null);
      const eid = newId(12);
      Q.run('INSERT INTO emails (id,user_id,status,subject,recipients,contact_email,campaign_id,data,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        eid, req.user.id, 'queued', renderTemplate(subject, row), JSON.stringify([to]), to, id, JSON.stringify(row), now());
      const html = core.instrumentHtml(eid, renderTemplate(body, row), { unsubscribe: true });
      Q.run('UPDATE emails SET html=? WHERE id=?', html, eid);
    }
    const n = Q.get('SELECT COUNT(*) n FROM emails WHERE campaign_id=?', id).n;
    res.status(201).json({ id, status, recipients: n, skipped });
  });

  r.get('/campaigns', auth, (req, res) => res.json(Q.all('SELECT * FROM campaigns WHERE user_id=? ORDER BY created_at DESC', req.user.id).map((c) => ({ ...c, stats: stats(c.id) }))));

  r.get('/campaigns/:id', auth, (req, res) => {
    const c = Q.get('SELECT * FROM campaigns WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const recips = Q.all('SELECT * FROM emails WHERE campaign_id=? ORDER BY created_at', c.id).map(core.emailSummary);
    res.json({ ...c, stats: stats(c.id), recipients: recips });
  });

  // Preview the first rendered message without creating anything.
  r.post('/campaigns/preview', auth, (req, res) => {
    const { subject = '', body = '', csv, rows } = req.body || {};
    const list = rows || parseCSV(csv || '');
    const row = list[0] || {};
    res.json({ count: list.length, columns: Object.keys(row), subject: renderTemplate(subject, row), body: renderTemplate(body, row) });
  });

  // Gmail-API path: the extension pulls queued messages, sends each through Gmail, reports back.
  r.get('/campaigns/:id/outbox', auth, (req, res) => {
    const c = Q.get('SELECT * FROM campaigns WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const due = !c.schedule_at || c.schedule_at <= now();
    const rows = due ? Q.all("SELECT id, recipients, subject, html FROM emails WHERE campaign_id=? AND status='queued' LIMIT ?", c.id, limit) : [];
    res.json({ campaign: c.id, due, messages: rows.map((m) => ({ email_id: m.id, to: parseJSON(m.recipients, [])[0], subject: m.subject, html: m.html, text: htmlToText(m.html) })) });
  });

  r.post('/campaigns/:id/result', auth, (req, res) => {
    const { email_id, ok, error, thread_id, message_id } = req.body || {};
    const e = Q.get('SELECT * FROM emails WHERE id=? AND campaign_id=? AND user_id=?', email_id, req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'not found' });
    markResult(e, ok, error, thread_id, message_id);
    finishIfDone(req.params.id);
    res.json({ ok: true });
  });

  r.post('/campaigns/:id/send', auth, async (req, res) => {
    const c = Q.get('SELECT * FROM campaigns WHERE id=? AND user_id=?', req.params.id, req.user.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    if (c.send_via !== 'smtp') return res.status(400).json({ error: 'this campaign is sent from the extension through Gmail' });
    if (!mailer.enabled) return res.status(400).json({ error: 'SMTP_URL is not configured on this server' });
    const result = await sendCampaignViaSmtp({ core, mailer, campaign: c });
    res.json(result);
  });

  r.delete('/campaigns/:id', auth, (req, res) => {
    Q.run("UPDATE campaigns SET status='cancelled' WHERE id=? AND user_id=?", req.params.id, req.user.id);
    Q.run("UPDATE emails SET status='cancelled' WHERE campaign_id=? AND status='queued'", req.params.id);
    res.json({ cancelled: true });
  });

  function stats(id) {
    const s = Q.get(`SELECT COUNT(*) total, SUM(status='sent') sent, SUM(status='queued') queued, SUM(status='bounced') bounced,
      SUM(open_count>0) opened, SUM(click_count>0) clicked FROM emails WHERE campaign_id=?`, id);
    const unsub = Q.get("SELECT COUNT(*) n FROM events WHERE type='unsubscribe' AND ref_id=?", id).n;
    return { total: s.total, sent: s.sent || 0, queued: s.queued || 0, bounced: s.bounced || 0, opened: s.opened || 0, clicked: s.clicked || 0, unsubscribed: unsub };
  }
  function markResult(e, ok, error, thread_id, message_id) { markSendResult(core, e, ok, error, thread_id, message_id); }
  function finishIfDone(id) { if (!Q.get("SELECT COUNT(*) n FROM emails WHERE campaign_id=? AND status='queued'", id).n) Q.run("UPDATE campaigns SET status='sent' WHERE id=?", id); }

  return r;
}

export function markSendResult(core, e, ok, error, thread_id, message_id) {
  const { Q } = core;
  if (ok) Q.run("UPDATE emails SET status='sent', sent_at=?, thread_id=?, message_id=? WHERE id=?", now(), thread_id || null, message_id || null, e.id);
  else {
    Q.run("UPDATE emails SET status='bounced', send_error=? WHERE id=?", String(error || 'send failed').slice(0, 300), e.id);
    Q.run('UPDATE contacts SET bounced=1 WHERE user_id=? AND email=?', e.user_id, e.contact_email);
    core.addEvent(e.user_id, 'bounce', { email_id: e.id, contact_email: e.contact_email, subject: e.subject, ref_id: e.campaign_id, meta: { error } });
  }
}

export async function sendCampaignViaSmtp({ core, mailer, campaign, delayMs = 0 }) {
  const { Q } = core;
  Q.run("UPDATE campaigns SET status='sending' WHERE id=?", campaign.id);
  let sent = 0, failed = 0;
  for (const m of Q.all("SELECT * FROM emails WHERE campaign_id=? AND status='queued'", campaign.id)) {
    const to = parseJSON(m.recipients, [])[0];
    try {
      const info = await mailer.send({ to, subject: m.subject, html: m.html, text: htmlToText(m.html),
        headers: { 'List-Unsubscribe': `<${core.config.baseUrl}/u/${m.id}>` } });
      markSendResult(core, m, true, null, null, info?.messageId); sent++;
    } catch (e) { markSendResult(core, m, false, e.message); failed++; }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  Q.run("UPDATE campaigns SET status='sent' WHERE id=?", campaign.id);
  return { sent, failed };
}

/** Accepts a Google Sheets URL (shared "anyone with the link" or published) and fetches it as CSV. */
export async function fetchSheetCsv(url) {
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  const csvUrl = m ? `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}` : url;
  const r = await fetch(csvUrl, { redirect: 'follow' });
  if (!r.ok) throw new Error(`sheet fetch ${r.status} — share the sheet as "anyone with the link can view" or paste CSV`);
  return r.text();
}
