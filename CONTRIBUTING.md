# Contributing to OpenEnvelope

Thanks for helping! Bug reports, Gmail-selector fixes and features are all welcome.

## Setup
```bash
cd server && npm install && npm test          # backend tests
cd ../e2e && npm install && npx playwright install chromium && npm run e2e   # end-to-end
```
Load `extension/` unpacked in `chrome://extensions` (Developer mode) and point it at your local server.

## Guidelines
- **Gmail broke?** Most fixes are in the `SEL` block at the top of `extension/content/gmail.js`. Please include the Gmail UI language and a description of the DOM you saw.
- Keep the extension dependency-free and Manifest V3 compliant: no remote code, no `eval`.
- Keep the server light: Node built-ins first, and a new dependency needs a reason.
- Add or update a test in `server/test/` for every backend change; keep `npm test` and `npm run e2e` green.
- **Clean-room rule:** do not copy code, text, icons or other assets from Mailtrack/Mailsuite or any other proprietary product. Public documentation and observed behaviour are fine as inspiration; implementations must be your own.
- Privacy first: anything that stores personal data must respect `ip_mode`, do-not-track and contact erase.

## Pull requests
1. Fork and branch from `main`.
2. `npm test` (server) passes; describe what you tested in Gmail, if anything.
3. One topic per PR, with a clear description. By contributing you agree your work is released under the MIT license.
