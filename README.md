# ✓✓ OpenEnvelope

**Open-source email tracking for Gmail: a Chrome extension plus a small server you host yourself.**
See when your emails are opened and your links are clicked. Get desktop alerts, a dashboard, daily reports and follow-up reminders. Send mail-merge campaigns, tracked PDFs, video messages and signature requests. Nothing is ever added to your emails, and every byte of tracking data lives on your own server.

> OpenEnvelope is an independent project and is **not affiliated with, endorsed by or connected to Mailtrack or Mailsuite**. "Mailtrack" is a trademark of its owner. The feature set was planned from Mailtrack's *public* pricing and feature pages (read 15 Oct 2026) and its publicly visible behaviour. No Mailtrack code, assets or text were decompiled, copied or reused.

![Dashboard](docs/screenshots/dashboard-activity.png)

| Popup | Phone (web dashboard) | Open history |
|---|---|---|
| ![Popup](docs/screenshots/popup.png) | ![Mobile](docs/screenshots/web-dashboard-mobile.png) | ![Email detail](docs/screenshots/dashboard-email-detail.png) |

*Screenshots come from the automated end-to-end run (`e2e/`). The Gmail screenshots use a local stand-in page that copies Gmail's markup, not real Gmail. See [What is tested](#what-is-tested).*

## Features

- **Open tracking** with ✓ / ✓✓ marks in Gmail's mail list and an open-history banner inside threads
- **Full history** for every email: each open and click with time, mail client and device (where the client reveals it)
- **Link-click tracking**, plus tracked **buttons**
- **Your own opens are filtered out.** Your browser never loads your own pixel, and views of your own sent mail are labelled as yours
- **Real-time alerts:** Chrome notifications for opens, clicks, **hot conversations** (many opens fast), **revived old threads**, document and video views, signatures and poll votes. Optional email alerts
- **Reminders** if an email isn't opened (or replied to) within N days
- **Track by default** toggle, plus a per-email toggle in every compose window
- **Daily / weekly / monthly activity report** emailed at your local hour
- **Mail merge campaigns** from a CSV, a Google Sheet or a contact list. Each recipient gets their own tracked copy and an unsubscribe link. Send through your Gmail (Gmail API) or SMTP, now or scheduled. Per-recipient stats and bounce marking
- **Tracked PDFs** with time spent per page, a password, expiry, revoke and a watermark
- **Video messages:** record from the webcam or upload, with tracked views
- **E-signature requests** with an audit-trail page added to the signed PDF
- **Polls** inside emails, **templates**, a **contacts CRM** (notes, lists), **attachment list** (Gmail API)
- **Webhooks** for Zapier / Make / n8n, **CRM auto-BCC**
- **Privacy controls:** IPs hashed by default, per-contact don't-track, export and erase

### Comparison with Mailtrack

Mailtrack columns are copied from the plan table on <https://mailtrack.io/en/pricing/> as it read on **15 Oct 2026** (prices in USD, before tax). They may have changed since. ✅ done · 🟡 partial (reason given) · ❌ not included · ➖ not applicable.
Status: **29 done, 11 partial, 1 not included, 3 not applicable.**

| Feature (as listed on mailtrack.io/pricing) | Mailtrack Free | Mailtrack ($6.99/user/mo) | Mailsuite ($19.99/user/mo) | OpenEnvelope | Notes |
|---|---|---|---|---|---|
| Tracked emails | Unlimited | Unlimited | Unlimited | ✅ | Unlimited — limited only by your server |
| Open status double-check marks | ✓ | ✓ | ✓ | ✅ | ✓ sent / ✓✓ opened in the Gmail mail list, plus an open-history banner inside the thread. List rows are matched by subject (see Limitations) |
| Tracking History | Only First open | Last 7 days | Full tracking history | ✅ | Full history: every open and click with time, mail client and device (where the mail client reveals it) |
| Promotional Signature Removal | ✗ | ✓ | ✓ | ✅ | Nothing is ever added to your emails: no signature, no “sent with” line, no branding |
| See exactly who opened your group emails | ✗ | ✗ | ✓ | 🟡 | One Gmail email to several people carries one pixel, so an open can't be tied to a person. For per-person tracking, send it as a campaign: each recipient gets their own copy |
| Schedule your tracked emails | ✗ | ✗ | ✓ | 🟡 | Works with Gmail's built-in Schedule send: the pixel is inserted when you open the send-options menu. Written, but not tested in real Gmail yet |
| Activity Report | Daily Report | Daily Report | Weekly and Monthly Reports | ✅ | Daily, weekly or monthly report by email at your local hour (needs SMTP); preview in the dashboard |
| Send tracked PDFs and know time spent per page | 5 documents | 5 documents | Unlimited documents | ✅ | Unlimited. Hosted PDF viewer records views and seconds per page |
| Instant Open Alerts | ✓ | ✓ | ✓ | ✅ | Chrome desktop notifications (checked every 30 s) + toolbar badge; the web dashboard updates live |
| Old Conversation Revival Alerts | ✓ | ✓ | ✓ | ✅ | Alert when an email is reopened after N quiet days (default 7) |
| Hot Conversation Alerts: multiple opens | ✓ | ✓ | ✓ | ✅ | Alert when an email is opened N times within M minutes (default 3 in 60) |
| No-Reply Alerts | Basic | Basic | Custom alerts | 🟡 | “Not opened in X days” reminders work for every email. “No reply in X days” needs Gmail API access and the thread id, which is known for campaign emails, not yet for normal compose emails. Custom alert rules: by domain, muted contacts, thresholds, per event type |
| Instant Open Alerts via Email | ✗ | ✗ | ✓ | ✅ | Optional, through your SMTP |
| Click on link notifications | ✗ | ✗ | ✓ | ✅ |  |
| PDF Open Notifications | ✗ | ✗ | ✓ | ✅ | Also for video views and signature-request opens |
| Link clicks in your emails | 10 emails | 10 emails | Unlimited emails | ✅ | Unlimited. Unknown links are never redirected (no open-redirect) |
| Add tracked buttons inside emails | ✗ | ✗ | ✓ | ✅ | Compose menu → Insert tracked button |
| Custom domain | ✗ | ✗ | ✓ | ✅ | Self-hosted: tracking links use your own domain |
| Self-organized CRM | ✓ | ✓ | ✓ | 🟡 | Contacts are built automatically from recipients, with opens, clicks and last activity. No deals or pipeline |
| Mailing lists | ✓ | ✓ | ✓ | ✅ | Tag contacts with lists and use a list as a campaign audience |
| Contact notes | ✓ | ✓ | ✓ | ✅ |  |
| Privacy management | ✓ | ✓ | ✓ | ✅ | Per-contact don't-track, export and erase; IP stored as a salted hash, in full, or not at all |
| Sending limit | 100 emails | 100 emails | 60k emails/month | ➖ | No limit from OpenEnvelope. Gmail's own sending limits apply (Google documents about 500 recipients/day for personal accounts), or your SMTP provider's |
| Mail merge: Content personalization | ✗ | ✗ | ✓ | ✅ | CSV upload, Google Sheet link, or a contact list; {{column|fallback}} placeholders; preview |
| Schedule campaigns | ✗ | ✗ | ✓ | ✅ | SMTP campaigns are sent by the server at the scheduled time. Gmail-API campaigns go out from the extension, so Chrome must be open |
| Email Bounce detection | ✗ | ✗ | ✓ | 🟡 | Send-time rejections (Gmail API or SMTP errors) are marked as bounced and excluded later. Bounce emails that arrive afterwards (mailer-daemon) are not parsed |
| Custom Unsubscribe Links | ✗ | ✗ | ✓ | ✅ | Per-recipient unsubscribe page + List-Unsubscribe header (SMTP). Unsubscribed contacts are skipped |
| PDF sharing | 5 documents | 5 documents | Unlimited | ✅ | Unlimited |
| Access control and expiration date | ✗ | ✗ | ✓ | ✅ | Password, expiry in days, instant revoke, optional download |
| Confidential PDF Watermark | ✗ | ✗ | ✓ | ✅ | On-screen watermark with the viewer's name/email. A deterrent, not DRM |
| Send Signature Request | 5 documents | 5 documents | Unlimited | ✅ | Unlimited |
| Fill & Sign PDFs inside Gmail | ✗ | ✗ | ✓ | ❌ | Signing happens on a hosted page linked from the email (draw + type a name), not inside Gmail; no form-field filling |
| E-Signature audit trail | ✗ | ✗ | ✓ | ✅ | An audit page is appended to the signed PDF: SHA-256 of the original, timestamps, IP (per privacy mode), user agent. A simple e-signature, not a qualified/eIDAS or certificate-based one |
| Certified emails | ✗ | ✗ | ✓ | 🟡 | Downloadable PDF activity record with a SHA-256 fingerprint. Self-issued, so it is not a legal certified-delivery service |
| Email templates | ✗ | ✗ | ✓ | ✅ | Create in the dashboard, insert from the Gmail compose menu |
| Polls & Surveys via Gmail | ✗ | ✗ | ✓ | 🟡 | One-click polls inside emails with live results. Multi-question surveys not included |
| Video Messages | 5 videos | 5 videos | Unlimited | ✅ | Record from the webcam in the dashboard or upload an MP4/WebM; tracked views and watch time |
| Mobile App | ✓ | ✓ | ✓ | 🟡 | The dashboard is served by your server and works on a phone (tested at 390 px). No native app, and emails sent from the Gmail mobile app are not tracked |
| Centralized Attachment List | ✗ | ✗ | ✓ | 🟡 | Written against the Gmail API (needs your own OAuth client id); not tested, because that needs a real Gmail account |
| Favourite Attachments for quick access | ✗ | ✗ | ✓ | 🟡 | Same as above; favourites are stored locally |
| CRM auto-BCC | ✗ | ✗ | ✓ | 🟡 | Always added for Gmail-API campaigns; in normal compose only when Gmail's Bcc field is open (DOM limitation) |
| Zapier Integration | ✗ | ✗ | ✓ | ✅ | Outgoing webhook: every event is POSTed as JSON to your URL (works with Zapier “Catch Hook”, Make, n8n). Not a listed Zapier app |
| Centralized billing for teams | ✗ | ✗ | ✓ | ➖ | Free. One server can host several users, each with their own API key |
| Priority support | ✗ | ✗ | 24/7 | ➖ | Community support via GitHub issues |
| Price | $0 | $6.99 per user/month | $19.99 per user/month | Free (MIT) + your hosting | |

## How it works

```
Gmail compose ──(Chrome extension)──► POST /api/emails/:id/prepare   registers subject, recipients, links
      │                                ◄── tracked link URLs + pixel URL
      ▼  links rewritten to  https://your-server/c/<id>/<n>,  <img src="https://your-server/t/<id>.gif"> appended
  Gmail sends ──► recipient opens ──► Gmail image proxy fetches /t/<id>.gif ──► open recorded
                                       recipient clicks /c/<id>/<n> ──► 302 to the original link, click recorded
  extension polls /api/events every 30 s ──► desktop notification + ✓✓ in Gmail
  server scheduler (every minute) ──► reminders, daily/weekly reports, scheduled campaigns
```

- **extension/**: Manifest V3, plain DOM (no Gmail SDK, no remote code). `content/gmail.js` (compose toolbar, send interception, ✓/✓✓, self-open protection), `background.js` (notifications, Gmail API campaign sending, reply checks), `popup/`, `dashboard/` (also served by the server at `/app` for phones and other browsers).
- **server/**: Node 22 + Express + SQLite (Node's built-in `node:sqlite`, so nothing needs compiling). Pixel/redirect endpoints, REST API with per-user API keys, scheduler, PDF viewer (pdf.js), signing (pdf-lib), SMTP (nodemailer).

## Quick start (local)

Requirements: Node.js 22.13 or newer, Google Chrome.

```bash
cd server
npm install
npm run create-user -- you@gmail.com "Your Name"    # prints your API key (oe_...)
npm start                                           # http://localhost:8787
```

Then in Chrome go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension/` folder. The settings page opens. Paste the server URL and your API key, then **Save & test**.

⚠️ A recipient can only load your pixel if the server is reachable from the internet. `localhost` is fine for trying the extension and dashboard, but real opens need a deployed server (below) or a tunnel such as `cloudflared tunnel --url http://localhost:8787`.

## Deploy (free or low-cost)

Set these environment variables (see `server/.env.example`): `BASE_URL` (your public https URL), `IP_SALT` (a long random string), `ADMIN_TOKEN` (to create users over the API), and optionally `SMTP_URL` + `SMTP_FROM` for reports, email alerts and SMTP campaigns. SQLite lives in `DATA_DIR` (default `/data` in Docker), so give it a persistent disk.

- **Docker (anywhere):** `docker compose up -d` (uses `docker-compose.yml`, data in a named volume).
- **Fly.io:** edit the app name in `fly.toml`, then `fly launch --copy-config --no-deploy`, `fly volumes create data --size 1`, `fly secrets set IP_SALT=... ADMIN_TOKEN=... BASE_URL=https://<app>.fly.dev`, `fly deploy`.
- **Render:** "New → Blueprint", point it at your fork (uses `render.yaml`). Render's free web service sleeps when idle and has no persistent disk, so data is lost on restart. Fine for a demo; add a paid disk for real use.
- **Railway:** "Deploy from GitHub repo" (it detects the Dockerfile), add a volume mounted at `/data`, set the variables.

Free tiers and their limits change often, so check the provider's current pricing. Create your account on the server with `npm run create-user` (in a shell on the host), call `POST /api/users` with `Authorization: Bearer $ADMIN_TOKEN`, or set `SIGNUP_CODE` and use **Create account** in the extension's Settings (see below).

**Free-plan servers sleep.** Render's free plan stops the server after ~15 min idle and takes ~30-60 s to start again. The extension pings your server when Gmail loads to wake it early; if you press Send while it is still starting, the toggle shows *Waking your server…* and the email waits (up to ~45 s) and goes out tracked. If the server never answers, the email goes out untracked and a message says so.

## Share with friends

Friends can use **your** server with their own account (each person sees only their own emails):

1. **Set an invite code.** On Render: open your service → **Environment** → **Add Environment Variable** → key `SIGNUP_CODE`, value: any code you choose (e.g. `my-friends-2026`) → **Save**. Render redeploys with it. (Other hosts: set the `SIGNUP_CODE` environment variable.)
2. **Send your friend three things:** the extension ZIP (GitHub → **Code → Download ZIP**), your server URL (e.g. `https://openenvelope.onrender.com`) and the invite code.
3. **Your friend:** unzips, opens `chrome://extensions`, turns on **Developer mode**, clicks **Load unpacked** and picks the `extension` folder. In the Settings page that opens, under **New here? Create an account**, they enter the server URL, their email and the invite code, then click **Create account**. The extension saves their key and connects. Reload Gmail.

Sign-ups are limited to 10 attempts per hour per IP (`SIGNUP_RATE_LIMIT`). Anyone with the code can create an account, so share it only with people you trust; change or remove `SIGNUP_CODE` to stop new sign-ups. On Render's free plan, a restart wipes everyone's accounts and data, so use a host with a persistent disk for real use.

**SMTP with Gmail:** turn on 2-Step Verification, create an [App Password](https://myaccount.google.com/apppasswords), and set
`SMTP_URL=smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465` and `SMTP_FROM="Your Name <you@gmail.com>"`.

### Gmail API (optional: campaigns from your Gmail, reply detection, attachment list)

1. In Google Cloud Console, create a project, enable the **Gmail API**, and set up the OAuth consent screen (External, testing mode, add yourself as a test user).
2. Create an OAuth client of type **Chrome extension**, entering the extension ID shown in `chrome://extensions`.
3. Put the client ID into `extension/manifest.json` → `oauth2.client_id`, then reload the extension.

Scopes requested: `gmail.send`, `gmail.readonly`. Without this setup, everything else still works: tracking, alerts, dashboard, SMTP campaigns.

## Limitations (read these)

- **Gmail image proxy.** Gmail fetches images through Google's servers (`GoogleImageProxy`), so a Gmail open shows Google, not the reader's device, IP or city. OpenEnvelope labels these "Gmail (Google image proxy)". Country is filled in only when a CDN in front of your server adds a country header; no GeoIP database is bundled.
- **Gmail's delivery prefetch.** In a live Gmail test (2026-10-15), Gmail fetched the pixel about 2 seconds after delivery, before anyone opened the email, from Google's addresses with a fake old "Windows / Edge 12" browser name. Counted naively, every Gmail recipient looks like they opened instantly on a Windows PC in the US. OpenEnvelope logs that fetch as `prefetch` and does not count it, notify on it or use it for hot alerts (setting: *Ignore Gmail's automatic image fetch at delivery*, on by default). Real opens then arrive with the `GoogleImageProxy` agent. The Gmail mobile app can also load the pixels of several emails at once when you scroll the inbox, so one visit may register an open on more than one email.
- **Opens are a signal, not proof.** Images blocked = no open recorded. Apple Mail Privacy Protection and some security scanners pre-load images and links, which records "opens" or clicks nobody made.
- **Your own opens.** The extension blocks your browser from loading your own pixel and tells the server when you view your own sent email. Opens from your phone's Gmail app or another computer without the extension can still count.
- **Gmail's DOM is undocumented and changes.** Selectors live in one `SEL` block at the top of `extension/content/gmail.js`. The Send-button match uses English labels plus Gmail's CSS classes. Expect occasional fixes after Gmail updates.
- **✓/✓✓ in the list** is matched by subject. Two tracked emails with the same subject show the newest one's status. Inside an opened thread the status is exact (read from the pixel).
- **Only emails sent from Chrome with the extension** are tracked; Gmail's mobile apps are not.
- **Group emails** carry one pixel. Use a campaign for per-person tracking.
- **Notifications** are checked every 30 s (Chrome's minimum alarm period), so alerts are near-real-time.
- **Chrome Web Store:** publishing needs a developer account (one-time fee), a privacy policy URL (`PRIVACY.md` is a starting point) and review. Extensions that read Gmail and request Gmail scopes get closer review. Restricted Gmail scopes also need Google's OAuth verification beyond test users.
- **Legal:** tracking people's email opens is regulated in some places (e.g. GDPR/ePrivacy in the EU). Tell recipients where required. You are the data controller of your server.

## What is tested

- `cd server && npm test` runs **38 backend tests** (node:test) on a real HTTP server: auth, invite-code sign-up (wrong code, duplicate email, rate limit), pixel and proxy parsing, Gmail delivery-prefetch filtering, self-open filtering, hot/revival alerts, custom alert rules, IP modes, webhooks, activity record PDF, contacts/privacy, templates, polls, mail merge (CSV parsing, per-recipient instrumentation, unsubscribe, bounce, SMTP dry run, scheduling), no-open and no-reply reminders, digest timing, tracked PDFs (password, time per page, revoke), video, e-signature with audit trail.
- `cd e2e && npm install && npx playwright install chromium && npm run e2e` runs **45 end-to-end checks**. It starts the real server and loads the real unpacked extension into headless Chromium, with local stand-in Gmail pages (`e2e/fixtures/fake-gmail.html`, and `modern-gmail.html` whose recipient chips carry no email attributes, like today's Gmail). The checks: tracked send → pixel inserted and link rewritten → open via simulated Google image proxy → notification payload and badge → click redirect → ✓✓ in the list → own-view filtering → reminder from the live scheduler → digest → mail-merge dry run → PDF viewer and signing in the browser → popup/dashboard/phone layout → recipient capture in modern and unknown compose markup → sleeping server (slow, then down) → invite-code sign-up from Settings → no console errors. Results land in `e2e/e2e-results.json`.
- **Not yet verified in real Gmail:** the selectors against today's live Gmail, Schedule send, auto-BCC, Gmail-API sending, reply detection and the attachment list. These need a real Google account and an OAuth client. Test them with a throwaway Gmail account first.

## Project layout

```
extension/   Chrome extension (MV3): content/, background.js, popup/, dashboard/, lib/, icons/
server/      Express + SQLite backend: src/, public/ (viewer & signing pages), test/
e2e/         Playwright end-to-end check + fake Gmail fixture
examples/    sample recipients.csv and campaign.html
docs/        screenshots
```

## License

[MIT](LICENSE). Contributions welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Privacy: [PRIVACY.md](PRIVACY.md).
