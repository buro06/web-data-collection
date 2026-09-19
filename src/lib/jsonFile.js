const fs = require('fs');
const path = require('path');

// Shared plumbing for the JSON files this project uses instead of a database.
//
// Writes are serialized per logical file so two concurrent requests can't
// interleave read-modify-write cycles and lose each other's changes, and each
// write lands via a temp file + rename so a crash (or a reader racing a write)
// never sees half a JSON document.
const queues = new Map();

function queued(key, task) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next);
  return next;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { queued, readJson, writeJsonAtomic };
