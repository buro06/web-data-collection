const fs = require('fs');
const path = require('path');
const maxmind = require('maxmind');
const { ROOT, getConfig } = require('./config');

let readerPromise = null;
let loadedPath = null;

async function getReader() {
  const dbPath = path.join(ROOT, getConfig().geoipDbPath);
  if (readerPromise && loadedPath === dbPath) return readerPromise;

  if (!fs.existsSync(dbPath)) {
    readerPromise = Promise.resolve(null);
    loadedPath = dbPath;
    return readerPromise;
  }

  loadedPath = dbPath;
  readerPromise = maxmind.open(dbPath).catch((err) => {
    console.error(`[geoip] failed to open ${dbPath}:`, err.message);
    return null;
  });
  return readerPromise;
}

// Returns null fields when the GeoLite2 database isn't installed yet, rather
// than throwing — geo enrichment is best-effort, not required to accept events.
async function lookup(ip) {
  const reader = await getReader();
  if (!reader) return null;
  try {
    const result = reader.get(ip);
    if (!result) return null;
    return {
      country: result.country?.names?.en || null,
      countryCode: result.country?.iso_code || null,
      region: result.subdivisions?.[0]?.names?.en || null,
      city: result.city?.names?.en || null,
      lat: result.location?.latitude ?? null,
      lon: result.location?.longitude ?? null,
      timezone: result.location?.time_zone || null,
    };
  } catch {
    return null;
  }
}

module.exports = { lookup };
