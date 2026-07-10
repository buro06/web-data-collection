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
   included) right after the message. Message timestamps are rendered in US
   Central time (CST/CDT, `America/Chicago`), adjusting for daylight saving
   automatically.

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
  data-pageview-delay="350"
  data-gps-timeout="6000"
></script>
```

This automatically fires a `page_view` event on page load. The snippet
exposes a small global, `window.WDC`, with two methods:

Optional timing attributes (both shown with their defaults):

- `data-pageview-delay` — milliseconds to wait after load before firing the
  automatic `page_view` (default `350`). This also delays the GPS prompt a
  beat when `data-request-gps-on-pageview="true"`, so it appears once the page
  has settled rather than the instant it opens.
- `data-gps-timeout` — the hard ceiling, in milliseconds, on how long the
  snippet waits for the visitor to answer the GPS prompt (default `6000`). See
  the GPS behavior notes below.

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
(`maxWaitMs`, default `data-gps-timeout` + 2s, i.e. 8s out of the box)
guarantees the redirect always happens, so a stalled prompt or slow network
never traps the visitor. The `keepalive` fetch also means the beacon survives
the navigation.

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

**GPS behavior — how the wait resolves.** Whenever an event requests GPS, the
snippet sends **exactly one** beacon and never blocks indefinitely:

- **Approves in time** → the beacon is sent with GPS coordinates (and the
  server follows up with a map pin).
- **Declines** → the beacon is sent immediately without GPS.
- **Ignores the prompt** → a hard timeout (`data-gps-timeout`, default 6s)
  fires and the beacon is sent without GPS. This backstops browsers that never
  fire a callback while a permission prompt sits unanswered.
- **Leaves the page before answering** → a `pagehide` handler flushes the
  beacon (without GPS) so the `page_view` is never lost. (A plain tab-switch
  does *not* flush, so a prompt the visitor may still answer isn't cut off.)

In every case the non-GPS data (device, fingerprint, geo, page context) is
sent; GPS is simply attached only when granted in time.

## 5. GeoIP (IP → location) setup

IP geolocation uses a local MaxMind GeoLite2 database (free, no per-request
API calls or rate limits). If it's missing, events are still stored/notified
normally, just without a resolved `geo` field — the Telegram message shows
`📍 No Geo data` in that case.

1. Create a free account at MaxMind and generate a license key:
   https://www.maxmind.com/en/geolite2/signup
2. Download `GeoLite2-City.mmdb` and place it at:
   `data/geoip/GeoLite2-City.mmdb` (path configurable in
   `config/config.json` → `geoipDbPath`).
3. MaxMind updates this database periodically — re-download it every so
   often (their own tool `geoipupdate` can automate this if you want).

> **Deploying:** the whole `data/` directory is gitignored (it holds the DB
> and your event logs), so `git push` does **not** carry the database to your
> server. You must provision `GeoLite2-City.mmdb` on the server separately —
> e.g. `scp` it up, or download it there with `geoipupdate`. A common gotcha is
> IPs resolving locally but every production notification showing
> `No Geo data` because the server has no database file. (Don't commit the
> `.mmdb` to a public repo — MaxMind's license forbids redistributing it.)

## 6. Bot / scraper filtering

Heuristic only, no external service:

- Blocks known crawler/tool user-agents (`config/config.json` →
  `botDetection.blockedUserAgentPatterns`) — these get a silent `204`
  response with nothing stored, so a scraper learns nothing from probing.
- Flags requests missing `Accept-Language` or reporting
  `navigator.webdriver` (default in Selenium/Puppeteer/Playwright).
- Flags auto `page_view` events that fire suspiciously fast after page
  load (`botDetection.minDwellMsForPageview`, default 300ms) — the snippet
  itself waits `data-pageview-delay` ms (default 350) before sending the
  automatic pageview beacon, so keep that delay above this threshold.
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
behind a reverse proxy (nginx/Caddy) for HTTPS. `"trustProxy"` defaults to
`true` in `config/config.json` so the real visitor IP is read from
`X-Forwarded-For` (which Caddy's `reverse_proxy` sets automatically) instead
of the proxy's own IP — required for correct IPs *and* GeoIP location. Only
set it to `false` if the app is exposed directly to visitors with no proxy in
front (otherwise a client could spoof its IP via a forged header). Run it
long-term with `pm2` or a `systemd` unit.

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
