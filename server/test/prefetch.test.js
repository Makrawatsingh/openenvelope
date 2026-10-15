
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, GMAIL_PROXY_UA } from './helpers.js';
import { isGmailPrefetch, isGoogleIp, readUA } from '../src/util.js';

// Exact headers Gmail sent in a live test on 2026-10-15, about 2.5 s after delivery, before anyone opened the mail.
const PREFETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0';

let S;
before(async () => { S = await startServer(); });
after(async () => { await S.close(); });

async function sent() {
  const r = await S.api('POST', '/api/emails/reserve');
  const p = await S.api('POST', `/api/emails/${r.body.id}/prepare`, { subject: 'Prefetch check', recipients: ['prof@iitkgp.ac.in'] });
  S.core.Q.run('UPDATE emails SET sent_at=sent_at-60000 WHERE id=?', r.body.id);
  return p.body.id;
}

test('isGmailPrefetch recognises the delivery-time fetch and not real opens', () => {
  assert.equal(isGmailPrefetch(PREFETCH_UA, '74.125.217.166', 'http://mail.google.com/'), true);
  assert.equal(isGmailPrefetch(PREFETCH_UA, '203.0.113.9', ''), true);
  assert.equal(isGmailPrefetch(GMAIL_PROXY_UA, '74.125.209.192', 'http://mail.google.com/'), false, 'GoogleImageProxy = a real open');
  assert.equal(isGmailPrefetch('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', '74.125.1.2', 'https://mail.google.com/mail/u/0/'), true);
  assert.equal(isGmailPrefetch('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', '81.2.69.160', 'https://mail.google.com/'), false);
  assert.equal(isGmailPrefetch('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', '74.125.1.2', ''), false);
  assert.equal(isGoogleIp('::ffff:66.249.84.10'), true);
  assert.equal(isGoogleIp('2401:4900::1'), false);
  assert.equal(readUA(PREFETCH_UA).device, 'Hidden by proxy');
});

test('Gmail delivery prefetch is logged but not counted, notified or used for hot alerts', async () => {
  const id = await sent();
  const seen = [];
  const fn = (uid, ev) => seen.push(ev.type);
  S.core.listeners.add(fn);
  try {
    await S.hit(`/t/${id}.gif`, PREFETCH_UA, { referer: 'http://mail.google.com/' });
    let d = await S.api('GET', `/api/emails/${id}`);
    assert.equal(d.body.open_count, 0);
    assert.equal(d.body.first_open_at, null);
    assert.ok(d.body.events.some((e) => e.type === 'prefetch'));
    const feed = await S.api('GET', '/api/events?limit=200');
    assert.ok(feed.body.every((e) => e.type !== 'prefetch'));
    // Two real opens through the proxy are the only ones counted.
    await S.hit(`/t/${id}.gif`, GMAIL_PROXY_UA);
    await S.hit(`/t/${id}.gif`, GMAIL_PROXY_UA);
    d = await S.api('GET', `/api/emails/${id}`);
    assert.equal(d.body.open_count, 2);
    assert.ok(!d.body.events.some((e) => e.type === 'hot'), 'prefetch must not push an email over the hot threshold');
    assert.ok(!seen.includes('prefetch'));
  } finally { S.core.listeners.delete(fn); }
});

test('ignore_gmail_prefetch=false counts the prefetch as an open', async () => {
  await S.api('PUT', '/api/settings', { ignore_gmail_prefetch: false });
  try {
    const id = await sent();
    await S.hit(`/t/${id}.gif`, PREFETCH_UA);
    const d = await S.api('GET', `/api/emails/${id}`);
    assert.equal(d.body.open_count, 1);
  } finally { await S.api('PUT', '/api/settings', { ignore_gmail_prefetch: true }); }
});
