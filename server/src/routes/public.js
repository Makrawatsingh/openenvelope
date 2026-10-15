import express from 'express';
import { now, newId, parseJSON, escapeHtml, sha256, clientIp } from '../util.js';

export const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial;max-width:560px;margin:56px auto;padding:0 18px;color:#202124}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#1a73e8;color:#fff;cursor:pointer}button:focus-visible{outline:3px solid #fbbc04}
.muted{color:#5f6368;font-size:14px}</style></head><body>${body}</body></html>`;

/** Unsubscribe and poll-vote pages that recipients land on. */
export function publicPages({ core, config }) {
  const r = express.Router();
  const { Q } = core;

  r.get('/u/:emailId', (req, res) => {
    const e = Q.get('SELECT contact_email FROM emails WHERE id=?', req.params.emailId);
    if (!e?.contact_email) return res.status(404).type('html').send(page('Not found', '<p>This link is not valid.</p>'));
    res.type('html').send(page('Unsubscribe', `<h1>Unsubscribe</h1><p>Stop receiving these emails at <b>${escapeHtml(e.contact_email)}</b>?</p>
      <form method="post"><button type="submit">Unsubscribe</button></form>`));
  });
  r.post('/u/:emailId', (req, res) => {
    const e = Q.get('SELECT * FROM emails WHERE id=?', req.params.emailId);
    if (!e?.contact_email) return res.status(404).type('html').send(page('Not found', '<p>This link is not valid.</p>'));
    Q.run('UPDATE contacts SET unsubscribed=1 WHERE user_id=? AND email=?', e.user_id, e.contact_email);
    core.addEvent(e.user_id, 'unsubscribe', { email_id: e.id, contact_email: e.contact_email, ref_id: e.campaign_id, subject: e.subject });
    res.type('html').send(page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${escapeHtml(e.contact_email)} won't get further campaign emails from this sender.</p>`));
  });

  r.get('/p/:pollId/:idx', (req, res) => {
    const p = Q.get('SELECT * FROM polls WHERE id=?', req.params.pollId);
    const opts = parseJSON(p?.options, []);
    const idx = Number(req.params.idx);
    if (!p || !(idx >= 0 && idx < opts.length)) return res.status(404).type('html').send(page('Not found', '<p>This poll link is not valid.</p>'));
    // One vote per (proxy-hidden) voter is best effort: keyed by a hash of IP+UA, a later click changes the vote.
    const voter = req.query.v ? String(req.query.v) : sha256(clientIp(req) + '|' + (req.headers['user-agent'] || '')).slice(0, 20);
    Q.run('INSERT INTO poll_votes (poll_id, option_idx, voter, ts) VALUES (?,?,?,?) ON CONFLICT(poll_id, voter) DO UPDATE SET option_idx=excluded.option_idx, ts=excluded.ts', p.id, idx, voter, now());
    core.addEvent(p.user_id, 'poll_vote', { ref_id: p.id, meta: { question: p.question, option: opts[idx] } }, { req });
    res.type('html').send(page('Thanks', `<h1>Thanks!</h1><p>Your answer “${escapeHtml(opts[idx])}” was recorded.</p>`));
  });
  return r;
}
