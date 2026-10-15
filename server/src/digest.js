import { escapeHtml, now, parseJSON } from './util.js';

const PERIOD_MS = { daily: 86400_000, weekly: 7 * 86400_000, monthly: 30 * 86400_000 };

/** Activity report for one user: opens/clicks in the period, unopened emails, top links. */
export function buildDigest(core, user, period = 'daily', at = now()) {
  const { Q } = core;
  const since = at - (PERIOD_MS[period] || PERIOD_MS.daily);
  const sent = Q.all("SELECT * FROM emails WHERE user_id=? AND status='sent' AND sent_at>=? AND sent_at<=?", user.id, since, at);
  const opens = Q.all("SELECT ev.*, e.subject FROM events ev JOIN emails e ON e.id=ev.email_id WHERE ev.user_id=? AND ev.type='open' AND ev.ts>=? AND ev.ts<=?", user.id, since, at);
  const clicks = Q.all("SELECT ev.*, e.subject FROM events ev JOIN emails e ON e.id=ev.email_id WHERE ev.user_id=? AND ev.type='click' AND ev.ts>=? AND ev.ts<=?", user.id, since, at);
  const unopened = Q.all("SELECT * FROM emails WHERE user_id=? AND status='sent' AND open_count=0 AND sent_at>=? ORDER BY sent_at DESC LIMIT 20", user.id, at - 14 * 86400_000);
  const docViews = Q.all('SELECT v.*, d.name FROM doc_views v JOIN documents d ON d.id=v.doc_id WHERE d.user_id=? AND v.started_at>=?', user.id, since);
  const byEmail = {};
  for (const o of opens) (byEmail[o.email_id] ||= { subject: o.subject, n: 0, last: 0 }), byEmail[o.email_id].n++, (byEmail[o.email_id].last = Math.max(byEmail[o.email_id].last, o.ts));
  const top = Object.values(byEmail).sort((a, b) => b.n - a.n).slice(0, 10);
  const opened = sent.filter((e) => e.open_count > 0).length;
  const summary = { period, since, until: at, sent: sent.length, opened_of_sent: opened, opens: opens.length, clicks: clicks.length,
    unopened: unopened.map((e) => ({ id: e.id, subject: e.subject, recipients: parseJSON(e.recipients, []), sent_at: e.sent_at })),
    most_opened: top, document_views: docViews.length };
  const title = `Your OpenEnvelope ${period} report`;
  const li = (s) => `<li style="margin:4px 0">${s}</li>`;
  const html = `<div style="font:14px/1.5 system-ui,Arial;max-width:560px;color:#222">
<h2 style="margin:0 0 8px">✓✓ ${title}</h2>
<p style="color:#555">${new Date(since).toUTCString()} → ${new Date(at).toUTCString()}</p>
<table style="border-collapse:collapse;margin:8px 0 16px"><tr>
${[['Sent', sent.length], ['Opened', `${opened}/${sent.length}`], ['Opens', opens.length], ['Clicks', clicks.length], ['Doc views', docViews.length]]
  .map(([k, v]) => `<td style="padding:8px 14px;border:1px solid #eee;text-align:center"><div style="font-size:20px;font-weight:700">${v}</div><div style="color:#777;font-size:12px">${k}</div></td>`).join('')}
</tr></table>
<h3>Most opened</h3><ul>${top.map((t) => li(`${escapeHtml(t.subject || '(no subject)')} — ${t.n} open${t.n > 1 ? 's' : ''}`)).join('') || li('No opens in this period')}</ul>
<h3>Not opened yet (last 14 days)</h3><ul>${unopened.map((e) => li(`${escapeHtml(e.subject || '(no subject)')} → ${escapeHtml(parseJSON(e.recipients, []).join(', '))}`)).join('') || li('Everything was opened 🎉')}</ul>
<p style="color:#999;font-size:12px">Opens are counted from image loads; Gmail and Apple Mail proxies hide the reader's device and location. Sent by your own OpenEnvelope server.</p></div>`;
  const text = `${title}\nSent ${sent.length}, opened ${opened}, opens ${opens.length}, clicks ${clicks.length}\n\nNot opened:\n` + summary.unopened.map((e) => `- ${e.subject}`).join('\n');
  return { title, summary, html, text };
}

/** Is a digest due for this user now? Uses the user's timezone and preferred hour. */
export function digestDue(settings, lastAt, at = now()) {
  const f = settings.digest_frequency;
  if (!f || f === 'off') return false;
  let hour, weekday, day;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone || 'UTC', hour: 'numeric', hourCycle: 'h23', weekday: 'short', day: 'numeric' })
      .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    hour = Number(parts.hour); weekday = parts.weekday; day = Number(parts.day);
  } catch { hour = new Date(at).getUTCHours(); weekday = 'Mon'; day = 1; }
  if (hour !== Number(settings.digest_hour ?? 8)) return false;
  if (f === 'weekly' && weekday !== 'Mon') return false;
  if (f === 'monthly' && day !== 1) return false;
  return at - (lastAt || 0) > 20 * 3600_000; // at most once per day-window
}
