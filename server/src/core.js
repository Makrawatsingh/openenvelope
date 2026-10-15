import { q } from './db.js';
import { now, newId, parseJSON, readUA, storeIp, clientIp, countryFromHeaders, escapeHtml, isGmailPrefetch } from './util.js';

export const DEFAULT_SETTINGS = {
  track_by_default: true,
  track_links: true,
  ip_mode: null,              // null = server default (IP_MODE env)
  self_open_grace_sec: 5,     // opens this soon after sending are treated as your own
  ignore_gmail_prefetch: true, // Gmail's automatic fetch at delivery is not an open (see util.isGmailPrefetch)
  default_reminder_hours: 0,  // 0 = no automatic "not opened" reminder
  digest_frequency: 'daily',  // off | daily | weekly | monthly
  digest_hour: 8,
  timezone: 'Asia/Kolkata',
  alert_email: false,         // also email me on every open/click (needs SMTP)
  alerts: {
    opens: true, clicks: true, documents: true,
    hot_threshold: 3, hot_window_min: 60,     // "hot conversation": N opens within the window
    revival_days: 7,                          // "old conversation revival": an open after N quiet days
    only_domains: [],                         // custom alerts: only notify for these recipient domains
    mute_contacts: [],
  },
  webhook_url: '',            // Zapier "Catch Hook" / Make / n8n: every event is POSTed here as JSON
  auto_bcc: '',               // CRM auto-BCC address added to tracked emails by the extension
  digest_email: '',           // defaults to the account email
};

export function mergeSettings(stored) {
  const s = parseJSON(stored, {});
  return { ...DEFAULT_SETTINGS, ...s, alerts: { ...DEFAULT_SETTINGS.alerts, ...(s.alerts || {}) } };
}

export function createCore({ db, config, mailer, log = () => {} }) {
  const Q = q(db);
  const listeners = new Set(); // SSE subscribers: fn(userId, event)

  const userSettings = (userId) => mergeSettings(Q.get('SELECT settings FROM users WHERE id=?', userId)?.settings);

  function upsertContact(userId, email, name) {
    if (!email) return;
    const e = String(email).trim().toLowerCase();
    Q.run(`INSERT INTO contacts (user_id,email,name,created_at) VALUES (?,?,?,?)
           ON CONFLICT(user_id,email) DO UPDATE SET name=COALESCE(contacts.name, excluded.name)`, userId, e, name || null, now());
  }

  function emitEvent(userId, ev) {
    for (const fn of listeners) { try { fn(userId, ev); } catch {} }
    const s = userSettings(userId);
    if (s.webhook_url && /^https?:\/\//.test(s.webhook_url)) {
      fetch(s.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'openenvelope', ...ev }) })
        .catch((e) => log('webhook failed', e.message));
    }
    if (s.alert_email && mailer.enabled && ['open', 'click', 'doc_view', 'signed', 'hot', 'revival', 'reminder_no_open', 'reminder_no_reply'].includes(ev.type)) {
      const u = Q.get('SELECT email FROM users WHERE id=?', userId);
      mailer.send({ to: s.digest_email || u.email, subject: `OpenEnvelope: ${describe(ev)}`, text: describe(ev) + '\n\n' + new Date(ev.ts).toISOString() })
        .catch((e) => log('alert mail failed', e.message));
    }
  }

  function describe(ev) {
    const subj = ev.subject ? `“${ev.subject}”` : 'your email';
    switch (ev.type) {
      case 'open': return `${ev.contact_email || 'Someone'} opened ${subj}`;
      case 'prefetch': return `Gmail fetched ${subj} on delivery (not counted as an open)`;
      case 'click': return `${ev.contact_email || 'Someone'} clicked ${ev.meta?.url || 'a link'} in ${subj}`;
      case 'hot': return `Hot conversation: ${subj} opened ${ev.meta?.opens} times in ${ev.meta?.window_min} min`;
      case 'revival': return `Old conversation revived: ${subj} opened again after ${ev.meta?.quiet_days} days`;
      case 'reminder_no_open': return `Reminder: ${subj} hasn't been opened yet`;
      case 'reminder_no_reply': return `Reminder: no reply yet to ${subj}`;
      case 'reply': return `${ev.contact_email || 'Someone'} replied to ${subj}`;
      case 'doc_view': return `${ev.meta?.viewer || 'Someone'} opened the document “${ev.meta?.name}”`;
      case 'video_view': return `${ev.meta?.viewer || 'Someone'} watched the video “${ev.meta?.name}”`;
      case 'signed': return `${ev.meta?.signer || 'Signer'} signed “${ev.meta?.name}”`;
      case 'sign_viewed': return `${ev.meta?.signer || 'Signer'} opened the signature request for “${ev.meta?.name}”`;
      case 'poll_vote': return `New vote on “${ev.meta?.question}”: ${ev.meta?.option}`;
      case 'unsubscribe': return `${ev.contact_email} unsubscribed`;
      case 'bounce': return `${ev.contact_email} bounced: ${ev.meta?.error || ''}`;
      default: return ev.type;
    }
  }

  /** Insert an event row; returns the event object (also pushed to SSE + webhook unless silent). */
  function addEvent(userId, type, fields = {}, { req, silent = false } = {}) {
    const s = userSettings(userId);
    let ip = null, ua = null, device = null, client = null, country = null, viaProxy = 0;
    if (req) {
      ua = String(req.headers['user-agent'] || '').slice(0, 400);
      ({ client, device, viaProxy } = readUA(ua));
      ip = storeIp(clientIp(req), s.ip_mode || config.ipMode, config.ipSalt);
      country = viaProxy ? null : countryFromHeaders(req);
    }
    const ts = fields.ts || now();
    const r = Q.run(`INSERT INTO events (user_id,type,email_id,ref_id,contact_email,ts,ip,ua,device,client,country,via_proxy,meta)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      userId, type, fields.email_id || null, fields.ref_id || null, fields.contact_email || null, ts,
      ip, ua, device, client, country, viaProxy, fields.meta ? JSON.stringify(fields.meta) : null);
    const ev = { id: Number(r.lastInsertRowid), type, ts, email_id: fields.email_id || null, ref_id: fields.ref_id || null,
      contact_email: fields.contact_email || null, subject: fields.subject || null, device, client, country, via_proxy: viaProxy, meta: fields.meta || null };
    ev.text = describe(ev);
    if (fields.contact_email) Q.run('UPDATE contacts SET last_activity_at=? WHERE user_id=? AND email=?', ts, userId, fields.contact_email);
    if (!silent && shouldNotify(s, ev)) emitEvent(userId, ev);
    return ev;
  }

  function shouldNotify(s, ev) {
    const a = s.alerts;
    if (ev.type === 'self_open' || ev.type === 'prefetch') return false;
    if (ev.type === 'open' && !a.opens) return false;
    if (ev.type === 'click' && !a.clicks) return false;
    if (['doc_view', 'video_view'].includes(ev.type) && !a.documents) return false;
    const who = (ev.contact_email || '').toLowerCase();
    if (who && a.mute_contacts?.map((x) => x.toLowerCase()).includes(who)) return false;
    if (who && a.only_domains?.length && !a.only_domains.some((d) => who.endsWith('@' + d.toLowerCase().replace(/^@/, '')))) return false;
    return true;
  }

  /** The pixel was fetched. Applies self-open filtering, then hot/revival detection. */
  function recordOpen(emailId, req) {
    const e = Q.get('SELECT * FROM emails WHERE id=?', emailId);
    if (!e || e.status === 'reserved' || e.status === 'deleted') return null;
    const s = userSettings(e.user_id);
    const t = now();
    const contact = e.contact_email || null;
    if (contact) {
      const c = Q.get('SELECT do_not_track FROM contacts WHERE user_id=? AND email=?', e.user_id, contact);
      if (c?.do_not_track) return null;
    }
    if (s.ignore_gmail_prefetch !== false && isGmailPrefetch(req.headers['user-agent'], clientIp(req), req.headers.referer || req.headers.referrer)) {
      return addEvent(e.user_id, 'prefetch', { email_id: e.id, contact_email: contact, subject: e.subject }, { req, silent: true });
    }
    const isSelf = t < (e.self_view_until || 0) || (e.sent_at && t - e.sent_at < (s.self_open_grace_sec || 0) * 1000);
    if (isSelf) return addEvent(e.user_id, 'self_open', { email_id: e.id, contact_email: contact, subject: e.subject }, { req, silent: true });
    const prevLast = e.last_open_at;
    Q.run('UPDATE emails SET open_count=open_count+1, last_open_at=?, first_open_at=COALESCE(first_open_at, ?) WHERE id=?', t, t, e.id);
    const ev = addEvent(e.user_id, 'open', { email_id: e.id, contact_email: contact, subject: e.subject, meta: { open_number: e.open_count + 1 } }, { req });
    const a = s.alerts;
    if (prevLast && a.revival_days > 0 && t - prevLast >= a.revival_days * 86400_000) {
      addEvent(e.user_id, 'revival', { email_id: e.id, contact_email: contact, subject: e.subject, meta: { quiet_days: Math.floor((t - prevLast) / 86400_000) } });
    }
    if (a.hot_threshold > 1) {
      const since = t - a.hot_window_min * 60_000;
      const n = Q.get("SELECT COUNT(*) n FROM events WHERE email_id=? AND type='open' AND ts>=?", e.id, since).n;
      if (n >= a.hot_threshold && (!e.hot_alerted_at || e.hot_alerted_at < since)) {
        Q.run('UPDATE emails SET hot_alerted_at=? WHERE id=?', t, e.id);
        addEvent(e.user_id, 'hot', { email_id: e.id, contact_email: contact, subject: e.subject, meta: { opens: n, window_min: a.hot_window_min } });
      }
    }
    return ev;
  }

  function recordClick(emailId, idx, req) {
    const e = Q.get('SELECT * FROM emails WHERE id=?', emailId);
    const l = Q.get('SELECT * FROM links WHERE email_id=? AND idx=?', emailId, Number(idx));
    if (!e || !l) return null;
    const t = now();
    const self = t < (e.self_view_until || 0);
    if (!self && e.status !== 'reserved') {
      Q.run('UPDATE links SET click_count=click_count+1 WHERE email_id=? AND idx=?', emailId, l.idx);
      Q.run('UPDATE emails SET click_count=click_count+1 WHERE id=?', emailId);
      addEvent(e.user_id, 'click', { email_id: e.id, contact_email: e.contact_email, subject: e.subject, meta: { url: l.url, idx: l.idx, kind: l.kind } }, { req });
    }
    return l.url;
  }

  /** Register links for an email and return their tracked URLs. */
  function registerLinks(emailId, urls, kind = 'link') {
    const out = [];
    const start = (Q.get('SELECT MAX(idx) m FROM links WHERE email_id=?', emailId)?.m ?? -1) + 1;
    urls.forEach((u, i) => {
      const url = String(u);
      if (!/^(https?:|mailto:)/i.test(url)) { out.push({ url, tracked_url: url, skipped: true }); return; }
      const idx = start + i;
      Q.run('INSERT INTO links (email_id, idx, url, kind) VALUES (?,?,?,?)', emailId, idx, url, kind);
      out.push({ idx, url, tracked_url: `${config.baseUrl}/c/${emailId}/${idx}` });
    });
    return out;
  }

  /** Rewrite every <a href> in HTML to a tracked redirect, add the pixel and (optionally) an unsubscribe footer. */
  function instrumentHtml(emailId, html, { unsubscribe = false, trackLinks = true } = {}) {
    let out = String(html || '');
    if (trackLinks) {
      const urls = [];
      out.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi, (m, href) => { if (/^https?:/i.test(href) && !href.startsWith(config.baseUrl)) urls.push(href.replace(/&amp;/g, '&')); return m; });
      const uniq = [...new Set(urls)];
      const map = new Map(registerLinks(emailId, uniq).map((l) => [l.url, l.tracked_url]));
      out = out.replace(/(<a\b[^>]*?href\s*=\s*["'])([^"']+)(["'])/gi, (m, a, href, b) => {
        const t = map.get(href.replace(/&amp;/g, '&')); return t ? a + t + b : m;
      });
    }
    if (unsubscribe) out += `<p style="font-size:11px;color:#888;margin-top:24px">Don't want these emails? <a href="${config.baseUrl}/u/${emailId}">Unsubscribe</a></p>`;
    out += `<img src="${config.baseUrl}/t/${emailId}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
    return out;
  }

  function emailSummary(e) {
    return { id: e.id, status: e.status, subject: e.subject, recipients: parseJSON(e.recipients, []), thread_id: e.thread_id,
      campaign_id: e.campaign_id, contact_email: e.contact_email, created_at: e.created_at, sent_at: e.sent_at,
      remind_at: e.remind_at, reminder_sent: !!e.reminder_sent, open_count: e.open_count, click_count: e.click_count,
      first_open_at: e.first_open_at, last_open_at: e.last_open_at, send_error: e.send_error, remind_mode: e.remind_mode, replied_at: e.replied_at };
  }

  return { Q, config, listeners, userSettings, upsertContact, addEvent, recordOpen, recordClick, registerLinks, instrumentHtml, emailSummary, describe, escapeHtml, newId };
}
