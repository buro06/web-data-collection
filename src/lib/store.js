const fs = require('fs');
const path = require('path');
const { ROOT, getConfig } = require('./config');

const EVENTS_DIR = path.join(ROOT, 'data', 'events');

// Fallback cap if config omits maxEventsPerSite; keeps a per-site log from
// growing without bound.
const DEFAULT_MAX_EVENTS_PER_SITE = 10000;

// Serialize writes per-file so concurrent requests for the same site don't
// interleave read-modify-write cycles and drop events.
const writeQueues = new Map();

function queueWrite(siteId, task) {
  const prev = writeQueues.get(siteId) || Promise.resolve();
  const next = prev.then(task, task);
  writeQueues.set(siteId, next);
  return next;
}

function filePathFor(siteId) {
  return path.join(EVENTS_DIR, `${siteId}.json`);
}

function appendEvent(siteId, record) {
  return queueWrite(siteId, async () => {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    const filePath = filePathFor(siteId);
    let events = [];
    if (fs.existsSync(filePath)) {
      try {
        events = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        events = [];
      }
    }
    events.push(record);

    // Cap the log so it can't grow without bound; drop the oldest events,
    // keeping the most recent `maxEvents`.
    const maxEvents = getConfig().maxEventsPerSite || DEFAULT_MAX_EVENTS_PER_SITE;
    if (maxEvents > 0 && events.length > maxEvents) {
      events = events.slice(events.length - maxEvents);
    }

    fs.writeFileSync(filePath, JSON.stringify(events, null, 2));
    return record;
  });
}

module.exports = { appendEvent, filePathFor };
