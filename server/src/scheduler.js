import { now, parseJSON } from './util.js';
import { mergeSettings } from './core.js';
import { buildDigest, digestDue } from './digest.js';
import { sendCampaignViaSmtp } from './routes/campaigns.js';

export function createScheduler({ core, config, mailer, log }) {
  const { Q } = core;
  let timer = null;

  async function tick(at = now()) {
    const out = { reminders: 0, digests: 0, campaigns: 0 };
    // 1) "Not opened" reminders.
    for (const e of Q.all("SELECT * FROM emails WHERE status='sent' AND remind_at IS NOT NULL AND remind_at<=? AND reminder_sent=0", at)) {
      Q.run('UPDATE emails SET reminder_sent=1 WHERE id=?', e.id);
      if (e.remind_mode === 'no_reply') {
        // Reply detection comes from the extension (Gmail API thread check) via PUT /api/emails/:id {replied:true}.
        if (e.replied_at) continue;
        core.addEvent(e.user_id, 'reminder_no_reply', { email_id: e.id, contact_email: e.contact_email, subject: e.subject, meta: { opens: e.open_count } });
        out.reminders++; continue;
      }
      if (e.open_count > 0) continue;
      core.addEvent(e.user_id, 'reminder_no_open', { email_id: e.id, contact_email: e.contact_email, subject: e.subject, meta: { recipients: parseJSON(e.recipients, []) } });
      out.reminders++;
    }
    // 2) Daily / weekly / monthly activity reports.
    for (const u of Q.all('SELECT * FROM users')) {
      const s = mergeSettings(u.settings);
      if (!digestDue(s, u.last_digest_at, at)) continue;
      const d = buildDigest(core, u, s.digest_frequency, at);
      Q.run('UPDATE users SET last_digest_at=? WHERE id=?', at, u.id);
      try { await mailer.send({ to: s.digest_email || u.email, subject: d.title, html: d.html, text: d.text }); out.digests++; }
      catch (e) { log('digest failed', e.message); }
    }
    // 3) Scheduled SMTP campaigns (Gmail-API campaigns are sent by the extension).
    for (const c of Q.all("SELECT * FROM campaigns WHERE status='scheduled' AND send_via='smtp' AND schedule_at<=?", at)) {
      try { await sendCampaignViaSmtp({ core, mailer, campaign: c }); out.campaigns++; } catch (e) { log('campaign failed', e.message); }
    }
    return out;
  }

  return {
    tick,
    start() { timer = setInterval(() => tick().catch((e) => log('scheduler', e.message)), config.schedulerIntervalMs); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}
