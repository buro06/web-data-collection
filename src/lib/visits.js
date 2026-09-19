const { getConfig } = require('./config');

// A browser fingerprint is a stable, anonymous handle for one visitor. This
// module turns a site's flat event log into "how many times has this identity
// been here?" — the question the Telegram notification and the /visits command
// both answer.
//
// A *visit* is a session, not an event: a run of events from the same
// fingerprint with no gap longer than the session window. Clicking through four
// pages in one sitting is one visit; coming back tomorrow is two.
const DEFAULT_SESSION_GAP_MINUTES = 30;

// Two page_view beacons for the same page view are a double-fire, not a second
// visit. Anything later than this is treated as a real (e.g. SPA) navigation.
const DUPLICATE_WINDOW_MS = 30 * 1000;

function sessionGapMs() {
  const minutes = getConfig().sessionGapMinutes;
  const resolved = typeof minutes === 'number' && minutes > 0 ? minutes : DEFAULT_SESSION_GAP_MINUTES;
  return resolved * 60 * 1000;
}

function timeOf(event) {
  const t = Date.parse(event?.timestamp);
  return Number.isNaN(t) ? null : t;
}

function eventsFor(events, fingerprint) {
  if (!fingerprint) return [];
  return events.filter((e) => e.fingerprint === fingerprint);
}

function sortedTimes(events) {
  return events
    .map(timeOf)
    .filter((t) => t !== null)
    .sort((a, b) => a - b);
}

// Counts sessions in chronologically ordered timestamps.
function countVisits(times, gapMs) {
  let count = 0;
  let prev = null;
  for (const t of times) {
    if (prev === null || t - prev > gapMs) count += 1;
    prev = t;
  }
  return count;
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

// Stamped onto each record at write time so the visit number is frozen as of
// that event — it stays correct even after old events age out of the capped log.
// Returns null when there's no fingerprint to group by.
function summarize(priorEvents, record) {
  if (!record.fingerprint) return null;

  const gapMs = sessionGapMs();
  const mine = eventsFor(priorEvents, record.fingerprint);
  const times = sortedTimes(mine);
  const now = timeOf(record) ?? Date.now();
  const previous = times.length ? times[times.length - 1] : null;
  const priorVisits = countVisits(times, gapMs);

  // A new session starts this visit; otherwise this event belongs to the
  // session already in progress.
  const number = previous === null || now - previous > gapMs ? priorVisits + 1 : Math.max(priorVisits, 1);

  return {
    number,
    eventCount: mine.length + 1,
    firstSeen: times.length ? iso(times[0]) : record.timestamp,
    previousSeen: iso(previous),
    returning: number > 1,
  };
}

// Everything known about one fingerprint on one site. Null when it has never
// been seen there.
function statsFor(events, fingerprint) {
  const mine = eventsFor(events, fingerprint);
  if (!mine.length) return null;

  const times = sortedTimes(mine);
  const eventCounts = new Map();
  const pageCounts = new Map();
  // Several events can share one page view (the pageview plus the clicks on
  // it), and each carries the engagement so far — so take the highest per view
  // rather than summing, which would count the same minutes repeatedly.
  const engagementByView = new Map();
  let gpsCount = 0;
  let suspiciousCount = 0;
  let lastGps = null;
  let lastGeo = null;
  let lastDevice = null;
  let lastIp = null;

  for (const e of mine) {
    const label = e.eventLabel || e.event;
    eventCounts.set(label, (eventCounts.get(label) || 0) + 1);

    const url = e.page?.url;
    if (url) pageCounts.set(url, (pageCounts.get(url) || 0) + 1);

    if (typeof e.engagementMs === 'number' && e.engagementMs > 0) {
      const key = e.viewId || e.id;
      engagementByView.set(key, Math.max(engagementByView.get(key) || 0, e.engagementMs));
    }

    if (e.gps) {
      gpsCount += 1;
      lastGps = e.gps;
    }
    if (e.geo) lastGeo = e.geo;
    if (e.device) lastDevice = e.device;
    if (e.ip) lastIp = e.ip;
    if (e.suspicious) suspiciousCount += 1;
  }

  let engagementMs = 0;
  for (const ms of engagementByView.values()) engagementMs += ms;

  return {
    fingerprint,
    visitCount: countVisits(times, sessionGapMs()),
    eventCount: mine.length,
    firstSeen: iso(times[0]),
    lastSeen: iso(times[times.length - 1]),
    engagementMs,
    gpsCount,
    lastGps,
    lastGeo,
    lastDevice,
    lastIp,
    suspiciousCount,
    eventCounts: [...eventCounts.entries()].sort((a, b) => b[1] - a[1]),
    topPages: [...pageCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// Every fingerprint seen on a site, most visits first.
function topVisitors(events, limit = 10) {
  const byFingerprint = new Map();
  for (const e of events) {
    if (!e.fingerprint) continue;
    if (!byFingerprint.has(e.fingerprint)) byFingerprint.set(e.fingerprint, []);
    byFingerprint.get(e.fingerprint).push(e);
  }

  const gapMs = sessionGapMs();
  const rows = [...byFingerprint.entries()].map(([fingerprint, mine]) => {
    const times = sortedTimes(mine);
    return {
      fingerprint,
      visitCount: countVisits(times, gapMs),
      eventCount: mine.length,
      firstSeen: iso(times[0]),
      lastSeen: iso(times[times.length - 1]),
      lastSeenMs: times[times.length - 1] ?? 0,
    };
  });

  rows.sort((a, b) => b.visitCount - a.visitCount || b.eventCount - a.eventCount || b.lastSeenMs - a.lastSeenMs);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

// Notifications print the full 32-character fingerprint, but nobody wants to
// retype it — accept any unambiguous prefix.
function resolveFingerprint(events, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const seen = new Set();
  for (const e of events) {
    if (e.fingerprint) seen.add(e.fingerprint);
  }
  if (seen.has(q)) return [q];
  return [...seen].filter((fp) => fp.toLowerCase().startsWith(q));
}

// True when this beacon is a re-send of a page view already logged: same page
// view id, same event, same URL, moments apart.
function isDuplicate(events, record) {
  if (!record.viewId || record.event !== 'page_view') return false;
  const now = timeOf(record) ?? Date.now();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    const t = timeOf(e);
    if (t !== null && now - t > DUPLICATE_WINDOW_MS) break;
    if (e.viewId === record.viewId && e.event === record.event && e.page?.url === record.page?.url) {
      return true;
    }
  }
  return false;
}

module.exports = { summarize, statsFor, topVisitors, resolveFingerprint, isDuplicate, countVisits };
