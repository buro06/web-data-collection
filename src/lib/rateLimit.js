// In-memory sliding-window rate limiter, keyed per site+IP. Good enough for
// a single-process Node server; resets on restart, which is an acceptable
// tradeoff given the JSON-file-based, no-external-DB scope of this project.
const hits = new Map();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of hits) {
    const fresh = timestamps.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
  }
}, CLEANUP_INTERVAL_MS).unref();

function isRateLimited(key, { windowSeconds, maxEvents }) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const timestamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  hits.set(key, timestamps);
  return timestamps.length > maxEvents;
}

module.exports = { isRateLimited };
