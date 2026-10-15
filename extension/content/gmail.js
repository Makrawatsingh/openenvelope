/* OpenEnvelope Gmail content script (plain DOM, no third-party SDK).
 * Gmail's DOM is undocumented and changes; every selector lives in SEL below so it is easy to fix.
 *  1. Strips OpenEnvelope pixels from emails *you* view, and tells the server "that was me".
 *  2. Adds a ✓✓ tracking toggle + extras menu to each compose window.
 *  3. On Send: registers the email, rewrites links to tracked redirects, inserts the pixel, then lets Gmail send.
 *  4. Shows ✓ (sent) / ✓✓ (opened) marks in the mail list and an open-history banner in threads.
 */
(() => {
  const SEL = {
    composeBody: 'div[contenteditable="true"][role="textbox"], div[contenteditable="true"][g_editable="true"]',
    sendButton: 'div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"], div[role="button"].T-I.aoO',
    moreSendOptions: 'div[role="button"][aria-label="More send options"], div[role="button"].T-I.hG',
    subject: 'input[name="subjectbox"]',
    // Recipients (To/Cc/Bcc). Gmail has changed this markup several times, so recipients() combines
    // several strategies: chip attributes, hidden/visible inputs, chip aria-labels/tooltips, then a
    // regex over the recipients row text as a last resort.
    recipientAttr: '[email], [data-hovercard-id*="@"], [data-email]',
    recipientInput: 'input[name="to"], input[name="cc"], input[name="bcc"], textarea[name="to"], textarea[name="cc"], textarea[name="bcc"], input[aria-label*="recipient" i], input[peoplekit-id], input[aria-label="To"], input[aria-label="Cc"], input[aria-label="Bcc"]',
    recipientChip: '[role="option"], [role="listitem"], [data-name], [data-tooltip*="@"], [aria-label*="@"], [title*="@"]',
    fromField: 'input[name="from"], select[name="from"], [name="from"]',
    bccField: 'textarea[name="bcc"], input[aria-label^="BCC" i], input[aria-label^="Bcc"]',
    listRow: 'tr.zA',
    rowSubject: '.bog, .y6 span',
    messageBody: 'div.a3s',
  };
  const state = { config: null, settings: null, emails: [], bySubject: new Map(), byId: new Map(), pass: false };
  const PIXEL_RE = /\/t\/([A-Za-z0-9_-]{8,32})\.gif/;

  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message })); }
    catch (e) { res({ ok: false, error: String(e) }); }
  });
  const apiCall = async (method, path, body) => { const r = await send({ type: 'api', method, path, body }); if (!r.ok) throw new Error(r.error); return r.data; };

  // ---------- 1. Sender self-open protection (runs from document_start) ----------
  function serverOrigin() { try { return new URL(state.config.serverUrl).origin; } catch { return null; } }
  function checkImg(img) {
    if (!state.config?.serverUrl || img.dataset.tkChecked === img.src) return;
    if (img.closest(SEL.composeBody)) return; // our own pixel inside a compose window being written
    const origin = serverOrigin();
    const src = img.getAttribute('src') || '';
    // Gmail rewrites external images to https://ciN.googleusercontent.com/...#<original url>
    const original = src.includes('#') ? decodeURIComponent(src.slice(src.indexOf('#') + 1)) : src;
    if (!origin || !original.startsWith(origin)) { img.dataset.tkChecked = src; return; }
    const m = original.match(PIXEL_RE);
    if (!m) return;
    img.removeAttribute('src'); img.removeAttribute('srcset');
    img.dataset.tkChecked = ''; img.dataset.openenvelopeId = m[1];
    apiCall('POST', `/api/emails/${m[1]}/self-view`, { seconds: 30 }).catch(() => {});
    showThreadBanner(img, m[1]);
  }
  const imgObserver = new MutationObserver((muts) => {
    for (const mu of muts) {
      if (mu.type === 'attributes' && mu.target.tagName === 'IMG') checkImg(mu.target);
      for (const n of mu.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') checkImg(n); else n.querySelectorAll?.('img').forEach(checkImg);
      }
    }
    scheduleScan();
  });
  imgObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  // ---------- 2. Compose windows ----------
  function findComposeRoot(body) {
    let el = body;
    for (let i = 0; i < 25 && el; i++, el = el.parentElement) if (el.querySelector?.(SEL.sendButton)) return el;
    return null;
  }

  async function setupCompose(body) {
    if (body.dataset.openenvelope) return;
    const root = findComposeRoot(body);
    if (!root) return;
    body.dataset.openenvelope = '1';
    const sendBtn = root.querySelector(SEL.sendButton);
    const ctl = { root, body, sendBtn, tracking: state.settings?.track_by_default !== false, id: null, remindHours: Number(state.settings?.default_reminder_hours || 0), remindMode: 'no_open', prepared: false };
    composes.set(body, ctl);
    const bar = document.createElement('div');
    bar.className = 'openenvelope-bar';
    bar.innerHTML = `<button type="button" class="tk-toggle" aria-pressed="true" title="OpenEnvelope tracking">✓✓ <span>Tracking</span></button><button type="button" class="tk-more" aria-label="OpenEnvelope options" title="Reminders, templates, polls, buttons, documents">▾</button>`;
    sendBtn.parentElement?.insertAdjacentElement('afterend', bar);
    const tg = bar.querySelector('.tk-toggle');
    const paint = () => {
      tg.classList.toggle('off', !ctl.tracking); tg.classList.toggle('waking', !!(ctl.tracking && ctl.waking));
      tg.setAttribute('aria-pressed', String(ctl.tracking));
      tg.querySelector('span').textContent = !ctl.tracking ? 'Not tracked' : ctl.waking ? 'Waking your server…' : 'Tracking';
      tg.title = ctl.waking ? 'OpenEnvelope: your server is starting up (free servers sleep when idle). Tracking will work once it answers.' : 'OpenEnvelope tracking';
    };
    ctl.paint = paint;
    tg.addEventListener('click', () => { ctl.tracking = !ctl.tracking; if (!ctl.tracking) ctl.cancelWait?.(); paint(); if (ctl.tracking) reserve(ctl); });
    bar.querySelector('.tk-more').addEventListener('click', (e) => openMenu(e.currentTarget, ctl));
    paint();
    if (ctl.tracking) reserve(ctl);
  }
  const composes = new Map();

  // Reserve a tracking id for this compose window. A free-tier server (e.g. Render) can take 30-60 s to
  // wake up, so the toggle shows "Waking your server…" while the call is pending, and send time retries.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  function reserve(ctl, timeoutMs = 60_000) {
    if (ctl.id || !state.config?.configured) return Promise.resolve(ctl.id);
    if (ctl.reserving) return ctl.reserving;
    const slow = setTimeout(() => { ctl.waking = true; ctl.paint?.(); }, 1500);
    ctl.reserving = withTimeout(apiCall('POST', '/api/emails/reserve'), timeoutMs)
      .then((r) => { ctl.id = r.id; return ctl.id; })
      .catch(() => null) // server unreachable: retried at send time
      .finally(() => { clearTimeout(slow); ctl.reserving = null; ctl.waking = false; ctl.paint?.(); });
    return ctl.reserving;
  }

  function openMenu(anchor, ctl) {
    document.querySelector('.openenvelope-menu')?.remove();
    const m = document.createElement('div');
    m.className = 'openenvelope-menu'; m.setAttribute('role', 'menu');
    m.innerHTML = `
      <div class="tk-h">Remind me if…</div>
      <label><select class="tk-remind">
        <option value="0">No reminder</option><option value="24">not opened in 1 day</option><option value="72">not opened in 3 days</option><option value="168">not opened in 1 week</option>
        <option value="r72">no reply in 3 days</option><option value="r168">no reply in 1 week</option></select></label>
      <button type="button" data-a="template">Insert template…</button>
      <button type="button" data-a="poll">Insert poll…</button>
      <button type="button" data-a="button">Insert tracked button…</button>
      <button type="button" data-a="doc">Insert tracked document link…</button>`;
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, innerWidth - 260) + 'px'; m.style.top = Math.max(8, r.top - m.offsetHeight - 6) + 'px';
    const sel = m.querySelector('.tk-remind');
    sel.value = ctl.remindMode === 'no_reply' ? 'r' + ctl.remindHours : String(ctl.remindHours);
    sel.addEventListener('change', () => { const v = sel.value; ctl.remindMode = v.startsWith('r') ? 'no_reply' : 'no_open'; ctl.remindHours = Number(v.replace('r', '')); });
    m.addEventListener('click', async (e) => {
      const a = e.target.dataset?.a; if (!a) return;
      m.remove();
      try {
        if (a === 'template') {
          const list = await apiCall('GET', '/api/templates');
          if (!list.length) return alert('No templates yet — create them in the OpenEnvelope dashboard.');
          const pick = prompt('Template number:\n' + list.map((t, i) => `${i + 1}. ${t.name}`).join('\n'));
          const t = list[Number(pick) - 1]; if (!t) return;
          const subj = ctl.root.querySelector(SEL.subject);
          if (subj && !subj.value && t.subject) { subj.value = t.subject; subj.dispatchEvent(new Event('input', { bubbles: true })); }
          insertHtml(ctl.body, t.body);
        } else if (a === 'poll') {
          const q = prompt('Poll question'); if (!q) return;
          const opts = (prompt('Options, separated by commas', 'Yes, No') || '').split(',').map((s) => s.trim()).filter(Boolean);
          if (opts.length < 2) return;
          insertHtml(ctl.body, (await apiCall('POST', '/api/polls', { question: q, options: opts })).html);
        } else if (a === 'button') {
          const label = prompt('Button text', 'Book a call'); const url = label && prompt('Button link (https://…)');
          if (!url) return;
          insertHtml(ctl.body, `<a href="${url.replace(/"/g, '')}" data-openenvelope-button="1" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1a73e8;color:#fff;text-decoration:none;font-weight:600">${label.replace(/</g, '&lt;')}</a>`);
        } else if (a === 'doc') {
          const docs = await apiCall('GET', '/api/documents');
          if (!docs.length) return alert('Upload a PDF or video in the OpenEnvelope dashboard first.');
          const pick = prompt('Document number:\n' + docs.map((d, i) => `${i + 1}. ${d.name}`).join('\n'));
          const d = docs[Number(pick) - 1]; if (!d) return;
          const who = [...recipients(ctl.root)][0] || '';
          insertHtml(ctl.body, `<a href="${d.share_url}${who ? '?r=' + encodeURIComponent(who) : ''}">📎 ${d.name.replace(/</g, '&lt;')}</a>`);
        }
      } catch (err) { alert('OpenEnvelope: ' + err.message); }
    });
    setTimeout(() => document.addEventListener('click', function close(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', close, true); } }, true), 0);
  }

  function insertHtml(body, html) {
    body.focus();
    const ok = document.execCommand('insertHTML', false, html);
    if (!ok) body.insertAdjacentHTML('beforeend', html);
  }

  const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const emailsIn = (s) => String(s || '').match(EMAIL_RE) || [];

  // The signed-in account's own address(es), so they are never counted as recipients.
  function senderAddresses(root) {
    const me = new Set(emailsIn(document.title).map((e) => e.toLowerCase()));
    document.querySelectorAll('a[aria-label*="@"][href*="accounts.google.com"], a[aria-label^="Google Account"]').forEach((a) => emailsIn(a.getAttribute('aria-label')).forEach((e) => me.add(e.toLowerCase())));
    root?.querySelectorAll(SEL.fromField).forEach((f) => emailsIn(f.value || f.textContent).forEach((e) => me.add(e.toLowerCase())));
    return me;
  }

  // The part of the compose window holding To/Cc/Bcc: climb from a recipient field until the next
  // step up would also contain the subject line or the message body.
  function recipientArea(root) {
    const subj = root.querySelector(SEL.subject);
    const body = root.querySelector(SEL.composeBody);
    const seeds = root.querySelectorAll(`${SEL.recipientInput}, ${SEL.recipientAttr}`);
    const areas = new Set();
    seeds.forEach((seed) => {
      if (body && body.contains(seed)) return;
      let el = seed;
      while (el.parentElement && el.parentElement !== root && !(subj && el.parentElement.contains(subj)) && !(body && el.parentElement.contains(body))) el = el.parentElement;
      areas.add(el);
    });
    if (!areas.size && subj) {
      // Unknown markup: use the rows that come before the subject line (From/To/Cc/Bcc).
      let el = subj;
      while (el.parentElement && el.parentElement !== root && !(body && el.parentElement.contains(body))) el = el.parentElement;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (!(body && s.contains(body))) areas.add(s);
      if (el !== subj && !el.contains(body)) areas.add(el);
    }
    return [...areas];
  }

  function recipients(root) {
    const found = new Set();
    const body = root.querySelector(SEL.composeBody);
    const inBody = (el) => !!(el.closest(SEL.composeBody) || (body && body.contains(el)) || el.closest('.openenvelope-bar, .openenvelope-menu'));
    const add = (s) => emailsIn(s).forEach((e) => found.add(e.toLowerCase().replace(/^[.'-]+|[.'-]+$/g, '')));
    // 1. chip attributes (classic Gmail)
    root.querySelectorAll(SEL.recipientAttr).forEach((el) => { if (!inBody(el) && !el.closest(SEL.fromField)) add([el.getAttribute('email'), el.getAttribute('data-hovercard-id'), el.getAttribute('data-email')].join(' ')); });
    // 2. inputs: hidden "to/cc/bcc" inputs and text typed into a recipient box but not yet turned into a chip
    root.querySelectorAll(SEL.recipientInput).forEach((el) => { if (!inBody(el)) add(el.value); });
    const areas = recipientArea(root);
    for (const area of areas) {
      // 3. chip aria-label / tooltip / title, e.g. aria-label="Asha Verma <asha@college.edu>"
      area.querySelectorAll(SEL.recipientChip).forEach((el) => { if (!inBody(el)) add([el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.getAttribute('title'), el.getAttribute('data-name')].join(' ')); });
    }
    // 4. last resort: any address written in the recipients row text
    if (!found.size) for (const area of areas) if (!inBody(area)) add(area.textContent);
    for (const me of senderAddresses(root)) found.delete(me);
    return found;
  }

  // ---------- 3. Intercept Send ----------
  async function prepareAndSend(ctl, clickAfter) {
    if (ctl.busy) return; ctl.busy = true;
    try {
      if (ctl.tracking && !ctl.prepared) {
        // The reserve made when the compose opened may have failed (sleeping server) or still be pending.
        if (!ctl.id) {
          ctl.waking = true; paintSending(ctl, true);
          // Wait up to 45 s; turning the toggle off while waiting sends right away, untracked.
          await Promise.race([reserve(ctl, 45_000), new Promise((r) => setTimeout(r, 45_000)), new Promise((r) => { ctl.cancelWait = r; })]);
          ctl.cancelWait = null;
        }
        if (ctl.tracking && !ctl.id) throw new Error('reserve failed');
        if (ctl.tracking) {
          const anchors = [...ctl.body.querySelectorAll('a[href]')].filter((a) => /^https?:/i.test(a.href) && !a.href.startsWith(state.config.serverUrl));
          const btns = anchors.filter((a) => a.dataset.openenvelopeButton);
          const links = anchors.filter((a) => !a.dataset.openenvelopeButton);
          const subject = ctl.root.querySelector(SEL.subject)?.value || document.title.replace(/ - .*$/, '');
          const trackLinks = state.settings?.track_links !== false;
          const res = await withTimeout(
            apiCall('POST', `/api/emails/${ctl.id}/prepare`, { subject, recipients: [...recipients(ctl.root)], urls: trackLinks ? links.map((a) => a.href) : [],
              buttons: btns.map((a) => a.href), remind_hours: ctl.remindHours, remind_mode: ctl.remindMode }), 10_000);
          if (trackLinks) res.links.forEach((l, i) => { if (!l.skipped) links[i].href = l.tracked_url; });
          res.buttons.forEach((l, i) => { if (!l.skipped) btns[i].href = l.tracked_url; });
          const img = document.createElement('img');
          img.src = res.pixel_url; img.width = 1; img.height = 1; img.alt = '';
          img.style.cssText = 'display:block;width:1px;height:1px;border:0';
          ctl.body.appendChild(img);
          ctl.body.dispatchEvent(new Event('input', { bubbles: true }));
          if (state.settings?.auto_bcc) addBcc(ctl.root, state.settings.auto_bcc);
          ctl.prepared = true;
        }
      }
    } catch (e) {
      toast('OpenEnvelope could not reach your server, so this email went out untracked. If your server is on a free plan it may be asleep; open Settings → Save & test to wake it.', 10_000);
    } finally { ctl.busy = false; paintSending(ctl, false); }
    if (clickAfter) clickSend(ctl);
  }

  function paintSending(ctl, on) {
    if (!on) ctl.waking = false;
    ctl.paint?.();
  }

  function addBcc(root, addr) {
    const f = root.querySelector(SEL.bccField);
    if (!f) return; // Bcc field hidden: best effort only (see README)
    f.value = (f.value ? f.value + ', ' : '') + addr; f.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function clickSend(ctl) {
    state.pass = true;
    const b = ctl.root.querySelector(SEL.sendButton) || ctl.sendBtn;
    for (const t of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    setTimeout(() => { state.pass = false; }, 50);
  }

  const ctlFor = (el) => { for (const [, c] of composes) if (c.root.contains(el)) return c; return null; };

  for (const type of ['mousedown', 'mouseup', 'click']) {
    window.addEventListener(type, (e) => {
      if (state.pass) return;
      const btn = e.target.closest?.(SEL.sendButton);
      if (btn) {
        const ctl = ctlFor(btn);
        if (!ctl || !ctl.tracking || ctl.prepared) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (type === 'click') prepareAndSend(ctl, true);
        return;
      }
      // Gmail "Schedule send": pre-instrument the email as soon as the send-options menu is opened.
      const more = e.target.closest?.(SEL.moreSendOptions);
      if (more && type === 'mousedown') { const ctl = ctlFor(more); if (ctl?.tracking && !ctl.prepared) prepareAndSend(ctl, false); }
    }, true);
  }
  window.addEventListener('keydown', (e) => {
    if (state.pass || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const ctl = ctlFor(e.target);
    if (!ctl || !ctl.tracking || ctl.prepared) return;
    e.preventDefault(); e.stopImmediatePropagation();
    prepareAndSend(ctl, true);
  }, true);

  // ---------- 4. ✓ / ✓✓ marks ----------
  let scanTimer = null;
  function scheduleScan() { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 400); }
  const norm = (s) => String(s || '').replace(/^(re|fwd?|aw|wg):\s*/gi, '').trim().toLowerCase();

  function tickHtml(e) {
    const opened = e.open_count > 0;
    const title = opened ? `Opened ${e.open_count}× · last ${ago(e.last_open_at)}${e.click_count ? ` · ${e.click_count} click(s)` : ''}` : `Sent ${ago(e.sent_at)} · not opened yet`;
    return `<span class="openenvelope-tick ${opened ? 'opened' : ''}" title="${title}" aria-label="${title}">${opened ? '✓✓' : '✓'}</span>`;
  }
  function ago(ts) { if (!ts) return ''; const s = (Date.now() - ts) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${s / 60 | 0} min ago` : s < 86400 ? `${s / 3600 | 0} h ago` : `${s / 86400 | 0} d ago`; }

  function scan() {
    document.querySelectorAll(SEL.composeBody).forEach((b) => { if (!b.dataset.openenvelope) setupCompose(b); });
    if (!state.emails.length) return;
    document.querySelectorAll(SEL.listRow).forEach((row) => {
      const subjEl = row.querySelector(SEL.rowSubject);
      if (!subjEl) return;
      const e = state.bySubject.get(norm(subjEl.textContent));
      const existing = row.querySelector('.openenvelope-tick');
      if (!e) { existing?.remove(); return; }
      const html = tickHtml(e);
      if (existing?.outerHTML === html) return;
      existing?.remove();
      subjEl.insertAdjacentHTML('beforebegin', html);
    });
  }

  async function showThreadBanner(img, id) {
    const msg = img.closest(SEL.messageBody);
    if (!msg || msg.querySelector('.openenvelope-banner')) return;
    let e;
    try { e = await apiCall('GET', `/api/emails/${id}`); } catch { return; }
    const opens = e.events.filter((x) => x.type === 'open');
    const div = document.createElement('div');
    div.className = 'openenvelope-banner';
    div.innerHTML = `${tickHtml(e)} <b>${opens.length ? `Opened ${opens.length}×` : 'Not opened yet'}</b>
      ${opens.length ? ` · first ${ago(e.first_open_at)} · last ${ago(e.last_open_at)}` : ''}${e.click_count ? ` · ${e.click_count} link click(s)` : ''}
      <button type="button">History</button>`;
    div.querySelector('button').onclick = () => send({ type: 'open-dashboard', hash: '#email=' + id });
    msg.prepend(div);
  }

  function toast(text, ms = 6000) {
    const t = document.createElement('div'); t.className = 'openenvelope-toast'; t.setAttribute('role', 'alert'); t.textContent = text;
    (document.body || document.documentElement).append(t); setTimeout(() => t.remove(), ms);
  }

  async function refreshEmails() {
    try {
      state.emails = await apiCall('GET', '/api/emails?limit=300');
      state.bySubject = new Map(); for (const e of [...state.emails].reverse()) if (e.subject) state.bySubject.set(norm(e.subject), e);
      scheduleScan();
    } catch {}
  }

  chrome.runtime.onMessage.addListener((m) => { if (m.type === 'openenvelope-refresh') refreshEmails(); });

  (async function init() {
    const c = await send({ type: 'config' });
    state.config = c.ok ? c.data : { configured: false };
    if (!state.config.configured) return;
    send({ type: 'wake' }); // wake a sleeping free-tier server now, before the first compose
    try { state.settings = (await send({ type: 'settings' })).data; } catch {}
    document.querySelectorAll('img').forEach(checkImg);
    refreshEmails();
    setInterval(refreshEmails, 60_000);
  })();
})();
