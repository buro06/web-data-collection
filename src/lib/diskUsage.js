const fsp = require('fs/promises');
const path = require('path');
const { ROOT } = require('./config');

// What this install is costing on disk, and how much room is left for it.
//
// The event logs are the only part that grows on its own (which is what
// `maxEventsPerSite` exists to bound), so they're reported apart from the
// things that only change when you deploy.
const BREAKDOWN = [
  { key: 'events', label: 'Event logs', dir: path.join('data', 'events') },
  { key: 'geoip', label: 'GeoIP database', dir: path.join('data', 'geoip') },
  { key: 'dependencies', label: 'Dependencies', dir: 'node_modules' },
];

// `blocks` is what a file actually occupies, which is what `du` reports and
// what the filesystem's free space responds to. Apparent size badly
// undercounts a directory full of small JSON files.
function usedBytes(stats) {
  return typeof stats.blocks === 'number' ? stats.blocks * 512 : stats.size;
}

// Async throughout so walking node_modules doesn't stall the tracking
// endpoint. Symlinks are counted as themselves and never followed — that keeps
// the total honest and can't loop.
async function directorySize(dir, skip) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // missing or unreadable — report nothing rather than throwing
  }

  let total = 0;
  try {
    total += usedBytes(await fsp.lstat(dir));
  } catch {
    /* raced with a delete */
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (skip && skip.has(full)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await directorySize(full, skip);
      continue;
    }
    try {
      total += usedBytes(await fsp.lstat(full));
    } catch {
      /* vanished mid-walk */
    }
  }
  return total;
}

// Each region is walked exactly once: the broken-out directories are measured
// directly, then the rest of the project is walked with those paths skipped.
async function projectUsage() {
  const parts = {};
  let tracked = 0;
  for (const entry of BREAKDOWN) {
    const size = await directorySize(path.join(ROOT, entry.dir));
    parts[entry.key] = size;
    tracked += size;
  }

  const skip = new Set(BREAKDOWN.map((entry) => path.join(ROOT, entry.dir)));
  const other = await directorySize(ROOT, skip);

  return { root: ROOT, total: tracked + other, parts, other, breakdown: BREAKDOWN };
}

// Free space on the filesystem holding the project. `used` counts blocks
// reserved for root, while `available` doesn't — the same distinction `df`
// draws, which is why the two don't add up to `total`.
async function filesystemStats(target = ROOT) {
  if (typeof fsp.statfs !== 'function') return null;
  try {
    const stats = await fsp.statfs(target);
    return {
      total: stats.blocks * stats.bsize,
      available: stats.bavail * stats.bsize,
      used: (stats.blocks - stats.bfree) * stats.bsize,
    };
  } catch {
    return null;
  }
}

async function fileSize(filePath) {
  try {
    return usedBytes(await fsp.lstat(filePath));
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

module.exports = { projectUsage, filesystemStats, directorySize, fileSize, formatBytes };
