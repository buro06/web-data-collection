const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const EVENTS_DIR = path.join(ROOT, 'data', 'events');

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
    fs.writeFileSync(filePath, JSON.stringify(events, null, 2));
    return record;
  });
}

module.exports = { appendEvent, filePathFor };
