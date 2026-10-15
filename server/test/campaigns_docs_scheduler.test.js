import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, samplePdf, SIG_PNG } from './helpers.js';
import { parseCSV, renderTemplate } from '../src/util.js';
import { digestDue } from '../src/digest.js';
import { mergeSettings } from '../src/core.js';

let S;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

const CSV = 'Email,First Name,Company\nasha@example.com,Asha,"Acme, Inc."\nravi@example.com,Ravi,\nbad-address,Nope,X\nasha@example.com,Dup,Y\n';

test('CSV parser handles quotes, commas and blank cells; templates support fallbacks', () => {
  const rows = parseCSV(CSV);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].Company, 'Acme, Inc.');
  assert.equal(renderTemplate('Hi {{first_name}} from {{company|your team}}', rows[1]), 'Hi Ravi from your team');
});

test('campaign preview renders the first row', async () => {
  const r = await S.api('POST', '/api/campaigns/preview', { subject: 'Hello {{First Name}}', body: '<p>Hi {{first_name}}</p>', csv: CSV });
  assert.equal(r.body.subject, 'Hello Asha');
  assert.equal(r.body.count, 4);
});

let campaignId;
test('mail merge campaign: per-recipient tracked copies, invalid and duplicate rows skipped', async () => {
  const r = await S.api('POST', '/api/campaigns', { name: 'Internship outreach', subject: 'Hi {{First Name}}',
    body: '<p>Hello {{first_name|there}}, see <a href="https://example.com/cv.pdf">my CV</a>.</p>', csv: CSV, send_via: 'gmail' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  campaignId = r.body.id;
  assert.equal(r.body.recipients, 2);
  assert.deepEqual(r.body.skipped.map((s) => s.reason).sort(), ['duplicate', 'invalid email']);
  const out = await S.api('GET', `/api/campaigns/${campaignId}/outbox`);
  assert.equal(out.body.messages.length, 2);
  const m = out.body.messages[0];
  assert.equal(m.subject, 'Hi Asha');
  assert.match(m.html, new RegExp(`/t/${m.email_id}\\.gif`), 'own pixel');
  assert.match(m.html, new RegExp(`/c/${m.email_id}/0`), 'own tracked link');
  assert.match(m.html, new RegExp(`/u/${m.email_id}`), 'own unsubscribe link');
  assert.doesNotMatch(m.html, /OpenEnvelope|Mailtrack/i, 'no branding / promotional signature is ever added');
});

test('extension reports Gmail send results; opens, bounces and unsubscribes show in campaign stats', async () => {
  const out = await S.api('GET', `/api/campaigns/${campaignId}/outbox`);
  const [a, b] = out.body.messages;
  await S.api('POST', `/api/campaigns/${campaignId}/result`, { email_id: a.email_id, ok: true, thread_id: 't1', message_id: 'm1' });
  await S.api('POST', `/api/campaigns/${campaignId}/result`, { email_id: b.email_id, ok: false, error: '550 No such user' });
  S.core.Q.run('UPDATE emails SET sent_at=sent_at-60000 WHERE id=?', a.email_id);
  await S.hit(`/t/${a.email_id}.gif`);
  await fetch(`${S.base}/c/${a.email_id}/0`, { redirect: 'manual' });
  const u = await fetch(`${S.base}/u/${a.email_id}`, { method: 'POST' });
  assert.equal(u.status, 200);
  const c = await S.api('GET', `/api/campaigns/${campaignId}`);
  assert.deepEqual({ ...c.body.stats }, { total: 2, sent: 1, queued: 0, bounced: 1, opened: 1, clicked: 1, unsubscribed: 1 });
  assert.equal(c.body.status, 'sent');
  // unsubscribed contacts are skipped in the next campaign
  const r2 = await S.api('POST', '/api/campaigns', { subject: 'Again', body: 'x', rows: [{ email: 'asha@example.com' }, { email: 'new@example.com' }] });
  assert.equal(r2.body.recipients, 1);
  assert.equal(r2.body.skipped[0].reason, 'unsubscribed');
});

test('SMTP campaign (dry-run JSON transport) sends each personalised copy with List-Unsubscribe', async () => {
  const r = await S.api('POST', '/api/campaigns', { subject: 'Yo {{name}}', body: '<p>Hi {{name}}</p>', rows: [{ email: 'k@example.com', name: 'K' }, { email: 'l@example.com', name: 'L' }], send_via: 'smtp' });
  const before = S.mailer.sent.length;
  const s = await S.api('POST', `/api/campaigns/${r.body.id}/send`);
  assert.deepEqual(s.body, { sent: 2, failed: 0 });
  const msgs = S.mailer.sent.slice(before);
  assert.deepEqual(msgs.map((m) => m.subject).sort(), ['Yo K', 'Yo L']);
  assert.match(msgs[0].headers['List-Unsubscribe'], /\/u\//);
});

test('scheduled SMTP campaign is sent by the scheduler when due', async () => {
  const r = await S.api('POST', '/api/campaigns', { subject: 'Later', body: 'later', rows: [{ email: 'sched@example.com' }], send_via: 'smtp', schedule_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(r.body.status, 'scheduled');
  let t = await S.scheduler.tick();
  assert.equal(t.campaigns, 0);
  t = await S.scheduler.tick(Date.now() + 2 * 3600_000);
  assert.equal(t.campaigns, 1);
});

test('"not opened" reminder fires once when due and not for opened emails', async () => {
  const a = (await S.api('POST', '/api/emails/reserve')).body.id;
  await S.api('POST', `/api/emails/${a}/prepare`, { subject: 'Remind me', recipients: ['r@x.com'], remind_hours: 1 });
  const b = (await S.api('POST', '/api/emails/reserve')).body.id;
  await S.api('POST', `/api/emails/${b}/prepare`, { subject: 'Opened already', recipients: ['o@x.com'], remind_hours: 1 });
  S.core.Q.run('UPDATE emails SET sent_at=sent_at-60000 WHERE id=?', b);
  await S.hit(`/t/${b}.gif`);
  const t1 = await S.scheduler.tick(Date.now() + 2 * 3600_000);
  assert.equal(t1.reminders, 1);
  const t2 = await S.scheduler.tick(Date.now() + 3 * 3600_000);
  assert.equal(t2.reminders, 0);
  const ev = S.core.Q.get("SELECT * FROM events WHERE type='reminder_no_open' AND email_id=?", a);
  assert.ok(ev);
});

test('daily digest: preview renders and the scheduler emails it at the chosen local hour', async () => {
  const p = await S.api('GET', '/api/digest/preview?period=daily');
  assert.match(p.body.html, /Your OpenEnvelope daily report/);
  assert.ok(p.body.summary.sent >= 1);
  const s = mergeSettings(JSON.stringify({ digest_hour: 8, timezone: 'Asia/Kolkata' }));
  const at8IST = Date.UTC(2026, 9, 16, 2, 40); // 08:10 IST
  assert.equal(digestDue(s, 0, at8IST), true);
  assert.equal(digestDue(s, at8IST - 3600_000, at8IST), false, 'not twice in a day');
  assert.equal(digestDue(s, 0, at8IST + 3600_000), false, 'wrong hour');
  assert.equal(digestDue({ ...s, digest_frequency: 'off' }, 0, at8IST), false);
  const before = S.mailer.sent.length;
  const t = await S.scheduler.tick(at8IST);
  assert.equal(t.digests, 1);
  assert.equal(S.mailer.sent[before].subject, 'Your OpenEnvelope daily report');
  assert.equal(S.mailer.sent[before].to, 'me@example.com');
});

test('tracked PDF: password, viewer session, time per page, expiry', async () => {
  const pdf = await samplePdf(2);
  const up = await S.api('POST', '/api/documents?name=proposal.pdf&password=s3cret&watermark=Confidential%20for%20{viewer}', pdf, { 'content-type': 'application/pdf' });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const id = up.body.id;
  const page = await fetch(`${S.base}/d/${id}?r=client@corp.com`).then((r) => r.text());
  assert.match(page, /data-needs-password="true"/);
  const wrong = await fetch(`${S.base}/d/${id}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
  assert.equal(wrong.status, 403);
  const open = await fetch(`${S.base}/d/${id}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 's3cret', viewer: 'client@corp.com' }) }).then((r) => r.json());
  assert.equal(open.watermark, 'Confidential for client@corp.com');
  const file = await fetch(S.base + open.file_url);
  assert.equal(file.status, 200);
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await fetch(`${S.base}/d/${id}/file?s=forged`)).status, 403);
  for (const [p, sec] of [[1, 5], [1, 4], [2, 12]]) await fetch(`${S.base}/d/${id}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ s: open.session, page: p, seconds: sec }) });
  const d = await S.api('GET', `/api/documents/${id}`);
  assert.deepEqual(d.body.seconds_per_page, { 1: 9, 2: 12 });
  assert.equal(d.body.views, 1);
  assert.ok(S.core.Q.get("SELECT * FROM events WHERE type='doc_view' AND ref_id=?", id));
  await S.api('PUT', `/api/documents/${id}`, { revoke: true });
  assert.equal((await fetch(`${S.base}/d/${id}`)).status, 410);
  assert.equal((await fetch(S.base + open.file_url)).status, 403);
});

test('video message upload + view tracking', async () => {
  const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
  const up = await S.api('POST', '/api/documents?name=hello.webm', fakeWebm, { 'content-type': 'video/webm' });
  assert.equal(up.body.kind, 'video');
  const open = await fetch(`${S.base}/d/${up.body.id}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  assert.equal(open.kind, 'video');
  assert.ok(S.core.Q.get("SELECT * FROM events WHERE type='video_view' AND ref_id=?", up.body.id));
});

test('e-signature request: view, sign, audit trail page, signed PDF download', async () => {
  const pdf = await samplePdf(1);
  const up = await S.api('POST', '/api/documents?name=nda.pdf', pdf, { 'content-type': 'application/pdf' });
  const sr = await S.api('POST', '/api/sign-requests', { document_id: up.body.id, signer_name: 'Asha', signer_email: 'asha@example.com' });
  assert.equal(sr.status, 201);
  const token = new URL(sr.body.sign_url).pathname.split('/').pop();
  const pg = await fetch(`${S.base}/s/${token}`);
  assert.match(await pg.text(), /Signature request: nda\.pdf/);
  const bad = await fetch(`${S.base}/s/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Asha' }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${S.base}/s/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Asha K', agree: true, signature: SIG_PNG }) });
  assert.equal(ok.status, 200);
  const list = await S.api('GET', '/api/sign-requests');
  const row = list.body.find((x) => x.id === sr.body.id);
  assert.equal(row.status, 'signed');
  assert.deepEqual(row.audit.map((a) => a.event), ['created', 'viewed', 'signed']);
  const signed = await S.api('GET', `/api/sign-requests/${sr.body.id}/signed.pdf`);
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(signed.body);
  assert.equal(doc.getPageCount(), 2, 'original page + audit trail page');
  const again = await fetch(`${S.base}/s/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', agree: true, signature: SIG_PNG }) });
  assert.equal(again.status, 409);
});

test('non-PDF upload rejected; served dashboard and pdf.js are reachable', async () => {
  const r = await S.api('POST', '/api/documents', Buffer.from('hello'), { 'content-type': 'application/pdf' });
  assert.equal(r.status, 400);
  assert.equal((await fetch(`${S.base}/vendor/pdfjs/pdf.min.mjs`)).status, 200);
});
