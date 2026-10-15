// Local end-to-end check for OpenEnvelope. Runs the real server and the real unpacked extension in
// headless Chromium. Gmail itself is replaced by a local fixture page served at https://mail.google.com/
// (request interception), because real Gmail needs a real Google account. See README "What is tested".
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const shots = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const PORT = 8790, BASE = `http://127.0.0.1:${PORT}`;
const PROXY_UA = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. server ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openenvelope-e2e-'));
const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DATA_DIR: dataDir, SMTP_URL: 'json', SMTP_FROM: 'me@example.com', SCHEDULER_INTERVAL_MS: '1500', IP_MODE: 'hash', IP_SALT: 'e2e', SIGNUP_CODE: 'e2e-invite' };
const server = spawn(process.execPath, ['--no-warnings', 'src/index.js'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', (d) => (serverLog += d)); server.stderr.on('data', (d) => (serverLog += d));
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {} await sleep(200); }
const keyOut = execFileSync(process.execPath, ['--no-warnings', 'src/cli.js', 'create-user', 'me@example.com', 'Makrawat'], { cwd: path.join(root, 'server'), env }).toString();
const KEY = keyOut.trim().split('\n').pop();
check('server boots and CLI creates a user + API key', KEY.startsWith('oe_'));
const api = async (method, p, body) => { const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.headers.get('content-type')?.includes('json') ? r.json() : r.text(); };
await api('PUT', '/api/settings', { self_open_grace_sec: 0, digest_frequency: 'daily' });

// ---- 2. browser with the unpacked extension ----
const extPath = path.join(root, 'extension');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openenvelope-chrome-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: true, channel: 'chromium', viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});
const errors = [];
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
check('extension service worker starts (manifest V3 loads)', !!sw, sw?.url());
const extId = sw ? new URL(sw.url()).host : null;
sw?.on('console', (m) => { if (m.type() === 'error') errors.push('sw: ' + m.text()); });
const watch = (page, label) => { page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_BLOCKED|googleusercontent/.test(m.text())) errors.push(`${label}: ${m.text()}`); }); };

// Read the manifest the way Chrome loaded it.
const extPage = await ctx.newPage(); watch(extPage, 'dashboard');
await extPage.goto(`chrome-extension://${extId}/dashboard/dashboard.html#settings`);
const mf = await extPage.evaluate(() => chrome.runtime.getManifest());
check('manifest parsed by Chrome', mf.manifest_version === 3 && mf.name.startsWith('OpenEnvelope'), `${mf.name} v${mf.version}`);
await extPage.waitForSelector('#save-conn');
await extPage.screenshot({ path: path.join(shots, 'settings-empty.png') });
await extPage.fill('#srv', BASE); await extPage.fill('#key', KEY);
await extPage.evaluate(async ([s, k]) => chrome.storage.sync.set({ serverUrl: s, apiKey: k }), [BASE, KEY]);
await extPage.reload(); await extPage.waitForSelector('#conn .ok-msg', { timeout: 8000 }).catch(() => {});
check('settings page connects to the server', /Connected as me@example.com/.test(await extPage.textContent('#conn')));
await extPage.screenshot({ path: path.join(shots, 'settings.png'), fullPage: true });
// prime the notification cursor (first poll only records the newest event id)
await extPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'poll-now' }, r)));

// ---- 3. fake Gmail compose → send ----
const fixture = fs.readFileSync(path.join(here, 'fixtures', 'fake-gmail.html'), 'utf8');
const modernFixture = fs.readFileSync(path.join(here, 'fixtures', 'modern-gmail.html'), 'utf8');
await ctx.route('https://mail.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: r.request().url().includes('fixture=modern') ? modernFixture : fixture }));
const proxyHits = [];
await ctx.route('https://ci3.googleusercontent.com/**', (r) => { proxyHits.push(r.request().url()); r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }); });
const gmail = await ctx.newPage(); watch(gmail, 'gmail');
await gmail.goto('https://mail.google.com/mail/u/0/#inbox');
await gmail.waitForSelector('.openenvelope-bar', { timeout: 10000 }).catch(() => {});
check('compose window gets the ✓✓ Tracking toggle', await gmail.$('.openenvelope-bar .tk-toggle') !== null);
await sleep(800); // reserve call
await gmail.screenshot({ path: path.join(shots, 'gmail-compose-fixture.png') });
await gmail.click('[data-tooltip^="Send"]');
await gmail.waitForFunction(() => window.__sent.length > 0, null, { timeout: 8000 }).catch(() => {});
const sent = await gmail.evaluate(() => window.__sent);
check('send is intercepted once, then released to "Gmail" exactly once', sent.length === 1, `sends=${sent.length}`);
const html = sent[0]?.html || '';
const pixel = html.match(/\/t\/([A-Za-z0-9_-]+)\.gif/);
check('pixel inserted into the outgoing HTML', !!pixel, pixel?.[0]);
const emailId = pixel?.[1];
check('link rewritten to a tracked redirect', new RegExp(`${BASE}/c/${emailId}/0`).test(html));
check('no branding/signature added to the email', !/openenvelope|mailtrack|sent with/i.test(html.replace(/https?:\/\/[^"]+/g, '')));
let rec = await api('GET', `/api/emails/${emailId}`);
check('server registered subject + recipient', rec.subject === 'Internship application – IIT KGP' && rec.recipients[0] === 'prof.rao@iitkgp.ac.in', JSON.stringify({ s: rec.subject, r: rec.recipients }));

check('sender browser never fetched its own pixel while composing/sending (blocked)', rec.open_count === 0 && rec.events.length === 0, `events=${rec.events.length}`);

// ---- 4. recipient opens (simulated Gmail image proxy fetch) ----
const pr = await fetch(`${BASE}/t/${emailId}.gif`, { headers: { 'user-agent': PROXY_UA } });
check('pixel served as GIF', pr.headers.get('content-type') === 'image/gif');
rec = await api('GET', `/api/emails/${emailId}`);
check('open recorded with Gmail-proxy label', rec.open_count === 1 && rec.events.some((e) => e.type === 'open' && e.client === 'Gmail (Google image proxy)'));
const polled = await extPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'poll-now' }, r)));
const ev = polled?.data?.find?.((e) => e.type === 'open');
check('background poll returns the open as a notification payload', !!ev && /prof\.rao@iitkgp\.ac\.in opened “Internship application – IIT KGP”/.test(ev.text), ev?.text);
const badge = await extPage.evaluate(() => chrome.action.getBadgeText({}));
check('toolbar badge shows unread count', badge === '1', `badge="${badge}"`);
// Note: chrome.notifications.create is called with that payload; headless Chromium does not display OS notifications.

// ---- 5. click redirect ----
const cr = await fetch(`${BASE}/c/${emailId}/0`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605 Mobile/15E148' } });
check('click redirects to the original link', cr.status === 302 && cr.headers.get('location') === 'https://github.com/makrawat/pinn-corona');
rec = await api('GET', `/api/emails/${emailId}`);
check('click recorded with device', rec.click_count === 1 && rec.events.some((e) => e.type === 'click' && e.device === 'iPhone'));

// ---- 6. list marks + sender viewing own email (self-open filter) ----
await gmail.evaluate(() => chrome?.runtime); // no-op
await gmail.reload(); await sleep(1500);
const tickText = await gmail.$eval('tr.zA:first-child .openenvelope-tick', (e) => e.textContent).catch(() => null);
const untracked = await gmail.$('tr.zA:nth-child(2) .openenvelope-tick');
check('mail list shows ✓✓ on the opened tracked email and nothing on others', tickText === '✓✓' && !untracked, `tick=${tickText}`);
await sleep(5500); // keep the recipient's open outside the 5 s self-view relabel window
// Gmail renders your sent message with the pixel behind its image proxy URL:
const proxied = `https://ci3.googleusercontent.com/meips/ADKq_FAKE=s0-d-e1-ft#${BASE}/t/${emailId}.gif`;
const before = (await api('GET', `/api/emails/${emailId}`)).open_count;
await gmail.evaluate((src) => { const t = document.getElementById('thread'); t.innerHTML = '<p>Dear Prof. Rao, …</p>'; const i = new Image(1, 1); i.src = src; t.append(i); }, proxied);
await sleep(1500);
const imgSrc = await gmail.$eval('#thread img', (i) => i.getAttribute('src'));
const after = (await api('GET', `/api/emails/${emailId}`)).open_count;
check("sender's own view: pixel stripped or relabelled, open count unchanged", after === before, `src=${imgSrc === null ? 'stripped' : 'kept'} proxyFetches=${proxyHits.length} opens ${before}->${after}`);
check('thread view shows the open-history banner', !!(await gmail.$('#thread .openenvelope-banner')));
await gmail.screenshot({ path: path.join(shots, 'gmail-list-thread-fixture.png') });

// ---- 7. reminder (0.001 h ≈ 4 s, scheduler ticks every 1.5 s in this run) ----
const r1 = await api('POST', '/api/emails/reserve');
await api('POST', `/api/emails/${r1.id}/prepare`, { subject: 'Following up on my application', recipients: ['hr@example.com'], remind_hours: 0.001 });
await sleep(6000);
const evs = await api('GET', '/api/events?limit=20');
check('"not opened" reminder fired from the live scheduler', evs.some((e) => e.type === 'reminder_no_open' && e.email_id === r1.id));

// ---- 8. digest ----
const dg = await api('GET', '/api/digest/preview?period=daily');
check('daily report renders with real numbers', /daily report/.test(dg.html) && dg.summary.sent >= 2 && dg.summary.opens >= 1, JSON.stringify({ sent: dg.summary.sent, opens: dg.summary.opens }));
fs.writeFileSync(path.join(shots, 'digest.html'), dg.html);

// ---- 9. mail merge dry run (SMTP JSON transport: nothing leaves the machine) ----
const csv = fs.readFileSync(path.join(root, 'examples', 'recipients.csv'), 'utf8');
const camp = await api('POST', '/api/campaigns', { name: 'Internship outreach (dry run)', subject: 'Internship enquiry – {{First Name}}', body: fs.readFileSync(path.join(root, 'examples', 'campaign.html'), 'utf8'), csv, send_via: 'smtp' });
const sendRes = await api('POST', `/api/campaigns/${camp.id}/send`);
const det = await api('GET', `/api/campaigns/${camp.id}`);
check('mail merge: personalised per-recipient copies created and "sent" (dry-run)', camp.recipients >= 3 && sendRes.sent === camp.recipients && det.stats.sent === camp.recipients, `recipients=${camp.recipients} skipped=${camp.skipped.length}`);
const firstRecipient = det.recipients[0];
await fetch(`${BASE}/t/${firstRecipient.id}.gif`, { headers: { 'user-agent': PROXY_UA } });
const det2 = await api('GET', `/api/campaigns/${camp.id}`);
check('campaign stats update per recipient', det2.stats.opened === 1);

// ---- 10. tracked PDF viewer + signing page render with pdf.js ----
const { PDFDocument, StandardFonts } = await import(path.join(root, 'server', 'node_modules', 'pdf-lib', 'cjs', 'index.js'));
const doc = await PDFDocument.create(); const f = await doc.embedFont(StandardFonts.HelveticaBold);
for (let i = 1; i <= 2; i++) doc.addPage([420, 594]).drawText(`Project proposal — page ${i}`, { x: 40, y: 520, size: 18, font: f });
const pdfBytes = Buffer.from(await doc.save());
const up = await (await fetch(`${BASE}/api/documents?name=proposal.pdf&watermark=Confidential%20%E2%80%93%20{viewer}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/pdf' }, body: pdfBytes })).json();
const viewer = await ctx.newPage(); watch(viewer, 'viewer');
await viewer.goto(`${up.share_url}?r=asha@example.com`);
await viewer.click('#gate button');
await viewer.waitForSelector('.page canvas', { timeout: 10000 }).catch(() => {});
await sleep(6500); // let one 5 s heartbeat land
const pagesRendered = await viewer.$$eval('.page canvas', (c) => c.length);
check('tracked PDF renders in the viewer (pdf.js) with watermark', pagesRendered === 2 && !!(await viewer.$('.wm')), `pages=${pagesRendered}`);
await viewer.screenshot({ path: path.join(shots, 'pdf-viewer.png') });
await viewer.close(); await sleep(300);
const dd = await api('GET', `/api/documents/${up.id}`);
check('document view + time-per-page recorded', dd.views === 1 && Object.values(dd.seconds_per_page).reduce((a, b) => a + b, 0) > 0, JSON.stringify(dd.seconds_per_page));
const srq = await api('POST', '/api/sign-requests', { document_id: up.id, signer_name: 'Asha', signer_email: 'asha@example.com' });
const sp = await ctx.newPage(); watch(sp, 'sign');
await sp.goto(srq.sign_url); await sp.waitForSelector('#pad');
const box = await sp.$eval('#pad', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await sp.mouse.move(box.x + 30, box.y + 100); await sp.mouse.down();
for (let i = 0; i < 20; i++) await sp.mouse.move(box.x + 30 + i * 15, box.y + 100 - Math.sin(i / 2) * 40);
await sp.mouse.up(); await sp.check('#agree');
await sp.screenshot({ path: path.join(shots, 'sign-page.png') });
await sp.click('#signform button[type=submit]'); await sp.waitForSelector('text=Signed ✓', { timeout: 8000 }).catch(() => {});
const sr = (await api('GET', '/api/sign-requests')).find((x) => x.id === srq.id);
check('e-signature flow completes in the browser with audit trail', sr?.status === 'signed' && sr.audit.length === 3);

// ---- 11. popup + dashboard screenshots ----
await api('POST', '/api/templates', { name: 'Follow-up', subject: 'Following up', body: '<p>Hi {{first_name}}, just following up on my last email.</p>' });
const poll = await api('POST', '/api/polls', { question: 'Can we meet Friday?', options: ['Yes', 'No', 'Next week'] });
await fetch(poll.links[0].url + '?v=a'); await fetch(poll.links[0].url + '?v=b'); await fetch(poll.links[2].url + '?v=c');
await api('PUT', '/api/contacts/prof.rao@iitkgp.ac.in', { name: 'Prof. Rao', notes: 'Replied about summer internship', lists: ['professors'] });
const popup = await ctx.newPage(); watch(popup, 'popup');
await popup.setViewportSize({ width: 360, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
await popup.waitForSelector('#ready:not([hidden])', { timeout: 8000 }).catch(() => {});
check('popup renders connected with recent activity', /Connected/.test(await popup.textContent('#status')) && (await popup.$$('#emails li[data-id]')).length >= 1);
await popup.screenshot({ path: path.join(shots, 'popup.png') });
for (const [hash, name, sel] of [['activity', 'dashboard-activity', '#feed'], ['emails', 'dashboard-emails', '#rows tr'], ['campaigns', 'dashboard-campaigns', 'table'], ['contacts', 'dashboard-contacts', 'table'], ['documents', 'dashboard-documents', 'table'], ['polls', 'dashboard-polls', '.panel']]) {
  await extPage.goto(`chrome-extension://${extId}/dashboard/dashboard.html#${hash}`);
  await extPage.waitForSelector(sel, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  await extPage.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
}
check('dashboard Activity shows the open', /opened “Internship application – IIT KGP”/.test(await (async () => { await extPage.goto(`chrome-extension://${extId}/dashboard/dashboard.html#activity`); await extPage.waitForSelector('#feed li'); return extPage.textContent('#feed'); })()));
await extPage.goto(`chrome-extension://${extId}/dashboard/dashboard.html#email=${emailId}`);
await extPage.waitForSelector('.drawer', { timeout: 8000 }).catch(() => {});
await sleep(300);
await extPage.screenshot({ path: path.join(shots, 'dashboard-email-detail.png') });
check('email detail drawer shows open history', /Opened|opens/i.test(await extPage.textContent('.drawer')));
// Web dashboard served by the backend (for phones / other browsers)
const web = await ctx.newPage(); watch(web, 'web-dashboard');
await web.setViewportSize({ width: 390, height: 844 });
await web.goto(`${BASE}/app/dashboard/dashboard.html#settings`);
await web.evaluate(([s, k]) => { localStorage.setItem('tk_server', s); localStorage.setItem('tk_key', k); }, [BASE, KEY]);
await web.goto(`${BASE}/app/dashboard/dashboard.html#activity`); await web.waitForSelector('#feed li', { timeout: 8000 }).catch(() => {});
const overflow = await web.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
check('web dashboard (served by the server) works at phone width without horizontal overflow', (await web.$$('#feed li')).length > 0 && !overflow);
await web.screenshot({ path: path.join(shots, 'web-dashboard-mobile.png') });

// ---- 12. recipients in a modern-Gmail-like compose (chips without email attributes) ----
{
  const mg = await ctx.newPage(); watch(mg, 'gmail-modern');
  await mg.goto('https://mail.google.com/mail/u/0/?fixture=modern#inbox');
  await mg.waitForFunction(() => document.querySelectorAll('.openenvelope-bar').length === 2, null, { timeout: 10000 }).catch(() => {});
  await sleep(800);
  await mg.click('#c1 [data-tooltip^="Send"]'); await mg.waitForFunction(() => window.__sent.some((s) => s.compose === 'c1'), null, { timeout: 12000 }).catch(() => {});
  await sleep(200); // let the first compose's synthetic send finish
  await mg.click('#c2 [data-tooltip^="Send"]'); await mg.waitForFunction(() => window.__sent.some((s) => s.compose === 'c2'), null, { timeout: 12000 }).catch(() => {});
  await sleep(300);
  const list = await api('GET', '/api/emails?limit=50');
  const m1 = list.find((x) => x.subject === 'Modern compose recipients test');
  const m2 = list.find((x) => x.subject === 'Fallback regex recipients test');
  const r1 = [...(m1?.recipients || [])].sort();
  check('modern compose: recipients read from chip aria-label, tooltip and the typed To input', JSON.stringify(r1) === JSON.stringify(['asha.verma@college.edu', 'ravi@startup.in', 'second.account@gmail.com']), JSON.stringify(r1));
  check('modern compose: body addresses and the sender\'s own address are excluded', !r1.some((x) => /body-example|me@example\.com/.test(x)));
  const sentM = await mg.evaluate(() => window.__sent.map((x) => x.compose + ':' + /\/t\//.test(x.html)));
  check('unknown compose markup: regex fallback over the recipients row', JSON.stringify(m2?.recipients || []) === JSON.stringify(['sam.lee@example.org']), JSON.stringify(m2?.recipients) + ' sent=' + sentM.join(','));
  const first = list.find((x) => x.id === emailId);
  check('classic chip markup still captured', (first?.recipients || []).includes('prof.rao@iitkgp.ac.in'), JSON.stringify(first?.recipients));
  await mg.close();
}

// ---- 13. sleeping server (Render free cold start): slow reserve, then a dead server ----
{
  const http = await import('node:http');
  let mode = 'slow';
  const PROXY = 8791;
  const proxy = http.createServer((req, res) => {
    if (mode === 'down') return req.socket.destroy();
    const go = () => {
      const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', () => res.destroy()); req.pipe(up);
    };
    if (mode === 'slow' && req.url.startsWith('/api/emails/reserve')) setTimeout(go, 5000); else go();
  });
  await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));
  const PURL = `http://127.0.0.1:${PROXY}`;
  await extPage.evaluate(async (s) => chrome.storage.sync.set({ serverUrl: s }), PURL);
  const cold = await ctx.newPage(); cold.on('pageerror', (er) => errors.push(`gmail-cold: ${er.message}`)); // console errors here are the proxy's loopback image block, a test artifact
  await cold.goto('https://mail.google.com/mail/u/0/#inbox');
  await cold.waitForSelector('.openenvelope-bar', { timeout: 10000 }).catch(() => {});
  await sleep(2200);
  const wakingText = await cold.textContent('.openenvelope-bar .tk-toggle').catch(() => '');
  check('toggle shows "Waking your server…" while the server is slow to answer', /Waking your server/.test(wakingText), wakingText.trim());
  await cold.click('[data-tooltip^="Send"]'); // pressed before the server answered
  await cold.waitForFunction(() => window.__sent.length > 0, null, { timeout: 20000 }).catch(() => {});
  const coldSent = await cold.evaluate(() => window.__sent);
  check('send pressed while the server is waking up waits and goes out tracked', coldSent.length === 1 && /\/t\/[A-Za-z0-9_-]+\.gif/.test(coldSent[0].html), `sends=${coldSent.length}`);
  check('toggle returns to "Tracking" after the server answered', /Tracking/.test(await cold.textContent('.openenvelope-bar .tk-toggle')));
  await cold.close();
  mode = 'down';
  const dead = await ctx.newPage(); dead.on('pageerror', (er) => errors.push(`gmail-dead: ${er.message}`));
  await dead.goto('https://mail.google.com/mail/u/0/#inbox');
  await dead.waitForSelector('.openenvelope-bar', { timeout: 10000 }).catch(() => {});
  await sleep(1000);
  await dead.click('[data-tooltip^="Send"]');
  await dead.waitForFunction(() => window.__sent.length > 0, null, { timeout: 20000 }).catch(() => {});
  const deadSent = await dead.evaluate(() => window.__sent);
  const toastText = await dead.textContent('.openenvelope-toast').catch(() => '');
  check('server down: email still sends (untracked) and a clear toast says so', deadSent.length === 1 && !/\/t\/[A-Za-z0-9_-]+\.gif/.test(deadSent[0].html) && /went out untracked/.test(toastText), toastText);
  await dead.close();
  await extPage.evaluate(async (s) => chrome.storage.sync.set({ serverUrl: s }), BASE);
  proxy.close();
}

// ---- 14. friend creates an account from the settings page with the invite code ----
{
  const su = await ctx.newPage(); su.on('pageerror', (er) => errors.push(`signup: ${er.message}`)); // 403/409 responses are expected here
  await su.goto(`chrome-extension://${extId}/dashboard/dashboard.html#settings`);
  await su.evaluate(async () => { await chrome.storage.sync.set({ serverUrl: '', apiKey: '' }); });
  await su.reload(); await su.waitForSelector('#signup', { timeout: 8000 }).catch(() => {});
  check('settings shows "New here? Create an account" when not connected', /New here\? Create an account/.test(await su.textContent('#signup').catch(() => '')));
  await su.evaluate(() => { chrome.permissions.request = async () => true; }); // headless: no permission prompt UI
  await su.fill('#su-srv', BASE); await su.fill('#su-email', 'friend@example.com'); await su.fill('#su-code', 'wrong-code');
  await su.click('#su-go'); await su.waitForSelector('#su-msg .err', { timeout: 8000 }).catch(() => {});
  check('wrong invite code shows a clear error', /Wrong invite code/.test(await su.textContent('#su-msg')));
  await su.fill('#su-email', 'me@example.com'); await su.fill('#su-code', 'e2e-invite');
  await su.click('#su-go'); await sleep(300); await su.waitForSelector('#su-msg .err', { timeout: 8000 }).catch(() => {});
  check('existing email shows a clear error', /already exists/.test(await su.textContent('#su-msg')));
  await su.fill('#su-email', 'friend@example.com');
  await su.click('#su-go'); await su.waitForSelector('#conn .ok-msg', { timeout: 10000 }).catch(() => {});
  check('right invite code creates the account, saves key + server and connects', /Connected as friend@example.com/.test(await su.textContent('#conn').catch(() => '')) && !!(await su.$('#su-done')));
  const saved = await su.evaluate(() => chrome.storage.sync.get(['serverUrl', 'apiKey']));
  check('new API key and server URL saved in extension settings', saved.serverUrl === BASE && /^oe_/.test(saved.apiKey) && saved.apiKey !== KEY);
  await su.screenshot({ path: path.join(shots, 'settings-signup.png'), fullPage: true });
  await su.evaluate(async ([s, k]) => chrome.storage.sync.set({ serverUrl: s, apiKey: k }), [BASE, KEY]);
  await su.close();
}

check('no uncaught errors in extension pages, service worker or fixture', errors.length === 0, errors.slice(0, 5).join(' | '));

await ctx.close(); server.kill();
const summary = { ran_at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed, results };
fs.writeFileSync(path.join(here, 'e2e-results.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
