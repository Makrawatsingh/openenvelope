// Shared API client used by the background worker, popup and dashboard.
// In the extension it reads settings from chrome.storage; served from the backend (/app) it uses localStorage.
const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export async function getConfig() {
  if (inExtension) {
    const c = await chrome.storage.sync.get({ serverUrl: '', apiKey: '' });
    return { serverUrl: c.serverUrl.replace(/\/$/, ''), apiKey: c.apiKey };
  }
  return { serverUrl: (localStorage.getItem('tk_server') || location.origin).replace(/\/$/, ''), apiKey: localStorage.getItem('tk_key') || '' };
}

export async function setConfig({ serverUrl, apiKey }) {
  if (inExtension) return chrome.storage.sync.set({ serverUrl, apiKey });
  localStorage.setItem('tk_server', serverUrl); localStorage.setItem('tk_key', apiKey);
}

export async function api(method, path, body, { raw, contentType } = {}) {
  const { serverUrl, apiKey } = await getConfig();
  if (!serverUrl || !apiKey) throw new Error('not-configured');
  const headers = { authorization: `Bearer ${apiKey}` };
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  if (raw && contentType) headers['content-type'] = contentType;
  const r = await fetch(serverUrl + path, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export const isExtension = inExtension;

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
