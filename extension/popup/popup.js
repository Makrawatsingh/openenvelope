import { api, getConfig, timeAgo } from '../lib/api.js';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const openDash = (hash = '') => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html' + hash) });
$('#open-dash').onclick = () => openDash();
$('#go-settings').onclick = () => openDash('#settings');

(async () => {
  const c = await getConfig();
  if (!c.serverUrl || !c.apiKey) { $('#setup').hidden = false; $('#status').textContent = 'Not connected'; return; }
  try {
    const [me, stats, events, emails] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/stats?days=7'), api('GET', '/api/events?limit=6'), api('GET', '/api/emails?limit=6')]);
    $('#status').textContent = 'Connected'; $('#status').classList.add('ok');
    $('#ready').hidden = false;
    $('#tbd').checked = me.settings.track_by_default;
    $('#tbd').onchange = (e) => api('PUT', '/api/settings', { track_by_default: e.target.checked });
    $('#stats').innerHTML = [['Sent (7d)', stats.sent], ['Open rate', Math.round(stats.open_rate * 100) + '%'], ['Clicks', stats.clicks]]
      .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
    $('#activity').innerHTML = events.map((e) => `<li><span>${esc(e.text)}</span><time>${timeAgo(e.ts)}</time></li>`).join('') || '<li class="muted">No activity yet</li>';
    $('#emails').innerHTML = emails.map((e) => `<li data-id="${e.id}" tabindex="0"><span><b class="tick ${e.open_count ? 'opened' : ''}">${e.open_count ? '✓✓' : '✓'}</b> ${esc(e.subject || '(no subject)')}</span><time>${e.open_count ? e.open_count + '×' : timeAgo(e.sent_at)}</time></li>`).join('') || '<li class="muted">Nothing tracked yet</li>';
    $('#emails').onclick = (ev) => { const li = ev.target.closest('li[data-id]'); if (li) openDash('#email=' + li.dataset.id); };
    chrome.runtime.sendMessage({ type: 'clear-badge' });
  } catch (e) { $('#status').textContent = 'Server error'; $('#setup').hidden = false; $('#setup p').textContent = 'Could not reach your server: ' + e.message; }
})();
