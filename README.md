# OTPGrabber

A Firefox extension (Manifest V3) that watches a linked Gmail account, finds the
newest one-time passcode (OTP), and copies it straight to your clipboard — so you
never have to open Gmail just to read a code.

## How it works

1. You connect one Gmail account with OAuth 2.0 (PKCE; Google still requires the OAuth client secret on the token exchange).
2. A background alarm polls Gmail roughly once a minute.
3. For each new message, the body is flattened to text and scored for OTP-like
   tokens. The strongest candidate wins.
4. New codes are copied to the clipboard (and optionally announced with a
   notification) and kept in a short history in the popup.

Only messages that have not been examined yet are fetched, so a poll costs about
one `messages.list` request plus one `messages.get` per new message.

## Install (temporary / development)

1. Generate the icons (once):
   ```
   npm run icons
   ```
2. Load the extension:
   ```
   npm start          # web-ext run, or:
   ```
   - Open `about:debugging#/runtime/this-firefox`
   - **Load Temporary Add-on…** and pick `manifest.json`

## Setting up the Google OAuth client

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project and **enable the Gmail API**.
2. Configure the OAuth consent screen. Add your own account as a test user.
3. Create credentials → **OAuth client ID** → application type **Desktop app**.
4. Copy the **Client ID** and **Client secret** into the extension's Options page.

That is all: a **Desktop app** client accepts the loopback redirect used by
Automatic mode with no further configuration. (The Options page shows the exact
redirect URIs under **Redirect URIs**, and offers **Copy** buttons, in case you
use a *Web application* client — then register the loopback URI there.)

> **Why the secret?** Google's token endpoint requires `client_secret` on the
> exchange even for a PKCE client registered as *Desktop app* (its docs call it
> "Optional", but Google rejects requests without it: `client_secret is missing`).
> For a desktop/installed client the secret is not treated as confidential — it
> ships in the app — so pasting it here is expected.

### Why there is no copy/paste

`identity.launchWebAuthFlow()` captures the redirect for the extension itself.
Firefox only lets an extension capture its **own** redirect URLs, so the flow
uses the loopback form:

```
http://127.0.0.1/mozoauth2/<subdomain of identity.getRedirectURL()>
```

Firefox (86+) treats that as the extension's redirect URL and closes the sign-in
window the moment Google redirects to it — nothing is copied by hand. Google
accepts loopback redirects on *Desktop app* clients without domain ownership
verification, which is exactly what the default `*.extensions.allizom.org`
redirect cannot provide.

### Redirect modes

| Mode | What happens |
| --- | --- |
| `auto` (default) | **Fully automatic.** Uses the loopback redirect above; the sign-in window closes by itself. Falls back to manual paste only if the loopback cannot be captured. |
| `extension` | Uses the published `*.extensions.allizom.org` redirect. Needs Google to have approved that domain for your client, which normally is not possible — for special builds only. |
| `manual` | Opens a tab; you paste the code (or the redirect URL) back into the popup. Last-resort fallback. |

If you already have a refresh token, paste it into Options to skip the sign-in
flow entirely.

## Standby mode

Normally the extension checks Gmail on a slow cadence to stay within the Gmail
quota. When you are actually waiting for a code, switch on **Standby** from the
popup: it polls every few seconds instead. Standby turns itself off
automatically after the configured duration, and a **Stop standby** button turns
it off immediately. Both the standby frequency and the duration are configurable
in Options; the normal frequency is separate.

| Setting | Default | Meaning |
| --- | --- | --- |
| Normal check frequency | 1 min | Cadence when standby is off. |
| Standby check frequency | 20 s | Cadence while standby is on. |
| Standby duration | 10 min | How long standby runs before it turns itself off. |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Client ID | — | Google OAuth client ID. |
| Redirect mode | auto | See above. |
| Lookback | 24 h | Only scan messages newer than this. |
| Sender filter | — | Extra Gmail search term, e.g. `from:bank.com`. |
| Include Promotions/Social | off | Scan categories that are ignored by default. |
| Code lengths | 4,5,6,7,8 | Digit counts to accept. |
| Allow alphanumeric | off | Also accept codes like `7F3K-9QX2`. |
| Min score | 30 | Candidates below this confidence are ignored. |
| Auto-copy | on | Copy new codes without asking. |
| Notify | on | Desktop notification when a code is copied. |
| Auto-fill | off | Fill on-page `one-time-code` fields (asks for site access). |

## Detection

The scanner scores every candidate against nearby keywords ("verification code",
"OTP", "2FA", …), line position, character grouping, and a pile of noise
down-weights (dates, order numbers, phone-like runs, repeated digits). Tune the
**Min score** if you get false positives or misses.

## Development

```
npm test     # syntax, HTML-id and manifest consistency checks
npm run lint # node --check on every script
npm run icons
npm start
```

## Files

- `manifest.json` — MV3 manifest, background scripts load in dependency order.
- `lib/settings.js` — validated settings store.
- `lib/otp.js` — OTP extractor / scorer.
- `lib/gmail.js` — OAuth (PKCE) + Gmail REST + MIME parsing.
- `background.js` — polling, delivery, clipboard, message router, alarms.
- `popup/` — toolbar UI.
- `options/` — full settings page.
- `content/autofill.js` — optional one-time-code field filler.
- `tools/make_icons.py`, `tools/check.js` — icon generation and project checks.
