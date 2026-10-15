import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const post = (S, body, headers = {}) => fetch(S.base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('invite-code signup: right code creates an account, wrong/missing code is refused', async () => {
  const S = await startServer({ signupCode: 'friends-2026' });
  try {
    const wrong = await post(S, { email: 'a@b.co', invite_code: 'nope' });
    assert.equal(wrong.status, 403);
    assert.match((await wrong.json()).error, /wrong invite code/i);
    const missing = await post(S, { email: 'a@b.co' });
    assert.equal(missing.status, 403);
    assert.match((await missing.json()).error, /invite code is required/i);
    const ok = await post(S, { email: ' Friend@Gmail.com ', name: 'Friend', invite_code: 'friends-2026' });
    assert.equal(ok.status, 201);
    const j = await ok.json();
    assert.equal(j.email, 'friend@gmail.com');
    assert.match(j.api_key, /^oe_/);
    const me = await fetch(S.base + '/api/me', { headers: { authorization: `Bearer ${j.api_key}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).email, 'friend@gmail.com');
    // the new user does not see the owner's data
    const list = await fetch(S.base + '/api/emails', { headers: { authorization: `Bearer ${j.api_key}` } });
    assert.deepEqual(await list.json(), []);
  } finally { await S.close(); }
});

test('invite-code signup: duplicate email returns 409 with a clear message (case-insensitive)', async () => {
  const S = await startServer({ signupCode: 'c0de' });
  try {
    assert.equal((await post(S, { email: 'dup@x.io', invite_code: 'c0de' })).status, 201);
    const again = await post(S, { email: 'DUP@x.io', invite_code: 'c0de' });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /already exists/i);
    const owner = await post(S, { email: 'me@example.com', invite_code: 'c0de' });
    assert.equal(owner.status, 409);
  } finally { await S.close(); }
});

test('invite-code signup: invalid email is a 400', async () => {
  const S = await startServer({ signupCode: 'c0de' });
  try { assert.equal((await post(S, { email: 'not-an-email', invite_code: 'c0de' })).status, 400); } finally { await S.close(); }
});

test('signup is rate limited per IP (admin token is exempt)', async () => {
  const S = await startServer({ signupCode: 'c0de', signupRateLimit: 3 });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(S, { email: `r${i}@x.io`, invite_code: 'bad' })).status);
    assert.deepEqual(codes, [403, 403, 403, 429, 429]);
    const right = await post(S, { email: 'late@x.io', invite_code: 'c0de' });
    assert.equal(right.status, 429, 'still limited even with the right code');
    const admin = await post(S, { email: 'admin-made@x.io' }, { authorization: 'Bearer admin-secret' });
    assert.equal(admin.status, 201);
  } finally { await S.close(); }
});

test('without SIGNUP_CODE the old behaviour holds (admin token or ALLOW_SIGNUP)', async () => {
  const S = await startServer();
  try {
    assert.equal((await post(S, { email: 'x@y.zz', invite_code: 'anything' })).status, 403);
    assert.equal((await post(S, { email: 'x@y.zz' }, { authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await post(S, { email: 'x@y.zz' }, { authorization: 'Bearer admin-secret' })).status, 201);
  } finally { await S.close(); }
  const O = await startServer({ allowSignup: true });
  try { assert.equal((await post(O, { email: 'open@y.zz' })).status, 201); } finally { await O.close(); }
});
