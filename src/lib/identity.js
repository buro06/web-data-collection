const path = require('path');
const { ROOT } = require('./config');
const { queued, readJson, writeJsonAtomic } = require('./jsonFile');

// Puts a name to an anonymous fingerprint — the one manual step that turns
// "some browser has been here 11 times" into "Michael has been here 11 times".
//
// You only ever have to do it once. The moment a visitor identifies themselves
// (shares GPS, downloads a resume, emails you right after a visit), name the
// fingerprint; every visit before and after that moment is attributed to them
// retroactively, whether or not they ever share anything again.
//
// Names are deliberately NOT copied into the event records: resolving them at
// notification time is what makes naming apply to history too. And they're
// keyed globally rather than per-site because a fingerprint identifies the
// browser, not the site — name someone on one of your sites and they're
// recognised on all of them.
const IDENTITIES_PATH = path.join(ROOT, 'data', 'identities.json');

function readAll() {
  const data = readJson(IDENTITIES_PATH, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function get(fingerprint) {
  if (!fingerprint) return null;
  return readAll()[fingerprint] || null;
}

function nameFor(fingerprint) {
  return get(fingerprint)?.name || null;
}

function set(fingerprint, { name, note, source } = {}) {
  return queued('identities', async () => {
    const all = readAll();
    const previous = all[fingerprint] || {};
    const now = new Date().toISOString();
    all[fingerprint] = {
      name,
      note: note ?? previous.note ?? null,
      namedAt: now,
      firstNamedAt: previous.firstNamedAt || previous.namedAt || now,
      namedBy: source || previous.namedBy || null,
    };
    writeJsonAtomic(IDENTITIES_PATH, all);
    return all[fingerprint];
  });
}

function remove(fingerprint) {
  return queued('identities', async () => {
    const all = readAll();
    const removed = all[fingerprint] || null;
    if (!removed) return null;
    delete all[fingerprint];
    writeJsonAtomic(IDENTITIES_PATH, all);
    return removed;
  });
}

function list() {
  return Object.entries(readAll())
    .map(([fingerprint, entry]) => ({ fingerprint, ...entry }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

module.exports = { get, set, remove, list, nameFor, IDENTITIES_PATH };
