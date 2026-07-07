const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'config.json');
const SITES_PATH = path.join(ROOT, 'config', 'sites.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Config/sites are re-read on every call (not cached) so editing the JSON
// files by hand takes effect without restarting the server.
function getConfig() {
  return readJson(CONFIG_PATH);
}

function getSites() {
  return readJson(SITES_PATH).sites;
}

function getSiteById(siteId) {
  return getSites().find((s) => s.id === siteId) || null;
}

module.exports = { ROOT, getConfig, getSites, getSiteById };
