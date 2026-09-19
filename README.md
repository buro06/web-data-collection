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
4. Every alert says **who** the visitor is and **how many times they've been
   here** — by browser fingerprint, and by name once you've matched that
   fingerprint to a person ([section 5](#5-visitors-visit-counts-and-naming-an-identity)).
5. The alert's engagement timer keeps updating in place while they're still
   reading, so you can see how long they actually stayed
   ([section 6](#6-engagement-time-how-long-they-actually-stayed)).

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
  data-min-engagement="1000"
  data-idle-timeout="30000"
  data-engagement-ping="60000"
></script>
```

This automatically fires a `page_view` event on page load. The snippet
exposes a small global, `window.WDC`, with two methods (plus
`WDC.engagementMs()` and `WDC.viewId`, handy when debugging):

Optional timing attributes (all shown with their defaults):

- `data-pageview-delay` — milliseconds to wait after load before firing the
  automatic `page_view` (default `350`). This also delays the GPS prompt a
  beat when `data-request-gps-on-pageview="true"`, so it appears once the page
  has settled rather than the instant it opens.
- `data-gps-timeout` — the hard ceiling, in milliseconds, on how long the
  snippet waits for the visitor to answer the GPS prompt (default `6000`). See
  the GPS behavior notes below.
- `data-min-engagement` — active engagement the visitor must accumulate
  before the automatic `page_view` is sent at all (default `1000`). Set it to
  `0` to send every pageview the instant `data-pageview-delay` elapses, as
  older versions did. See
  [section 6](#6-engagement-time-how-long-they-actually-stayed).
- `data-idle-timeout` — silence for this long and the visitor stops counting
  as engaged (default `30000`).
- `data-engagement-ping` — how often the running engagement total is reported
  while the visitor is still on the page (default `60000`).

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

## 5. Visitors, visit counts, and naming an identity

Every notification opens with a line answering *who is this, and have they
been here before?*

```
🔔 My Portfolio
Page View · 19 Sep 2026 09:32 am CDT
👤 Michael · 11th visit · since 1 Jul 2026 · ⏱ 2m 14s
```

The browser fingerprint (the `🆔` line further down the alert) is a stable,
anonymous handle for one browser. It's enough to recognise a returning
visitor, but not to know *who* they are — so you tell the server, once.

**Matching a fingerprint to a person.** Say Michael visits ten times
anonymously, and on the eleventh he shares his location, downloads your
resume, or emails you a minute later. That's the moment you can attach a name
to the fingerprint with good faith — and you only ever have to do it once.
Reply to that alert in Telegram with:

```
/name Michael
```

From then on, every visit from that browser is labelled `👤 Michael`,
**including the ten that came before** — the name is resolved when the alert
is rendered, not baked into stored events. He never has to share his location
again for you to know he was there.

Names are keyed to the fingerprint itself, which belongs to the browser rather
than to any one site, so naming someone on one of your sites recognises them
on all of them. They live in `data/identities.json`.

### Telegram commands

The bot listens for commands in any chat that is already configured as some
site's `telegramChatId`. Anything from any other chat is ignored without a
reply, so the bot can't be used as a lookup oracle by whoever finds it. Only
the sites that notify *that* chat are searched.

| Command | What it does |
| --- | --- |
| `/visits <fingerprint>` | How many times that identity has visited, with first/last seen, total engaged time, event breakdown, last known location and top pages |
| `/name <fingerprint> <name>` | Match the fingerprint to a person |
| `/forget <fingerprint>` | Drop the name; the fingerprint goes back to anonymous |
| `/top [count]` | Most frequent visitors per site (default 10) |
| `/identities` | Every identity you've named |
| `/help` | The list above |

Two shortcuts worth knowing:

- **A prefix is enough.** Fingerprints are 32 hex characters; `/visits aaaabb`
  works as long as it's unambiguous (if it isn't, the bot lists the candidates).
- **Reply to an alert instead of typing a fingerprint.** Each notification's
  message id is recorded against its event, so replying to a notification with
  `/name Michael`, a bare `/visits`, or `/forget` applies to that visitor.

Commands are on by default. Turn them off with
`"telegram": { "commands": { "enabled": false } }` in `config/config.json` —
it's re-read between polls, so the switch takes effect without a restart.

> Telegram allows only one consumer of a bot's updates at a time. If you run a
> second instance (a dev server alongside production) or have a webhook set on
> the same token, the second one logs
> `another process is polling this bot token; commands are inactive here` and
> keeps sending notifications normally — only its command listening is idle.

### What counts as a "visit"

A visit is a *session*, not an event: a run of events from one fingerprint
with no gap longer than `sessionGapMinutes` (`config/config.json`, default
30). Clicking through four pages in one sitting is one visit; coming back
tomorrow is the second. The number is stamped onto each event as it's stored,
so it stays accurate even after old events age out of the capped log.

Visitors whose fingerprint failed to resolve (blocked scripts, hardened
privacy settings) show as `👤 No fingerprint` and aren't counted toward
anyone's history.

## 6. Engagement time (how long they actually stayed)

Each alert carries an `⏱` timer showing how long the visitor has been
**actively engaged** — not how long the tab was open. Time accrues only while
the page is visible *and* the visitor has interacted (or just arrived) within
`data-idle-timeout`. A tab left open in the background all afternoon adds
nothing.

The pageview alert fires seconds after someone arrives, so the total isn't
knowable yet. Instead the snippet reports the running figure as the visit goes
on — once a minute (`data-engagement-ping`), whenever the tab is hidden, and
once more when they leave — and the server **rewrites the original alert in
place** each time. One notification per visit, with a timer that keeps
climbing while they read.

### Dropping sub-second visits

The same clock filters out noise before it's ever sent: the automatic
`page_view` is withheld until the visitor has accumulated
`data-min-engagement` (default 1000ms) of active engagement. An instant
bounce, a double-fired beacon, or a page opened in a background tab and never
looked at never becomes an event, and never pings your phone.

Two more layers back that up:

- A re-sent `page_view` — same page view, same URL, within 30 seconds — is
  recognised as a duplicate and dropped without a second alert.
- Server-side, a `page_view` arriving with less engagement than
  `botDetection.minEngagementMsForPageview` (default 1000) is flagged
  `insufficient_engagement`. Since the snippet won't send one, anything that
  does is either an outdated snippet or a forged payload. It's stored and
  notified with the flag rather than dropped, so you can see it.

Explicitly tracked events (`WDC.track(...)` on a button) are never withheld —
a click is deliberate by definition.

## 7. GeoIP (IP → location) setup

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

## 8. Bot / scraper filtering

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
- Flags auto `page_view` events reporting less active engagement than
  `botDetection.minEngagementMsForPageview` (default 1000ms) — the snippet
  withholds the beacon until the visitor clears `data-min-engagement`, so keep
  the two in step. See
  [section 6](#6-engagement-time-how-long-they-actually-stayed).
- Drops re-sent pageview beacons (same page view, same URL, within 30s)
  before they're stored or notified.
- Per-site, per-IP rate limiting (default 20 events/min, configurable, plus a
  separate `engagementRateLimit` budget for engagement pings).

Flagged-but-not-blocked events are still stored/notified, with
`"suspicious": true` and a `"botFlags"` list, so you can review them rather
than silently losing data.

## 9. Running it

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

## 10. Where the data lives

Each site's events append to `data/events/<siteId>.json` as a JSON array.
Each file is capped at `maxEventsPerSite` events (`config/config.json`,
default 10000): once full, the oldest events are dropped as new ones arrive,
so a file can't grow without bound. Set it to `0` to disable the cap (and
trim/archive the files yourself).

Alongside the enriched request data, each event carries:

```json
{
  "fingerprint": "e0fcc9e99a4f92c1c57bd0b0d3b871da",
  "viewId": "7b1c…",
  "visit": {
    "number": 11,
    "eventCount": 34,
    "firstSeen": "2026-07-01T14:02:11.004Z",
    "previousSeen": "2026-09-18T22:40:09.881Z",
    "returning": true
  },
  "engagementMs": 134000,
  "engagementFinal": true,
  "telegramMessageId": 4821
}
```

- `viewId` ties the several events of one page view together, and is what a
  later engagement ping looks up.
- `visit` is the sessionized visit count as of that event.
- `telegramMessageId` is the notification this event produced — it's how the
  engagement timer edits the right alert, and how replying to an alert knows
  which visitor you mean.

Names you assign to fingerprints live in `data/identities.json`, keyed by
fingerprint and shared across every site. It's the one file here holding
data you entered rather than collected, so it's the one worth backing up.

Writes go through a per-file queue and land via a temp file + rename, so
concurrent beacons can't clobber each other and a crash mid-write can't leave
a truncated JSON file behind.

## Endpoints

- `POST /api/track` — the tracking endpoint the snippet calls.
- `POST /api/engagement` — engagement updates for a page view already logged.
  Sent as `text/plain` so the unload beacon skips the CORS preflight; same
  site secret and `allowedDomains` checks as `/api/track`.
- `GET /track.js`, `GET /vendor/fingerprint.min.js` — static client assets.
- `GET /health` — liveness check.
