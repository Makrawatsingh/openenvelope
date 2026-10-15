import nodemailer from 'nodemailer';

/** SMTP is optional. Without SMTP_URL, outgoing mail (digests, alerts, SMTP campaigns) is logged to the outbox table in memory and skipped. */
export function createMailer(config) {
  const sent = []; // kept for tests and the "outbox" debug endpoint
  let transport = null;
  if (config.smtpUrl === 'json') transport = nodemailer.createTransport({ jsonTransport: true });
  else if (config.smtpUrl) transport = nodemailer.createTransport(config.smtpUrl);
  return {
    enabled: !!transport,
    sent,
    async send({ to, subject, html, text, from, headers }) {
      const msg = { from: from || config.smtpFrom, to, subject, html, text, headers };
      if (!transport) { sent.push({ ...msg, skipped: 'smtp-not-configured' }); return { skipped: true }; }
      const info = await transport.sendMail(msg);
      sent.push({ ...msg, messageId: info.messageId });
      return info;
    },
  };
}
