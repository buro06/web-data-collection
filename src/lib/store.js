const path = require('path');
const { ROOT, getConfig } = require('./config');
const { queued, readJson, writeJsonAtomic } = require('./jsonFile');

const EVENTS_DIR = path.join(ROOT, 'data', 'events');

// Fallback cap if config omits maxEventsPerSite; keeps a per-site log from
// growing without bound.
const DEFAULT_MAX_EVENTS_PER_SITE = 10000;

function filePathFor(siteId) {
  return path.join(EVENTS_DIR, `${siteId}.json`);
}

function readEvents(siteId) {
  const events = readJson(filePathFor(siteId), []);
  return Array.isArray(events) ? events : [];
}

// Cap the log so it can't grow without bound; drop the oldest events, keeping
// the most recent `maxEvents`. An explicit 0 means uncapped, so the config
// value is only defaulted when it's absent — `||` would have turned 0 back
// into the default.
function capped(events) {
  const configured = getConfig().maxEventsPerSite;
  const maxEvents = typeof configured === 'number' ? configured : DEFAULT_MAX_EVENTS_PER_SITE;
  if (maxEvents > 0 && events.length > maxEvents) {
    return events.slice(events.length - maxEvents);
  }
  return events;
}

// `annotate(record, existingEvents)` runs inside the per-site write lock, so it
// sees exactly the log this record is about to join. That's what makes the
// visit number it stamps onto the record correct even when two beacons from
// the same visitor land at once. Return `{ skip: true }` to drop the record
// without writing it (used for duplicate beacons).
//
// Resolves with `{ stored, record, reason }`.
function appendEvent(siteId, record, annotate) {
  return queued(`events:${siteId}`, async () => {
    const events = readEvents(siteId);
    if (annotate) {
      const outcome = annotate(record, events);
      if (outcome && outcome.skip) {
        return { stored: false, reason: outcome.reason || 'skipped', record };
      }
    }
    events.push(record);
    writeJsonAtomic(filePathFor(siteId), capped(events));
    return { stored: true, record };
  });
}

// Patches the FIRST event matching `match` (oldest wins — for a view that's the
// beacon that created the Telegram notification). `patch(event)` returns the
// replacement event, or null to leave the file untouched. Resolves with the
// current record, or null when nothing matched.
function updateEvent(siteId, match, patch) {
  return queued(`events:${siteId}`, async () => {
    const events = readEvents(siteId);
    const index = events.findIndex(match);
    if (index === -1) return null;
    const replacement = patch(events[index]);
    if (!replacement) return events[index];
    events[index] = replacement;
    writeJsonAtomic(filePathFor(siteId), events);
    return replacement;
  });
}

module.exports = { appendEvent, updateEvent, readEvents, filePathFor };
