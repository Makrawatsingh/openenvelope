import crypto from 'node:crypto';

export const now = () => Date.now();
export const newId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hashKey = (k) => sha256('openenvelope-key:' + k);
export const parseJSON = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${h}`;
}
export function checkPassword(pw, stored) {
  if (!stored) return true;
  const [salt, h] = stored.split(':');
  const got = crypto.scryptSync(String(pw || ''), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
}

export function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || '';
}

/** Store an IP according to the privacy mode: hash (salted), full, or none. */
export function storeIp(ip, mode, salt) {
  if (!ip || mode === 'none') return null;
  if (mode === 'full') return ip;
  return 'h:' + sha256(salt + ':' + ip).slice(0, 16);
}

/**
 * Gmail fetches images once at DELIVERY, seconds after the message lands and before
 * anyone opens it, from Google's own addresses with a fixed fake 2015 Edge user agent:
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
 *   Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0
 * Observed in a live Gmail test on 2026-10-15 (2.5 s after send, Referer http://mail.google.com/,
 * IPs 74.125.217.x). Real opens then arrive with the "GoogleImageProxy" agent.
 * No real 2026 browser sends Chrome/42 + Edge/12, so this signature is safe to treat as a prefetch.
 */
export const GMAIL_PREFETCH_UA = /Chrome\/42\.0\.2311\.135 Safari\/537\.36 Edge\/12\.\d+/;

/** Google's long-standing mail/proxy address blocks (IPv4). Used together with the Gmail Referer. */
const GOOGLE_V4 = [['74.125.0.0', 16], ['66.249.64.0', 19], ['64.233.160.0', 19], ['66.102.0.0', 20], ['72.14.192.0', 18], ['209.85.128.0', 17], ['173.194.0.0', 16], ['108.177.0.0', 17], ['142.250.0.0', 15], ['172.217.0.0', 16]];
const v4num = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
export function isGoogleIp(ip = '') {
  const m = String(ip).replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(m)) return false;
  const n = v4num(m);
  return GOOGLE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4num(base) / 2 ** (32 - bits)));
}

/**
 * True when a pixel fetch is Gmail's automatic delivery-time prefetch, not a person opening:
 * the fake-Edge signature, or any non-GoogleImageProxy agent coming from Google's addresses
 * with Gmail as the Referer.
 */
export function isGmailPrefetch(ua = '', ip = '', referer = '') {
  const s = String(ua);
  if (GMAIL_PREFETCH_UA.test(s)) return true;
  if (/GoogleImageProxy|ggpht\.com/i.test(s)) return false;
  return isGoogleIp(ip) && /^https?:\/\/mail\.google\.com/i.test(String(referer));
}

/**
 * Best-effort user-agent reading. Mail proxies hide the real reader: Gmail fetches
 * images through GoogleImageProxy, so device and location are unknown for Gmail opens.
 */
export function readUA(ua = '') {
  const s = String(ua);
  let client = 'Unknown', device = 'Unknown', viaProxy = 0;
  if (GMAIL_PREFETCH_UA.test(s)) { client = 'Gmail (delivery prefetch)'; viaProxy = 1; device = 'Hidden by proxy'; }
  else if (/GoogleImageProxy|ggpht\.com/i.test(s)) { client = 'Gmail (Google image proxy)'; viaProxy = 1; device = 'Hidden by proxy'; }
  else if (/YahooMailProxy/i.test(s)) { client = 'Yahoo Mail (proxy)'; viaProxy = 1; device = 'Hidden by proxy'; }
  else {
    if (/Microsoft Outlook|ms-office|MSOffice/i.test(s)) client = 'Outlook';
    else if (/Thunderbird/i.test(s)) client = 'Thunderbird';
    else if (/Edg\//.test(s)) client = 'Edge';
    else if (/Chrome\//.test(s)) client = 'Chrome';
    else if (/Firefox\//.test(s)) client = 'Firefox';
    else if (/Safari\//.test(s)) client = 'Safari';
    else if (/AppleWebKit/.test(s) && /Mobile/.test(s)) client = 'Apple Mail (iOS)';
    else if (/AppleWebKit/.test(s)) client = 'Apple Mail (macOS) or WebKit';
    if (/iPhone/.test(s)) device = 'iPhone';
    else if (/iPad/.test(s)) device = 'iPad';
    else if (/Android/.test(s)) device = /Mobile/.test(s) ? 'Android phone' : 'Android tablet';
    else if (/Windows/.test(s)) device = 'Windows PC';
    else if (/Macintosh|Mac OS X/.test(s)) device = 'Mac';
    else if (/Linux/.test(s)) device = 'Linux';
  }
  return { client, device, viaProxy };
}

/** Country only from headers a CDN in front of you adds (Cloudflare, Vercel, Fly). No GeoIP database is bundled. */
export function countryFromHeaders(req) {
  return req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country'] || null;
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** {{first_name}} style merge with an optional fallback: {{first_name|there}} */
export function renderTemplate(tpl, row) {
  return String(tpl || '').replace(/\{\{\s*([\w .-]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_, key, fb) => {
    const k = Object.keys(row).find((x) => x.toLowerCase().replace(/[\s-]/g, '_') === key.toLowerCase().replace(/[\s-]/g, '_'));
    const v = k ? row[k] : '';
    return v === undefined || v === null || v === '' ? (fb ?? '') : String(v);
  });
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). Returns array of objects keyed by header. */
export function parseCSV(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = [];
    } else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function htmlToText(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}
