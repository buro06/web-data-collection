# web-data-collection

Self-hosted visitor tracking for your own sites and client sites, with
per-site Telegram notifications. No database — everything is JSON files.

## How it works

1. You embed a small `<script>` snippet (and optionally `onclick` buttons)
   on a website.
2. A visitor's browser fires an event (`page_view` automatically, or a
   custom event like `resume_download` on a button click).
3. The server validates the request actually came from a registered site,
   enriches it (IP geolocation, device/browser parsing, fingerprint), applies
   bot filtering and rate limiting, appends it to that site's JSON log, and
   sends a formatted Telegram message to the chat configured for that site.
   When the event includes GPS coordinates, it also sends a native,
   interactive Telegram map pin of the general area (accuracy circle
   included) right after the message.

## 1. Install

```bash
npm install
```

`postinstall` copies the FingerprintJS browser bundle into `public/vendor/`
automatically.

## 2. Configure the Telegram bot

Create your `.env` from the template and add a bot token (get one from
[@BotFather](https://t.me/BotFather)):

```bash
cp .env.example .env
# then edit .env and set TG_BOT_TOKEN
```

You also need a **chat ID** per destination chat (your own DM with the bot,
a group, your friend's chat, etc.):

1. Open a chat with your bot (or add it to a group) and send it any message.
2. Visit `https://api.telegram.org/bot<TG_BOT_TOKEN>/getUpdates` in a browser
   — the JSON response contains `"chat":{"id": ...}`. That number is the
   chat ID (group chat IDs are negative).
3. Put that number into `telegramChatId` in `config/sites.json` (see below).

## 3. Register a site

Copy the example to create your real config (the actual `config/sites.json`
is gitignored, so your secrets and chat IDs never get committed):

```bash
cp config/sites.example.json config/sites.json
```

Each entry:

```json
{
  "id": "my-site",
  "name": "My Portfolio",
  "secret": "some-long-random-string",
  "allowedDomains": ["yourdomain.com", "www.yourdomain.com"],
  "telegramChatId": "123456789",
  "rateLimit": { "windowSeconds": 60, "maxEvents": 20 },
  "events": {
    "page_view": { "label": "Page View", "requiresGps": false },
    "resume_download": { "label": "Resume Download", "requiresGps": false }
  }
}
```

- `id` — used in the embed snippet, must be unique.
- `secret` — embedded in the client snippet. It's visible in page source
  (like a Google Analytics ID) — it identifies the site, it does not by
  itself stop abuse. **The real anti-spam gate is `allowedDomains`**: the
  server only accepts a request if its `Origin`/`Referer` hostname matches
  one of these domains (or a subdomain of one).
- `events` — an allowlist. Any event name not listed here is rejected. Set
  `requiresGps: true` on an event to have the browser prompt for GPS
  location when that specific event fires (see below).
- `rateLimit` — optional per-site override of the global default in
  `config/config.json`.

Config files are re-read on every request, so editing `sites.json` takes
effect immediately without restarting the server.

## 4. Embed on the client website

```html
<script
  src="https://your-server.example.com/track.js"
  data-site-id="my-site"
  data-secret="some-long-random-string"
  data-auto-pageview="true"
  data-request-gps-on-pageview="false"
></script>
```

This automatically fires a `page_view` event on page load. The snippet
exposes a small global, `window.WDC`, with two methods:

### `WDC.track(eventName, options?)`

Silently sends one event. Pass `{ requestGps: true }` to prompt for location
first. Returns a promise that resolves once the beacon is sent.

```html
<!-- fire-and-forget button press, no location -->
<button onclick="WDC.track('resume_download')">Download Resume</button>

<!-- button press that prompts for location -->
<button onclick="WDC.track('contact_click', { requestGps: true })">
  Share My Location
</button>
```

### `WDC.trackAndGo(eventName, url, options?)`

For links that navigate away from your site. Fires the event (usually with
`{ requestGps: true }`), **waits** for the GPS prompt to be answered and the
beacon to be sent, and *then* redirects to `url`. A safety timer
(`maxWaitMs`, default 8s) guarantees the redirect always happens, so a stalled
prompt or slow network never traps the visitor. The `keepalive` fetch also
means the beacon survives the navigation.

**Always guard the handler with `if (window.WDC)` before calling
`event.preventDefault()`.** If the tracking server is down (or the
`track.js` request is blocked or times out), `window.WDC` is never defined.
Guarding means the click falls through to the link's normal navigation and
the visitor still reaches `url` silently — they never notice tracking failed.
Without the guard, `WDC.trackAndGo` throws *after* `preventDefault()` has
already cancelled the navigation, and the link does nothing.

```html
<a href="https://example.com/resume.pdf"
   onclick="if (window.WDC) { event.preventDefault(); WDC.trackAndGo('resume_download', this.href, { requestGps: true }); }">
  Resume
</a>
```

**React / Next.js note:** event handlers only work in Client Components, so
the button must live in a file with `'use client'` at the top. Load the
snippet with a plain `<script>` tag in the document `<head>` (in Next.js App
Router, put it in the root `layout.js`). Avoid `next/script`: it injects the
tag dynamically, which leaves `document.currentScript` null, and the current
snippet reads its `data-*` config from that tag. Guard the handler with
`if (!window.WDC) return;` before `preventDefault()` so the link still
navigates if the tracker hasn't loaded.

`requiresGps: true` in `sites.json` only controls whether the server will
*store* a GPS coordinate if one is sent with that event — it does not, by
itself, make the browser prompt for location. The client must explicitly
ask via `requestGps: true`:

- **Button-triggered events** (recommended for GPS): pass the option
  directly, so the permission prompt is tied to a real click —
  more reliable across browsers and much less likely to be reflexively
  dismissed than an unprompted page-load request.
- **The automatic `page_view`**: set `data-request-gps-on-pageview="true"`
  on the script tag (shown above) if you want every page load to prompt
  for location immediately. Off by default.

Note: `navigator.geolocation` requires a secure context (HTTPS) in every
browser except for `localhost`/`127.0.0.1`, where it's allowed over plain
HTTP for local development. Once you deploy to a real domain, the
tracking server *and* the site embedding the snippet both need HTTPS or
GPS requests will silently fail.

If the visitor denies the permission prompt or it's unavailable, the event
still sends — just without GPS coordinates (and no map pin is sent).

## 5. GeoIP (IP → location) setup

IP geolocation uses a local MaxMind GeoLite2 database (free, no per-request
API calls or rate limits). If it's missing, events are still stored/notified
normally, just without a resolved `geo` field.

1. Create a free account at MaxMind and generate a license key:
   https://www.maxmind.com/en/geolite2/signup
2. Download `GeoLite2-City.mmdb` and place it at:
   `data/geoip/GeoLite2-City.mmdb` (path configurable in
   `config/config.json` → `geoipDbPath`).
3. MaxMind updates this database periodically — re-download it every so
   often (their own tool `geoipupdate` can automate this if you want).

## 6. Bot / scraper filtering

Heuristic only, no external service:

- Blocks known crawler/tool user-agents (`config/config.json` →
  `botDetection.blockedUserAgentPatterns`) — these get a silent `204`
  response with nothing stored, so a scraper learns nothing from probing.
- Flags requests missing `Accept-Language` or reporting
  `navigator.webdriver` (default in Selenium/Puppeteer/Playwright).
- Flags auto `page_view` events that fire suspiciously fast after page
  load (`botDetection.minDwellMsForPageview`, default 300ms) — the snippet
  itself waits ~350ms before sending the automatic pageview beacon.
- Per-site, per-IP rate limiting (default 20 events/min, configurable).

Flagged-but-not-blocked events are still stored/notified, with
`"suspicious": true` and a `"botFlags"` list, so you can review them rather
than silently losing data.

## 7. Running it

```bash
npm start          # production
npm run dev         # auto-restart on file changes
```

Configurable via `config/config.json` (`port`) or `PORT` env var. Put this
behind a reverse proxy (nginx/Caddy) for HTTPS, and set `"trustProxy": true`
in `config/config.json` if you do so the real visitor IP (`X-Forwarded-For`)
is used instead of the proxy's IP. Run it long-term with `pm2` or a
`systemd` unit.

## 8. Where the data lives

Each site's events append to `data/events/<siteId>.json` as a JSON array.
Each file is capped at `maxEventsPerSite` events (`config/config.json`,
default 10000): once full, the oldest events are dropped as new ones arrive,
so a file can't grow without bound. Set it to `0` to disable the cap (and
trim/archive the files yourself).

## Endpoints

- `POST /api/track` — the tracking endpoint the snippet calls.
- `GET /track.js`, `GET /vendor/fingerprint.min.js` — static client assets.
- `GET /health` — liveness check.
