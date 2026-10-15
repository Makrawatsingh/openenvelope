import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, GMAIL_PROXY_UA } from './helpers.js';

let S;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

async function sendTracked(overrides = {}) {
  const r = await S.api('POST', '/api/emails/reserve');
  assert.equal(r.status, 201);
  const p = await S.api('POST', `/api/emails/${r.body.id}/prepare`, { subject: 'Internship application', recipients: ['Prof@IITkgp.ac.in'], urls: ['https://github.com/me/project', 'javascript:alert(1)'], ...overrides });
  assert.equal(p.status, 200);
  // Pretend the email left a while ago so the self-open grace period does not apply.
  S.core.Q.run('UPDATE emails SET sent_at=sent_at-60000 WHERE id=?', r.body.id);
  return p.body;
}

test('API key is required and checked', async () => {
  const r = await fetch(S.base + '/api/me');
  assert.equal(r.status, 401);
  const bad = await fetch(S.base + '/api/me', { headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
  const ok = await S.api('GET', '/api/me');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'me@example.com');
  assert.equal(ok.body.settings.track_by_default, true);
});

test('signup is admin-only by default', async () => {
  const r = await fetch(S.base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@y.z' }) });
  assert.equal(r.status, 403);
  const a = await fetch(S.base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin-secret' }, body: JSON.stringify({ email: 'friend@y.z' }) });
  assert.equal(a.status, 201);
  const j = await a.json();
  assert.match(j.api_key, /^oe_/);
  const me = await fetch(S.base + '/api/me', { headers: { authorization: `Bearer ${j.api_key}` } });
  assert.equal((await me.json()).email, 'friend@y.z');
});

test('pixel returns a no-cache GIF and records an open with proxy-aware details', async () => {
  const sent = await sendTracked();
  const r = await S.hit(`/t/${sent.id}.gif`, GMAIL_PROXY_UA);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/gif');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 6).toString(), 'GIF89a');
  const d = await S.api('GET', `/api/emails/${sent.id}`);
  assert.equal(d.body.open_count, 1);
  const ev = d.body.events.find((e) => e.type === 'open');
  assert.equal(ev.client, 'Gmail (Google image proxy)');
  assert.equal(ev.via_proxy, 1);
  assert.equal(ev.contact_email, 'prof@iitkgp.ac.in');
  assert.match(ev.ip, /^h:[0-9a-f]{16}$/, 'IP is stored hashed by default');
});

test('pixel for an unknown or reserved (unsent) id records nothing but still returns the GIF', async () => {
  const r = await S.hit('/t/doesnotexist.gif');
  assert.equal(r.status, 200);
  const res = await S.api('POST', '/api/emails/reserve');
  await S.hit(`/t/${res.body.id}.gif`);
  const n = S.core.Q.get("SELECT COUNT(*) n FROM events WHERE email_id=?", res.body.id).n;
  assert.equal(n, 0);
});

test("sender's own views are filtered (self-view window and send grace period)", async () => {
  const sent = await sendTracked();
  await S.api('POST', `/api/emails/${sent.id}/self-view`, { seconds: 30 });
  await S.hit(`/t/${sent.id}.gif`, GMAIL_PROXY_UA);
  let d = await S.api('GET', `/api/emails/${sent.id}`);
  assert.equal(d.body.open_count, 0);
  assert.ok(d.body.events.some((e) => e.type === 'self_open'));
  // grace period right after sending
  const r = await S.api('POST', '/api/emails/reserve');
  await S.api('POST', `/api/emails/${r.body.id}/prepare`, { subject: 'fresh', recipients: ['a@b.co'] });
  await S.hit(`/t/${r.body.id}.gif`);
  d = await S.api('GET', `/api/emails/${r.body.id}`);
  assert.equal(d.body.open_count, 0, 'open within self_open_grace_sec is treated as the sender');
});

test('link click redirects to the original URL and is recorded; unsafe/unknown links are not redirected', async () => {
  const sent = await sendTracked();
  assert.equal(sent.links.length, 2);
  assert.equal(sent.links[1].skipped, true, 'javascript: URLs are never wrapped');
  const tracked = sent.links[0].tracked_url;
  const r = await fetch(tracked, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://github.com/me/project');
  const d = await S.api('GET', `/api/emails/${sent.id}`);
  assert.equal(d.body.click_count, 1);
  assert.equal(d.body.links[0].click_count, 1);
  const bad = await S.hit(`/c/${sent.id}/99`);
  assert.equal(bad.status, 404, 'no open redirect for unregistered links');
});

test('events feed and stats include opens and clicks but never self-opens', async () => {
  const feed = await S.api('GET', '/api/events?since=0&limit=500');
  assert.ok(feed.body.length > 0);
  assert.ok(feed.body.every((e) => e.type !== 'self_open'));
  assert.ok(feed.body.some((e) => e.type === 'open' && /opened “Internship application”/.test(e.text)));
  const st = await S.api('GET', '/api/stats');
  assert.ok(st.body.sent >= 3);
  assert.ok(st.body.opens >= 1 && st.body.clicks >= 1);
});

test('hot conversation alert after N opens within the window, once', async () => {
  const sent = await sendTracked({ subject: 'Hot one' });
  for (let i = 0; i < 4; i++) await S.hit(`/t/${sent.id}.gif`);
  const hot = S.core.Q.all("SELECT * FROM events WHERE email_id=? AND type='hot'", sent.id);
  assert.equal(hot.length, 1);
});

test('old conversation revival alert when an email is reopened after the quiet period', async () => {
  const sent = await sendTracked({ subject: 'Old thread' });
  await S.hit(`/t/${sent.id}.gif`);
  S.core.Q.run('UPDATE emails SET last_open_at=last_open_at-8*86400000 WHERE id=?', sent.id);
  await S.hit(`/t/${sent.id}.gif`);
  const rev = S.core.Q.all("SELECT * FROM events WHERE email_id=? AND type='revival'", sent.id);
  assert.equal(rev.length, 1);
});

test('custom alerts: only_domains and do_not_track', async () => {
  await S.api('PUT', '/api/settings', { alerts: { only_domains: ['iitkgp.ac.in'] } });
  const got = [];
  const fn = (u, ev) => got.push(ev); S.core.listeners.add(fn);
  const a = await sendTracked({ recipients: ['someone@gmail.com'], subject: 'muted domain' });
  await S.hit(`/t/${a.id}.gif`);
  const b = await sendTracked({ recipients: ['hod@iitkgp.ac.in'], subject: 'allowed domain' });
  await S.hit(`/t/${b.id}.gif`);
  S.core.listeners.delete(fn);
  assert.deepEqual(got.filter((e) => e.type === 'open').map((e) => e.subject), ['allowed domain']);
  await S.api('PUT', '/api/settings', { alerts: { only_domains: [] } });
  await S.api('PUT', '/api/contacts/dnt@x.com', { do_not_track: true });
  const c = await sendTracked({ recipients: ['dnt@x.com'], subject: 'dnt' });
  await S.hit(`/t/${c.id}.gif`);
  assert.equal((await S.api('GET', `/api/emails/${c.id}`)).body.open_count, 0);
});

test('IP privacy modes: none stores nothing, full stores the address', async () => {
  await S.api('PUT', '/api/settings', { ip_mode: 'none' });
  const a = await sendTracked({ subject: 'ip none' });
  await S.hit(`/t/${a.id}.gif`);
  assert.equal(S.core.Q.get("SELECT ip FROM events WHERE email_id=? AND type='open'", a.id).ip, null);
  await S.api('PUT', '/api/settings', { ip_mode: 'full' });
  const b = await sendTracked({ subject: 'ip full' });
  await S.hit(`/t/${b.id}.gif`);
  assert.match(S.core.Q.get("SELECT ip FROM events WHERE email_id=? AND type='open'", b.id).ip, /127\.0\.0\.1|::1|::ffff/);
  const bad = await S.api('PUT', '/api/settings', { ip_mode: 'weird' });
  assert.equal(bad.status, 400);
  await S.api('PUT', '/api/settings', { ip_mode: 'hash' });
});

test('webhook (Zapier-style) receives events as JSON', async () => {
  const http = await import('node:http');
  const got = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => hook.listen(0, r));
  await S.api('PUT', '/api/settings', { webhook_url: `http://127.0.0.1:${hook.address().port}/hook` });
  const s = await sendTracked({ subject: 'webhook test' });
  await S.hit(`/t/${s.id}.gif`);
  await new Promise((r) => setTimeout(r, 200));
  await S.api('PUT', '/api/settings', { webhook_url: '' });
  hook.close();
  assert.ok(got.some((e) => e.source === 'openenvelope' && e.type === 'open' && e.subject === 'webhook test'));
});

test('certificate PDF of the tracking record', async () => {
  const s = await sendTracked({ subject: 'certified' });
  await S.hit(`/t/${s.id}.gif`);
  const r = await S.api('GET', `/api/emails/${s.id}/certificate`);
  assert.equal(r.status, 200);
  assert.equal(r.body.subarray(0, 5).toString(), '%PDF-');
});

test('contacts: CRM notes, lists, export and erase', async () => {
  await S.api('PUT', '/api/contacts/prof@iitkgp.ac.in', { name: 'Prof. X', notes: 'Met at TechFest', lists: ['professors'] });
  const lists = await S.api('GET', '/api/lists');
  assert.deepEqual(lists.body, [{ name: 'professors', count: 1 }]);
  const c = await S.api('GET', '/api/contacts?list=professors');
  assert.equal(c.body[0].notes, 'Met at TechFest');
  assert.ok(c.body[0].opens >= 1);
  const ex = await S.api('GET', '/api/contacts/prof@iitkgp.ac.in/export');
  assert.ok(ex.body.events.length >= 1);
  const del = await S.api('DELETE', '/api/contacts/prof@iitkgp.ac.in');
  assert.ok(del.body.events_deleted >= 1);
  const ex2 = await S.api('GET', '/api/contacts/prof@iitkgp.ac.in/export');
  assert.equal(ex2.body.events.length, 0);
});

test('templates CRUD', async () => {
  const t = await S.api('POST', '/api/templates', { name: 'Follow-up', subject: 'Following up', body: 'Hi {{first_name}}, just checking in.' });
  assert.equal(t.status, 201);
  const l = await S.api('GET', '/api/templates');
  assert.equal(l.body.length, 1);
  await S.api('PUT', `/api/templates/${t.body.id}`, { subject: 'Quick follow-up' });
  assert.equal((await S.api('GET', '/api/templates')).body[0].subject, 'Quick follow-up');
  await S.api('DELETE', `/api/templates/${t.body.id}`);
  assert.equal((await S.api('GET', '/api/templates')).body.length, 0);
});

test('polls: vote links record answers, a revote changes the answer', async () => {
  const p = await S.api('POST', '/api/polls', { question: 'Meet Friday?', options: ['Yes', 'No'] });
  assert.equal(p.status, 201);
  assert.match(p.body.html, /Meet Friday\?/);
  await S.hit(new URL(p.body.links[0].url).pathname + '?v=alice');
  await S.hit(new URL(p.body.links[1].url).pathname + '?v=bob');
  await S.hit(new URL(p.body.links[1].url).pathname + '?v=alice');
  const r = await S.api('GET', `/api/polls/${p.body.id}`);
  assert.deepEqual(r.body.options.map((o) => o.votes), [0, 2]);
  assert.equal((await S.hit(`/p/${p.body.id}/7`)).status, 404);
});

test('self-view ping that arrives after the proxy fetch re-labels that open as the sender\'s own', async () => {
  const sent = await sendTracked({ subject: 'race' });
  await S.hit(`/t/${sent.id}.gif`, GMAIL_PROXY_UA);
  assert.equal((await S.api('GET', `/api/emails/${sent.id}`)).body.open_count, 1);
  const r = await S.api('POST', `/api/emails/${sent.id}/self-view`, {});
  assert.equal(r.body.relabelled, 1);
  assert.equal((await S.api('GET', `/api/emails/${sent.id}`)).body.open_count, 0);
});

test('no-reply reminder: fires when no reply was reported, skipped after a reply', async () => {
  const a = await sendTracked({ subject: 'needs reply', remind_hours: 1, remind_mode: 'no_reply' });
  const b = await sendTracked({ subject: 'got reply', remind_hours: 1, remind_mode: 'no_reply' });
  await S.api('PUT', `/api/emails/${b.id}`, { replied: true });
  await S.scheduler.tick(Date.now() + 2 * 3600_000);
  assert.ok(S.core.Q.get("SELECT 1 FROM events WHERE type='reminder_no_reply' AND email_id=?", a.id));
  assert.equal(S.core.Q.get("SELECT 1 x FROM events WHERE type='reminder_no_reply' AND email_id=?", b.id), undefined);
  assert.ok(S.core.Q.get("SELECT 1 FROM events WHERE type='reply' AND email_id=?", b.id));
});
