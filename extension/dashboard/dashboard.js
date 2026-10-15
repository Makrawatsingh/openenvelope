import { api, getConfig, setConfig, isExtension, timeAgo } from '../lib/api.js';

const view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const tick = (e) => `<b class="tick ${e.open_count ? 'opened' : ''}" aria-label="${e.open_count ? 'opened' : 'not opened'}">${e.open_count ? '✓✓' : '✓'}</b>`;
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');
if (!isExtension) document.body.classList.add('web');

const routes = { activity, emails, campaigns, contacts, documents, signatures, polls, templates, attachments, settings };

async function route() {
  const [name, arg] = (location.hash.slice(1) || 'activity').split('=');
  const key = name === 'email' ? 'emails' : name;
  document.querySelectorAll('nav a').forEach((a) => { if (a.getAttribute('href') === '#' + key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const c = await getConfig();
  if ((!c.serverUrl || !c.apiKey) && key !== 'settings') { location.hash = 'settings'; return; }
  view.innerHTML = '<p class="muted">Loading…</p>';
  try { await (routes[key] || activity)(arg); if (name === 'email' && arg) openEmail(arg); }
  catch (e) { view.innerHTML = `<h1>Something went wrong</h1><p class="err">${esc(e.message)}</p><p><a href="#settings">Check settings</a></p>`; }
}
addEventListener('hashchange', route);
route();

// ---------- Activity ----------
async function activity() {
  const [s, ev] = await Promise.all([api('GET', '/api/stats?days=30'), api('GET', '/api/events?limit=40')]);
  view.innerHTML = `<h1>Activity</h1>
  <div class="cards">${[['Tracked (30d)', s.sent], ['Opened', `${s.opened} · ${pct(s.opened, s.sent)}`], ['Clicked', `${s.clicked} · ${pct(s.clicked, s.sent)}`], ['Total opens', s.opens], ['Total clicks', s.clicks]]
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
  <div class="grid2"><section class="panel"><h2>Live feed</h2><ul class="feed" id="feed">${ev.map(feedItem).join('') || '<li class="muted">No activity yet. Send a tracked email from Gmail.</li>'}</ul></section>
  <section class="panel"><h2>When people open (UTC hour)</h2>${hourChart(s.opens_by_utc_hour)}<p class="muted" style="font-size:13px">Opens through Gmail's image proxy show Google's servers, not the reader's device or location.</p></section></div>`;
  view.querySelector('#feed').onclick = (e) => { const li = e.target.closest('[data-email]'); if (li) openEmail(li.dataset.email); };
  liveUpdates();
}
const feedItem = (e) => `<li ${e.email_id ? `data-email="${e.email_id}" tabindex="0" style="cursor:pointer"` : ''}><span>${esc(e.text)}${e.client && e.client !== 'Unknown' ? ` <span class="muted">· ${esc(e.client)}</span>` : ''}</span><time>${timeAgo(e.ts)}</time></li>`;
function hourChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<div style="display:flex;align-items:end;gap:2px;height:120px" role="img" aria-label="Opens by hour">${Array.from({ length: 24 }, (_, h) => {
    const n = rows.find((r) => r.h === h)?.n || 0; return `<div title="${h}:00 — ${n}" style="flex:1;background:${n ? '#1a73e8' : '#e8eaed'};height:${Math.max(3, (n / max) * 100)}%;border-radius:3px 3px 0 0"></div>`; }).join('')}</div>
    <div class="muted" style="display:flex;justify-content:space-between;font-size:11px"><span>0h</span><span>12h</span><span>23h</span></div>`;
}
let stream;
async function liveUpdates() {
  if (isExtension || stream) return; // the extension gets notifications from the background worker
  const { serverUrl, apiKey } = await getConfig();
  stream = new EventSource(`${serverUrl}/api/stream?key=${encodeURIComponent(apiKey)}`);
  stream.onmessage = (m) => { const f = document.getElementById('feed'); if (f) f.insertAdjacentHTML('afterbegin', feedItem(JSON.parse(m.data))); };
}

// ---------- Emails ----------
async function emails() {
  const list = await api('GET', '/api/emails?limit=200');
  view.innerHTML = `<h1>Tracked emails</h1><div class="row" style="margin-bottom:12px"><input id="q" type="search" placeholder="Search subject or recipient" aria-label="Search"></div>
  <section class="panel"><table><thead><tr><th></th><th>Subject</th><th>To</th><th>Sent</th><th>Opens</th><th>Clicks</th><th>Last open</th></tr></thead><tbody id="rows"></tbody></table></section>`;
  const draw = (items) => { view.querySelector('#rows').innerHTML = items.map((e) => `<tr class="click" data-id="${e.id}" tabindex="0"><td>${tick(e)}</td><td>${esc(e.subject || '(no subject)')}${e.remind_at && !e.reminder_sent ? ' <span class="pill">⏰</span>' : ''}${e.replied_at ? ' <span class="pill ok">replied</span>' : ''}</td><td>${esc(e.recipients.join(', '))}</td><td>${timeAgo(e.sent_at)}</td><td>${e.open_count}</td><td>${e.click_count}</td><td>${timeAgo(e.last_open_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing tracked yet.</td></tr>'; };
  draw(list);
  view.querySelector('#q').oninput = (e) => { const q = e.target.value.toLowerCase(); draw(list.filter((x) => (x.subject || '').toLowerCase().includes(q) || x.recipients.join(' ').includes(q))); };
  view.querySelector('#rows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openEmail(tr.dataset.id); };
}

async function openEmail(id) {
  const e = await api('GET', `/api/emails/${id}`);
  document.querySelector('.drawer')?.remove();
  const d = document.createElement('aside'); d.className = 'drawer'; d.setAttribute('aria-label', 'Email details');
  const opens = e.events.filter((x) => x.type === 'open'), clicks = e.events.filter((x) => x.type === 'click');
  d.innerHTML = `<button class="secondary small close">Close</button><h2>${tick(e)} ${esc(e.subject || '(no subject)')}</h2>
  <p class="muted">To ${esc(e.recipients.join(', '))}<br>Sent ${fmt(e.sent_at)}</p>
  <div class="cards"><div class="stat"><b>${opens.length}</b><span>opens</span></div><div class="stat"><b>${clicks.length}</b><span>clicks</span></div><div class="stat"><b>${e.replied_at ? 'yes' : '—'}</b><span>replied</span></div></div>
  <h2>Open history</h2><ul class="feed">${opens.map((o) => `<li><span>${fmt(o.ts)}<br><span class="muted">${esc(o.client || '')} · ${esc(o.device || '')}${o.country ? ' · ' + esc(o.country) : ''}</span></span></li>`).join('') || '<li class="muted">Not opened yet</li>'}</ul>
  <h2>Links</h2><ul class="feed">${e.links.map((l) => `<li><span style="word-break:break-all">${l.kind === 'button' ? '🔘 ' : ''}${esc(l.url)}</span><time>${l.click_count} click(s)</time></li>`).join('') || '<li class="muted">No tracked links</li>'}</ul>
  <h2>Reminder</h2><div class="row"><select id="rem" aria-label="Reminder"><option value="0">None</option><option value="24">Not opened in 1 day</option><option value="72">Not opened in 3 days</option><option value="r72">No reply in 3 days</option><option value="r168">No reply in 1 week</option></select><button class="fit" id="setrem">Set</button></div>
  <p style="margin-top:18px"><button class="secondary" id="cert">Download activity record (PDF)</button> <button class="danger" id="del">Delete tracking data</button></p>
  <p class="muted" style="font-size:12px">Gmail loads images through Google's proxy, so a Gmail open shows Google's servers rather than the reader's device or city. Apple Mail Privacy Protection can register an "open" without the person reading.</p>`;
  document.body.append(d); d.querySelector('.close').focus();
  d.querySelector('.close').onclick = () => { d.remove(); if (location.hash.startsWith('#email')) history.replaceState(null, '', '#emails'); };
  d.querySelector('#setrem').onclick = async () => { const v = d.querySelector('#rem').value; await api('PUT', `/api/emails/${id}`, { remind_hours: Number(v.replace('r', '')), remind_mode: v.startsWith('r') ? 'no_reply' : 'no_open' }); d.querySelector('#setrem').textContent = 'Saved ✓'; };
  d.querySelector('#cert').onclick = async () => downloadBlob(await api('GET', `/api/emails/${id}/certificate`), `openenvelope-record-${id}.pdf`);
  d.querySelector('#del').onclick = async () => { if (confirm('Delete all tracking data for this email?')) { await api('DELETE', `/api/emails/${id}`); d.remove(); route(); } };
}
function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

// ---------- Campaigns ----------
async function campaigns() {
  const [list, lists, me] = await Promise.all([api('GET', '/api/campaigns'), api('GET', '/api/lists'), api('GET', '/api/me')]);
  view.innerHTML = `<h1>Campaigns &amp; mail merge</h1>
  <section class="panel"><h2>New campaign</h2>
  <div class="row"><div><label for="c-name">Name</label><input id="c-name" placeholder="Internship outreach"></div><div><label for="c-via">Send through</label><select id="c-via">
    ${isExtension ? '<option value="gmail">My Gmail (Gmail API, from this browser)</option>' : ''}<option value="smtp" ${me.server.smtp ? '' : 'disabled'}>Server SMTP${me.server.smtp ? '' : ' (not configured)'}</option></select></div>
    <div><label for="c-when">Schedule (optional)</label><input id="c-when" type="datetime-local"></div></div>
  <label for="c-subject">Subject</label><input id="c-subject" style="width:100%" placeholder="Hi {{first_name}}, quick question">
  <label for="c-body">Body (HTML allowed; use {{column}} or {{column|fallback}})</label><textarea id="c-body" placeholder="<p>Hi {{first_name|there}},</p>"></textarea>
  <div class="row"><div><label for="c-csv">Recipients: CSV file</label><input id="c-csv" type="file" accept=".csv,text/csv"></div>
  <div><label for="c-sheet">…or Google Sheet link</label><input id="c-sheet" placeholder="https://docs.google.com/spreadsheets/d/…"></div>
  <div><label for="c-list">…or a contact list</label><select id="c-list"><option value="">—</option>${lists.map((l) => `<option>${esc(l.name)}</option>`).join('')}</select></div></div>
  <p class="muted" style="font-size:13px">Each recipient gets their own copy with their own tracking pixel, tracked links and an unsubscribe link. Unsubscribed contacts are skipped automatically. Gmail limits: about 500 recipients/day on a personal account, 2,000 on Workspace.</p>
  <p><button class="secondary" id="c-prev">Preview first email</button> <button id="c-create">Create campaign</button></p><div id="c-out"></div></section>
  <section class="panel"><h2>Your campaigns</h2><table><thead><tr><th>Name</th><th>Status</th><th>Recipients</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Bounced</th><th>Unsub.</th><th></th></tr></thead>
  <tbody>${list.map((c) => `<tr><td>${esc(c.name)}<br><span class="muted" style="font-size:12px">${c.send_via === 'gmail' ? 'Gmail API' : 'SMTP'}${c.schedule_at ? ' · ' + fmt(c.schedule_at) : ''}</span></td><td><span class="pill">${c.status}</span></td><td>${c.stats.total}</td><td>${c.stats.sent}</td><td>${c.stats.opened} (${pct(c.stats.opened, c.stats.sent)})</td><td>${c.stats.clicked}</td><td>${c.stats.bounced}</td><td>${c.stats.unsubscribed}</td>
   <td>${['ready', 'scheduled', 'sending'].includes(c.status) ? `<button class="small" data-send="${c.id}" data-via="${c.send_via}">Send now</button>` : ''} <button class="small secondary" data-view="${c.id}">Details</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">No campaigns yet</td></tr>'}</tbody></table></section>`;
  const out = view.querySelector('#c-out');
  const gather = async () => {
    const f = view.querySelector('#c-csv').files[0];
    const when = view.querySelector('#c-when').value;
    return { name: val('#c-name'), subject: val('#c-subject'), body: val('#c-body'), send_via: val('#c-via'), csv: f ? await f.text() : undefined,
      sheet_url: val('#c-sheet') || undefined, list: val('#c-list') || undefined, schedule_at: when ? new Date(when).toISOString() : undefined };
  };
  view.querySelector('#c-prev').onclick = async () => {
    const g = await gather();
    if (!g.csv) { out.innerHTML = '<p class="muted">Preview needs a CSV file.</p>'; return; }
    const p = await api('POST', '/api/campaigns/preview', g);
    out.innerHTML = `<div class="notice"><b>${p.count} rows</b> · columns: <span class="chips">${p.columns.map((c) => `<span>${esc(c)}</span>`).join('')}</span><hr><b>${esc(p.subject)}</b><div>${p.body}</div></div>`;
  };
  view.querySelector('#c-create').onclick = async () => {
    try { const r = await api('POST', '/api/campaigns', await gather()); out.innerHTML = `<p class="ok-msg">Created with ${r.recipients} recipients${r.skipped.length ? `; skipped ${r.skipped.length} (${esc(r.skipped.map((s) => s.to + ': ' + s.reason).join(', '))})` : ''}.</p>`; setTimeout(campaigns, 1500); }
    catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  view.onclick = async (e) => {
    const s = e.target.dataset.send, v = e.target.dataset.view;
    if (s) {
      e.target.disabled = true; e.target.textContent = 'Sending…';
      try {
        const r = e.target.dataset.via === 'gmail' ? await new Promise((res, rej) => chrome.runtime.sendMessage({ type: 'send-campaign', campaignId: s }, (x) => (x?.ok ? res(x.data) : rej(new Error(x?.error || 'failed')))))
          : await api('POST', `/api/campaigns/${s}/send`);
        alert(`Sent ${r.sent}, failed ${r.failed}${r.stopped ? '. ' + r.stopped : ''}`); campaigns();
      } catch (err) { alert(err.message); e.target.disabled = false; e.target.textContent = 'Send now'; }
    }
    if (v) {
      const c = await api('GET', `/api/campaigns/${v}`);
      document.querySelector('.drawer')?.remove();
      const d = document.createElement('aside'); d.className = 'drawer';
      d.innerHTML = `<button class="secondary small close">Close</button><h2>${esc(c.name)}</h2><table><thead><tr><th></th><th>Recipient</th><th>Status</th><th>Opens</th><th>Clicks</th></tr></thead><tbody>
        ${c.recipients.map((r) => `<tr><td>${tick(r)}</td><td>${esc(r.contact_email)}</td><td>${r.status}${r.send_error ? `<br><span class="err" style="font-size:12px">${esc(r.send_error)}</span>` : ''}</td><td>${r.open_count}</td><td>${r.click_count}</td></tr>`).join('')}</tbody></table>`;
      document.body.append(d); d.querySelector('.close').onclick = () => d.remove();
    }
  };
}
const val = (s) => view.querySelector(s)?.value?.trim() || '';

// ---------- Contacts ----------
async function contacts() {
  const list = await api('GET', '/api/contacts');
  view.innerHTML = `<h1>Contacts</h1><p class="muted">Built automatically from the people you email. Add notes and lists (lists can be used as campaign audiences).</p>
  <section class="panel"><table><thead><tr><th>Email</th><th>Name</th><th>Opens</th><th>Clicks</th><th>Last activity</th><th>Lists</th><th>Notes</th><th>Privacy</th></tr></thead><tbody>
  ${list.map((c) => `<tr data-email="${esc(c.email)}"><td>${esc(c.email)}${c.unsubscribed ? ' <span class="pill">unsubscribed</span>' : ''}${c.bounced ? ' <span class="pill">bounced</span>' : ''}</td>
    <td><input data-f="name" value="${esc(c.name || '')}" aria-label="Name" size="12"></td><td>${c.opens}</td><td>${c.clicks}</td><td>${timeAgo(c.last_activity_at)}</td>
    <td><input data-f="lists" value="${esc(c.lists.join(', '))}" aria-label="Lists" size="12"></td><td><input data-f="notes" value="${esc(c.notes || '')}" aria-label="Notes"></td>
    <td><label class="muted" style="font-weight:400;margin:0"><input type="checkbox" data-f="do_not_track" ${c.do_not_track ? 'checked' : ''}> don't track</label>
    <button class="small secondary" data-export>Export</button> <button class="small danger" data-erase>Erase</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No contacts yet</td></tr>'}</tbody></table></section>`;
  view.onchange = async (e) => {
    const tr = e.target.closest('tr[data-email]'); const f = e.target.dataset.f; if (!tr || !f) return;
    const v = f === 'lists' ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : f === 'do_not_track' ? e.target.checked : e.target.value;
    await api('PUT', `/api/contacts/${encodeURIComponent(tr.dataset.email)}`, { [f]: v });
  };
  view.onclick = async (e) => {
    const tr = e.target.closest('tr[data-email]'); if (!tr) return;
    if (e.target.hasAttribute('data-export')) downloadBlob(new Blob([JSON.stringify(await api('GET', `/api/contacts/${encodeURIComponent(tr.dataset.email)}/export`), null, 2)], { type: 'application/json' }), `${tr.dataset.email}.json`);
    if (e.target.hasAttribute('data-erase') && confirm(`Erase all tracking data about ${tr.dataset.email}?`)) { await api('DELETE', `/api/contacts/${encodeURIComponent(tr.dataset.email)}`); contacts(); }
  };
}

// ---------- Documents & video ----------
async function documents() {
  const list = await api('GET', '/api/documents');
  view.innerHTML = `<h1>Documents &amp; video messages</h1>
  <section class="panel"><h2>Share a tracked PDF or video</h2><div class="row"><div><label for="d-file">File (PDF, MP4, WebM)</label><input id="d-file" type="file" accept="application/pdf,video/mp4,video/webm"></div>
  <div><label for="d-pw">Password (optional)</label><input id="d-pw" type="text" autocomplete="off"></div><div><label for="d-exp">Expires after (days)</label><input id="d-exp" type="number" min="1" placeholder="never"></div>
  <div><label for="d-wm">Watermark</label><input id="d-wm" placeholder="Confidential – {viewer}"></div></div>
  <p><label style="display:inline;font-weight:400"><input type="checkbox" id="d-dl"> allow download</label></p>
  <p><button id="d-up">Upload</button> <button class="secondary" id="rec">🎥 Record a video message</button></p><div id="d-out"></div><video id="preview" hidden muted playsinline style="max-width:360px;border-radius:10px"></video></section>
  <section class="panel"><h2>Shared files</h2><table><thead><tr><th>Name</th><th>Views</th><th>Time spent</th><th>Protection</th><th>Link</th><th></th></tr></thead><tbody>
  ${list.map((d) => `<tr><td>${d.kind === 'video' ? '🎬' : '📄'} ${esc(d.name)}</td><td>${d.views}</td><td>${d.total_seconds}s</td><td>${d.password_protected ? '🔒 password ' : ''}${d.expires_at ? (d.expires_at < Date.now() ? 'expired' : 'expires ' + fmt(d.expires_at)) : ''}${d.watermark ? ' · watermark' : ''}</td>
  <td><button class="small secondary" data-copy="${esc(d.share_url)}">Copy link</button></td><td><button class="small secondary" data-stats="${d.id}">Per-page</button> <button class="small danger" data-revoke="${d.id}">Revoke</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing shared yet</td></tr>'}</tbody></table></section>`;
  const out = view.querySelector('#d-out');
  const upload = async (blob, name, type) => {
    const q = new URLSearchParams({ name, ...(val('#d-pw') && { password: val('#d-pw') }), ...(val('#d-exp') && { expires_days: val('#d-exp') }), ...(val('#d-wm') && { watermark: val('#d-wm') }), allow_download: String(view.querySelector('#d-dl').checked) });
    const r = await api('POST', `/api/documents?${q}`, blob, { raw: true, contentType: type });
    out.innerHTML = `<p class="ok-msg">Shared ✓ <a href="${esc(r.share_url)}" target="_blank" rel="noopener">${esc(r.share_url)}</a> — paste it into an email (add <code>?r=their@email</code> to know who viewed).</p>`;
    setTimeout(documents, 2500);
  };
  view.querySelector('#d-up').onclick = async () => { const f = view.querySelector('#d-file').files[0]; if (!f) return; try { await upload(f, f.name, f.type); } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; } };
  let rec;
  view.querySelector('#rec').onclick = async (e) => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const pv = view.querySelector('#preview'); pv.hidden = false; pv.srcObject = stream; pv.play();
      const chunks = []; rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      rec.ondataavailable = (x) => chunks.push(x.data);
      rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); rec = null; await upload(new Blob(chunks, { type: 'video/webm' }), `Video message ${new Date().toLocaleDateString()}.webm`, 'video/webm'); };
      rec.start(); e.target.textContent = '⏹ Stop and share';
    } catch (err) { out.innerHTML = `<p class="err">Camera unavailable: ${esc(err.message)}</p>`; }
  };
  view.onclick = async (e) => {
    const t = e.target.dataset;
    if (t.copy) { await navigator.clipboard.writeText(t.copy); e.target.textContent = 'Copied ✓'; }
    if (t.revoke && confirm('Revoke access to this file now?')) { await api('PUT', `/api/documents/${t.revoke}`, { revoke: true }); documents(); }
    if (t.stats) {
      const d = await api('GET', `/api/documents/${t.stats}`);
      const max = Math.max(1, ...Object.values(d.seconds_per_page));
      out.innerHTML = `<div class="notice"><b>${esc(d.name)}</b> — time per ${d.kind === 'video' ? 'video' : 'page'}<br>${Object.entries(d.seconds_per_page).map(([p, s]) => `<div style="display:flex;gap:8px;align-items:center;margin:4px 0"><span style="width:70px">${p === 'video' ? 'video' : 'Page ' + p}</span><div class="bar" style="flex:1"><i style="width:${(100 * s) / max}%"></i></div><span>${Math.round(s)}s</span></div>`).join('') || 'No reading time recorded yet'}
        <br>${d.view_sessions.map((v) => `${esc(v.viewer || 'anonymous')} · ${fmt(v.started_at)} · ${Math.round(v.total_seconds)}s`).join('<br>')}</div>`;
    }
  };
}

// ---------- Signatures ----------
async function signatures() {
  const [reqs, docs] = await Promise.all([api('GET', '/api/sign-requests'), api('GET', '/api/documents')]);
  const pdfs = docs.filter((d) => d.kind === 'pdf');
  view.innerHTML = `<h1>Signature requests</h1>
  <section class="panel"><h2>Request a signature</h2>${pdfs.length ? `<div class="row"><div><label for="s-doc">PDF</label><select id="s-doc">${pdfs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
  <div><label for="s-name">Signer name</label><input id="s-name"></div><div><label for="s-email">Signer email</label><input id="s-email" type="email"></div><button class="fit" id="s-go">Create link</button></div><div id="s-out"></div>`
    : '<p class="muted">Upload a PDF under Documents first.</p>'}</section>
  <section class="panel"><table><thead><tr><th>Document</th><th>Signer</th><th>Status</th><th>Viewed</th><th>Signed</th><th></th></tr></thead><tbody>
  ${reqs.map((r) => `<tr><td>${esc(r.doc_name)}</td><td>${esc(r.signer_name || '')} ${esc(r.signer_email || '')}</td><td><span class="pill ${r.status === 'signed' ? 'ok' : ''}">${r.status}</span></td><td>${timeAgo(r.viewed_at) || '—'}</td><td>${fmt(r.signed_at)}</td>
  <td>${r.status === 'signed' ? `<button class="small" data-dl="${r.id}">Signed PDF</button>` : `<button class="small secondary" data-copy="${esc(r.sign_url)}">Copy link</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No requests yet</td></tr>'}</tbody></table></section>`;
  view.querySelector('#s-go')?.addEventListener('click', async () => {
    const r = await api('POST', '/api/sign-requests', { document_id: val('#s-doc'), signer_name: val('#s-name'), signer_email: val('#s-email') });
    view.querySelector('#s-out').innerHTML = `<p class="ok-msg">Send this link to the signer: <a href="${esc(r.sign_url)}" target="_blank" rel="noopener">${esc(r.sign_url)}</a></p>`;
  });
  view.onclick = async (e) => {
    if (e.target.dataset.copy) { await navigator.clipboard.writeText(e.target.dataset.copy); e.target.textContent = 'Copied ✓'; }
    if (e.target.dataset.dl) downloadBlob(await api('GET', `/api/sign-requests/${e.target.dataset.dl}/signed.pdf`), 'signed.pdf');
  };
}

// ---------- Polls ----------
async function polls() {
  const list = await api('GET', '/api/polls');
  view.innerHTML = `<h1>Polls</h1><p class="muted">Insert a poll from the ▾ menu in any Gmail compose window. Results land here.</p>
  ${list.map((p) => { const total = p.options.reduce((a, o) => a + o.votes, 0); return `<section class="panel"><h2>${esc(p.question)}</h2>${p.options.map((o) => `<div style="display:flex;gap:8px;align-items:center;margin:6px 0"><span style="width:140px">${esc(o.option)}</span><div class="bar" style="flex:1"><i style="width:${total ? (100 * o.votes) / total : 0}%"></i></div><span>${o.votes}</span></div>`).join('')}<p class="muted" style="font-size:13px">${total} vote(s) · created ${fmt(p.created_at)}</p></section>`; }).join('') || '<section class="panel muted">No polls yet</section>'}`;
}

// ---------- Templates ----------
async function templates() {
  const list = await api('GET', '/api/templates');
  view.innerHTML = `<h1>Templates</h1><section class="panel"><h2>New template</h2><label for="t-name">Name</label><input id="t-name" style="width:100%"><label for="t-subj">Subject</label><input id="t-subj" style="width:100%">
  <label for="t-body">Body (HTML)</label><textarea id="t-body"></textarea><p><button id="t-save">Save template</button></p></section>
  <section class="panel"><ul class="feed">${list.map((t) => `<li><span><b>${esc(t.name)}</b><br><span class="muted">${esc(t.subject)}</span></span><button class="small danger" data-del="${t.id}">Delete</button></li>`).join('') || '<li class="muted">No templates yet. Insert them from the ▾ menu in Gmail compose.</li>'}</ul></section>`;
  view.querySelector('#t-save').onclick = async () => { await api('POST', '/api/templates', { name: val('#t-name'), subject: val('#t-subj'), body: view.querySelector('#t-body').value }); templates(); };
  view.onclick = async (e) => { if (e.target.dataset.del) { await api('DELETE', `/api/templates/${e.target.dataset.del}`); templates(); } };
}

// ---------- Attachments (extension only, Gmail API) ----------
async function attachments() {
  if (!isExtension) { view.innerHTML = '<h1>Attachments</h1><p>Available in the Chrome extension (reads your Gmail through the Gmail API).</p>'; return; }
  const favs = (await chrome.storage.local.get({ favAttachments: [] })).favAttachments;
  view.innerHTML = `<h1>Attachments</h1><p class="muted">Every attachment in your Gmail in one list. ★ to keep favourites at the top. Needs the Gmail API client id (see README).</p><section class="panel" id="att"><p class="muted">Loading from Gmail…</p></section>`;
  chrome.runtime.sendMessage({ type: 'attachments' }, (r) => {
    const box = view.querySelector('#att'); if (!box) return;
    if (!r?.ok) { box.innerHTML = `<p class="err">${esc(r?.error || 'Gmail API unavailable')}</p>`; return; }
    const key = (a) => a.message_id + '/' + a.filename;
    const items = r.data.attachments.sort((a, b) => favs.includes(key(b)) - favs.includes(key(a)));
    box.innerHTML = `<table><thead><tr><th></th><th>File</th><th>From</th><th>Subject</th><th>Date</th></tr></thead><tbody>${items.map((a) => `<tr><td><button class="small secondary" data-fav="${esc(key(a))}" aria-label="Favourite">${favs.includes(key(a)) ? '★' : '☆'}</button></td><td><a href="https://mail.google.com/mail/u/0/#all/${a.thread_id}" target="_blank" rel="noopener">${esc(a.filename)}</a> <span class="muted">${Math.round((a.size || 0) / 1024)} KB</span></td><td>${esc(a.from)}</td><td>${esc(a.subject)}</td><td>${fmt(a.date)}</td></tr>`).join('')}</tbody></table>`;
    box.onclick = async (e) => { const k = e.target.dataset.fav; if (!k) return; const i = favs.indexOf(k); i >= 0 ? favs.splice(i, 1) : favs.push(k); await chrome.storage.local.set({ favAttachments: favs }); attachments(); };
  });
}

// ---------- Settings ----------
async function settings() {
  const c = await getConfig();
  let me = null, err = '';
  if (c.serverUrl && c.apiKey) { try { me = await api('GET', '/api/me'); } catch (e) { err = e.message; } }
  const s = me?.settings || {};
  view.innerHTML = `<h1>Settings</h1>
  <section class="panel"><h2>Server</h2><p class="muted">OpenEnvelope talks only to the server you run. Create a key with <code>npm run create-user -- you@gmail.com</code>.</p>
  <div class="row"><div><label for="srv">Server URL</label><input id="srv" value="${esc(c.serverUrl)}" placeholder="https://openenvelope-yourname.onrender.com"></div><div><label for="key">API key</label><input id="key" type="password" value="${esc(c.apiKey)}" autocomplete="off"></div><button class="fit" id="save-conn">Save &amp; test</button></div>
  <p id="conn">${me ? `<span class="ok-msg">Connected as ${esc(me.email)}</span>` : err ? `<span class="err">${esc(err)}</span>` : ''}</p></section>
  ${me ? `<section class="panel"><h2>Tracking</h2>
    <label><input type="checkbox" data-k="track_by_default" ${s.track_by_default ? 'checked' : ''}> Track every new email by default</label>
    <label><input type="checkbox" data-k="track_links" ${s.track_links ? 'checked' : ''}> Track link clicks</label>
    <label><input type="checkbox" data-k="ignore_gmail_prefetch" ${s.ignore_gmail_prefetch !== false ? 'checked' : ''}> Ignore Gmail's automatic image fetch at delivery (it is not a real open)</label>
    <div class="row"><div><label for="grace">Ignore opens in the first N seconds after sending (your own preview)</label><input id="grace" type="number" min="0" data-k="self_open_grace_sec" value="${s.self_open_grace_sec}"></div>
    <div><label for="rem">Default "not opened" reminder (hours, 0 = off)</label><input id="rem" type="number" min="0" data-k="default_reminder_hours" value="${s.default_reminder_hours}"></div>
    <div><label for="ipm">Store visitor IPs as</label><select id="ipm" data-k="ip_mode">${[['', `Server default (${me.server.ip_mode})`], ['hash', 'Salted hash'], ['none', "Don't store"], ['full', 'Full IP']].map(([v, l]) => `<option value="${v}" ${(s.ip_mode || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <div class="row"><div><label for="bcc">CRM auto-BCC address</label><input id="bcc" data-k="auto_bcc" value="${esc(s.auto_bcc)}" placeholder="dropbox@yourcrm.com"></div><div><label for="wh">Webhook URL (Zapier / Make / n8n)</label><input id="wh" data-k="webhook_url" value="${esc(s.webhook_url)}" placeholder="https://hooks.zapier.com/…"></div></div></section>
  <section class="panel"><h2>Alerts</h2>
    <label><input type="checkbox" data-a="opens" ${s.alerts.opens ? 'checked' : ''}> Opens</label><label><input type="checkbox" data-a="clicks" ${s.alerts.clicks ? 'checked' : ''}> Link clicks</label><label><input type="checkbox" data-a="documents" ${s.alerts.documents ? 'checked' : ''}> Document &amp; video views</label>
    <label><input type="checkbox" data-k="alert_email" ${s.alert_email ? 'checked' : ''} ${me.server.smtp ? '' : 'disabled'}> Also email me each alert ${me.server.smtp ? '' : '(needs SMTP on the server)'}</label>
    <div class="row"><div><label for="hot">Hot conversation: opens</label><input id="hot" type="number" min="0" data-a="hot_threshold" value="${s.alerts.hot_threshold}"></div><div><label for="hotw">…within minutes</label><input id="hotw" type="number" min="1" data-a="hot_window_min" value="${s.alerts.hot_window_min}"></div>
    <div><label for="rev">Old conversation revival after (days)</label><input id="rev" type="number" min="0" data-a="revival_days" value="${s.alerts.revival_days}"></div></div>
    <div class="row"><div><label for="dom">Only alert for these recipient domains (comma-separated, empty = all)</label><input id="dom" data-a="only_domains" value="${esc(s.alerts.only_domains.join(', '))}"></div><div><label for="mute">Mute these contacts</label><input id="mute" data-a="mute_contacts" value="${esc(s.alerts.mute_contacts.join(', '))}"></div></div></section>
  <section class="panel"><h2>Activity report</h2><div class="row"><div><label for="dg">Frequency</label><select id="dg" data-k="digest_frequency">${['off', 'daily', 'weekly', 'monthly'].map((f) => `<option ${s.digest_frequency === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
    <div><label for="dh">Hour</label><input id="dh" type="number" min="0" max="23" data-k="digest_hour" value="${s.digest_hour}"></div><div><label for="tz">Time zone</label><input id="tz" data-k="timezone" value="${esc(s.timezone)}"></div>
    <div><label for="de">Send to</label><input id="de" data-k="digest_email" value="${esc(s.digest_email)}" placeholder="${esc(me.email)}"></div><button class="fit secondary" id="prev">Preview</button></div><div id="digest"></div></section>
  <p><button id="save">Save settings</button> <span id="saved"></span></p>` : ''}`;
  view.querySelector('#save-conn').onclick = async () => {
    const serverUrl = val('#srv').replace(/\/$/, ''), apiKey = val('#key');
    if (isExtension && serverUrl && !/^https:\/\/mail\.google\.com/.test(serverUrl)) { try { await chrome.permissions.request({ origins: [new URL(serverUrl).origin + '/*'] }); } catch {} }
    await setConfig({ serverUrl, apiKey }); settings();
  };
  if (!me) return;
  view.querySelector('#prev').onclick = async () => { view.querySelector('#digest').innerHTML = `<div class="notice">${(await api('GET', `/api/digest/preview?period=${val('#dg') === 'off' ? 'daily' : val('#dg')}`)).html}</div>`; };
  view.querySelector('#save').onclick = async () => {
    const body = { alerts: {} };
    view.querySelectorAll('[data-k]').forEach((el) => { body[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value || (el.dataset.k === 'ip_mode' ? null : ''); });
    view.querySelectorAll('[data-a]').forEach((el) => { const k = el.dataset.a; body.alerts[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.split(',').map((x) => x.trim()).filter(Boolean); });
    try { await api('PUT', '/api/settings', body); view.querySelector('#saved').innerHTML = '<span class="ok-msg">Saved ✓</span>'; } catch (e) { view.querySelector('#saved').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };
}
