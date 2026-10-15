# Privacy notice: OpenEnvelope

OpenEnvelope is self-hosted software. **Whoever runs the server is the data controller**; the OpenEnvelope project itself receives no data.

## What the Chrome extension does
- Runs only on `https://mail.google.com/`.
- When you send an email with tracking on, it sends the email's **subject, recipient addresses and link URLs** to *your* server, rewrites links to tracked links and adds a 1×1 image. The email body is not sent to the server.
- Stores your server URL and API key in Chrome sync storage, and recent notification state in local storage.
- With the optional Gmail API setup, it uses `gmail.send` to send your campaign emails and `gmail.readonly` to detect replies on tracked threads and list attachments. That data is processed in your browser; only "replied: yes/no" is sent to your server.
- Blocks your own browser from loading your own tracking images, so your views aren't counted.

## What the server stores
- Tracked emails: subject, recipients, send time, links.
- Events (opens, clicks, document views, votes, signatures): time, user agent, a derived client/device label, and the visitor IP **as a salted hash by default** (`IP_MODE=hash`; `none` stores nothing, `full` stores the address). Opens through Gmail's image proxy reveal Google's servers, not the reader.
- Contacts (built from recipients), your notes and lists; uploaded documents and videos; signature audit data.

## Recipients' choices
- Recipients can block images to prevent open tracking, and unsubscribe from campaigns with the link in each campaign email.
- The account owner can mark any contact as **do not track**, **export** everything stored about them, or **erase** it (dashboard → Contacts).

## Your responsibilities as operator
Tracking email opens may require telling recipients or getting consent in some places (e.g. GDPR/ePrivacy in the EU/UK). Use HTTPS, keep `IP_SALT` and API keys secret, and set a retention policy that suits you.

## Third parties
None by default. Optional: your SMTP provider (reports, alerts, SMTP campaigns), Google's Gmail API (if you configure it), and your hosting provider.
