// OpenEnvelope background service worker (Manifest V3).
// - relays API calls for the Gmail content script
// - polls the events feed and shows desktop notifications (chrome.alarms, every 30 s)
// - sends mail-merge campaigns through the Gmail API (chrome.identity)
// - checks tracked threads for replies (for "no reply" reminders)
import { api, getConfig, timeAgo } from './lib/api.js';

const POLL = 'openenvelope-poll';
const HOURLY = 'openenvelope-hourly';

chrome.runtime.onInstalled.addListener(async (d) => {
  chrome.alarms.create(POLL, { periodInMinutes: 0.5 });
  chrome.alarms.create(HOURLY, { periodInMinutes: 60 });
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html#settings') });
});
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(POLL, { periodInMinutes: 0.5 }); chrome.alarms.create(HOURLY, { periodInMinutes: 60 }); });

// Your own browser must never fetch your pixels directly (e.g. while the pixel sits in a compose
// window). Block image requests from Gmail tabs to <server>/t/*. Recipients' fetches are unaffected.
async function syncSelfBlockRule() {
  const { serverUrl } = await getConfig();
  const rules = [];
  try {
    const origin = new URL(serverUrl).origin;
    rules.push({ id: 1, priority: 1, action: { type: 'block' },
      condition: { urlFilter: `|${origin}/t/`, initiatorDomains: ['mail.google.com'], resourceTypes: ['image'] } });
  } catch {}
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: rules });
}
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'sync' && ch.serverUrl) syncSelfBlockRule(); });
syncSelfBlockRule().catch(() => {});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL) pollEvents().catch(() => {});
  if (a.name === HOURLY) { checkReplies().catch(() => {}); runDueGmailCampaigns().catch(() => {}); }
});

export async function pollEvents() {
  const { cursor = 0, seen = [], primedFor = '' } = await chrome.storage.local.get(['cursor', 'seen', 'primedFor']);
  const { serverUrl } = await getConfig();
  let events;
  if (primedFor !== serverUrl) {
    // First run against this server: start from the newest event, don't flood notifications with history.
    const latest = await api('GET', '/api/events?limit=1');
    await chrome.storage.local.set({ cursor: latest[0]?.id || 0, primedFor: serverUrl });
    return [];
  }
  events = await api('GET', `/api/events?since=${cursor}&limit=50`);
  if (!events.length) return [];
  const settings = (await api('GET', '/api/me')).settings;
  for (const ev of events) {
    if (['self_open', 'prefetch'].includes(ev.type)) continue;
    chrome.notifications.create(`tk-${ev.id}-${ev.email_id || ev.ref_id || ''}`, {
      type: 'basic', iconUrl: 'icons/icon128.png', title: titleFor(ev), message: ev.text,
      contextMessage: [ev.client, ev.device].filter(Boolean).join(' · '), priority: ev.type === 'hot' ? 2 : 0,
    });
  }
  const recent = [...events.reverse(), ...seen].slice(0, 50);
  await chrome.storage.local.set({ cursor: Math.max(...events.map((e) => e.id), cursor), seen: recent });
  const unread = (await chrome.storage.local.get({ unread: 0 })).unread + events.length;
  await chrome.storage.local.set({ unread });
  chrome.action.setBadgeText({ text: unread ? String(Math.min(unread, 99)) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#188038' });
  // Let open Gmail tabs refresh their ✓/✓✓ marks.
  const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'openenvelope-refresh' }).catch(() => {});
  return events;
}

function titleFor(ev) {
  return { open: '✓✓ Email opened', click: '🔗 Link clicked', hot: '🔥 Hot conversation', revival: '♻️ Old conversation revived',
    reminder_no_open: '⏰ Not opened yet', reminder_no_reply: '⏰ No reply yet', doc_view: '📄 Document opened', video_view: '🎬 Video watched',
    signed: '✍️ Document signed', sign_viewed: '✍️ Signature request opened', poll_vote: '🗳️ New poll answer', unsubscribe: 'Unsubscribed',
    bounce: '⚠️ Bounced', reply: '↩️ Reply received' }[ev.type] || 'OpenEnvelope';
}

chrome.notifications.onClicked.addListener((nid) => {
  const id = nid.split('-').slice(2).join('-');
  chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${id ? '#email=' + id : ''}`) });
});

// ---- Messages from the content script / pages ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'api': return api(msg.method, msg.path, msg.body);
      case 'config': { const c = await getConfig(); return { configured: !!(c.serverUrl && c.apiKey), serverUrl: c.serverUrl }; }
      case 'settings': return (await api('GET', '/api/me')).settings;
      case 'poll-now': return pollEvents();
      case 'send-campaign': return sendCampaignViaGmail(msg.campaignId);
      case 'attachments': return listAttachments(msg.pageToken);
      case 'open-dashboard': return chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard/dashboard.html${msg.hash || ''}`) });
      case 'clear-badge': await chrome.storage.local.set({ unread: 0 }); chrome.action.setBadgeText({ text: '' }); return true;
      default: throw new Error('unknown message ' + msg.type);
    }
  })().then((data) => reply({ ok: true, data }), (e) => reply({ ok: false, error: String(e.message || e) }));
  return true; // async reply
});

// ---- Gmail API helpers (need an OAuth client id in manifest.json; see README) ----
async function gmailToken(interactive = true) {
  const r = await chrome.identity.getAuthToken({ interactive });
  return typeof r === 'string' ? r : r.token;
}
async function gmail(path, init = {}) {
  const token = await gmailToken(init.interactive !== false);
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Gmail API ${r.status}`);
  return j;
}

export function buildMime({ to, subject, html, text, bcc }) {
  const b = 'tk_' + Math.random().toString(36).slice(2);
  const enc = (s) => `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`;
  const lines = [`To: ${to}`, bcc ? `Bcc: ${bcc}` : null, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset="UTF-8"', '', text || '', `--${b}`, 'Content-Type: text/html; charset="UTF-8"', '', html, `--${b}--`].filter((x) => x !== null);
  return btoa(unescape(encodeURIComponent(lines.join('\r\n')))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendCampaignViaGmail(campaignId) {
  let sent = 0, failed = 0;
  const settings = (await api('GET', '/api/me')).settings;
  for (;;) {
    const box = await api('GET', `/api/campaigns/${campaignId}/outbox?limit=20`);
    if (!box.due || !box.messages.length) break;
    for (const m of box.messages) {
      try {
        const res = await gmail('messages/send', { method: 'POST', body: JSON.stringify({ raw: buildMime({ ...m, bcc: settings.auto_bcc }) }) });
        await api('POST', `/api/campaigns/${campaignId}/result`, { email_id: m.email_id, ok: true, thread_id: res.threadId, message_id: res.id });
        sent++;
      } catch (e) {
        await api('POST', `/api/campaigns/${campaignId}/result`, { email_id: m.email_id, ok: false, error: e.message });
        failed++;
        if (/quota|rate|limit/i.test(e.message)) return { sent, failed, stopped: 'Gmail sending limit reached — resume later' };
      }
      await new Promise((r) => setTimeout(r, 1200)); // stay well under Gmail's per-second limits
    }
  }
  return { sent, failed };
}

async function runDueGmailCampaigns() {
  const list = await api('GET', '/api/campaigns');
  for (const c of list) if (c.send_via === 'gmail' && c.status === 'scheduled' && c.schedule_at <= Date.now()) await sendCampaignViaGmail(c.id);
}

// "No reply" detection: for tracked emails whose Gmail thread id is known, look for a message from someone else.
async function checkReplies() {
  const emails = await api('GET', '/api/emails?limit=100');
  const campaigns = await api('GET', '/api/campaigns');
  const all = [...emails];
  for (const c of campaigns.slice(0, 5)) all.push(...(await api('GET', `/api/emails?campaign=${c.id}&limit=200`)));
  const profile = await gmail('profile', { interactive: false });
  for (const e of all) {
    if (!e.thread_id || e.replied_at || !e.sent_at || Date.now() - e.sent_at > 30 * 86400_000) continue;
    const t = await gmail(`threads/${e.thread_id}?format=metadata&metadataHeaders=From`, { interactive: false }).catch(() => null);
    const replied = t?.messages?.some((m) => !m.payload.headers.find((h) => h.name === 'From')?.value.includes(profile.emailAddress));
    if (replied) await api('PUT', `/api/emails/${e.id}`, { replied: true });
  }
}

async function listAttachments(pageToken) {
  const list = await gmail(`messages?q=${encodeURIComponent('has:attachment')}&maxResults=25${pageToken ? '&pageToken=' + pageToken : ''}`);
  const out = [];
  for (const m of list.messages || []) {
    const full = await gmail(`messages/${m.id}?format=full&fields=id,threadId,internalDate,payload(headers,parts(filename,mimeType,body(size,attachmentId),parts(filename,mimeType,body(size,attachmentId))))`);
    const hdr = (n) => full.payload.headers?.find((h) => h.name === n)?.value || '';
    const walk = (parts = []) => parts.flatMap((p) => [p, ...walk(p.parts)]);
    for (const p of walk(full.payload.parts)) if (p.filename) out.push({ message_id: m.id, thread_id: full.threadId, date: Number(full.internalDate), from: hdr('From'), subject: hdr('Subject'), filename: p.filename, mime: p.mimeType, size: p.body?.size });
  }
  return { attachments: out, nextPageToken: list.nextPageToken || null };
}

export { timeAgo };
