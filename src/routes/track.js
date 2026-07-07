const express = require('express');
const crypto = require('crypto');

const { getConfig, getSiteById, getSites } = require('../lib/config');
const { validateSiteRequest, validateEvent, isDomainAllowed, extractHostname } = require('../lib/validateRequest');
const { isRateLimited } = require('../lib/rateLimit');
const botDetect = require('../lib/botDetect');
const geoip = require('../lib/geoip');
const { parseUserAgent } = require('../lib/useragent');
const store = require('../lib/store');
const telegram = require('../lib/telegram');

const router = express.Router();

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress;
}

// CORS: the tracking snippet runs on arbitrary client-site origins, so we
// allow any Origin that matches *some* registered site's allowedDomains.
// The actual site+secret+domain match is re-checked per-request below;
// this only controls whether the browser will let the page read the response.
router.use((req, res, next) => {
  const origin = req.headers.origin;
  const hostname = extractHostname(origin);
  if (hostname) {
    const allSites = getSites();
    const allowed = allSites.some((s) => isDomainAllowed(hostname, s.allowedDomains));
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.post('/track', async (req, res) => {
  const config = getConfig();
  const body = req.body || {};
  const { siteId, secret, event, page, device: clientDevice, fingerprint, gps } = body;

  if (!siteId || !secret || !event) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  const site = getSiteById(siteId);
  const siteCheck = validateSiteRequest({ site, providedSecret: secret, req });
  if (!siteCheck.ok) {
    return res.status(403).json({ ok: false, error: siteCheck.reason });
  }

  const eventCheck = validateEvent(site, event);
  if (!eventCheck.ok) {
    return res.status(400).json({ ok: false, error: eventCheck.reason });
  }

  const ip = getClientIp(req);
  const rateLimitCfg = site.rateLimit || config.defaultRateLimit;
  if (isRateLimited(`${site.id}:${ip}`, rateLimitCfg)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const botResult = botDetect.evaluate({ req, config, event, client: clientDevice });
  if (botResult.flags.includes('blocked_user_agent')) {
    // Known crawler/tool UA: silently accept-and-drop rather than 403, so a
    // scraper doesn't learn anything useful from the response.
    return res.status(204).end();
  }

  const geo = await geoip.lookup(ip);
  const uaInfo = parseUserAgent(req.headers['user-agent']);

  const record = {
    id: crypto.randomUUID(),
    siteId: site.id,
    event,
    eventLabel: eventCheck.eventConfig.label || event,
    timestamp: new Date().toISOString(),
    ip,
    geo,
    gps: eventCheck.eventConfig.requiresGps && gps ? gps : null,
    page: {
      url: page?.url || null,
      referrer: page?.referrer || null,
      title: page?.title || null,
    },
    device: {
      ...uaInfo,
      screen: clientDevice?.screen || null,
      viewport: clientDevice?.viewport || null,
      language: clientDevice?.language || null,
      timezone: clientDevice?.timezone || null,
      platform: clientDevice?.platform || null,
    },
    fingerprint: fingerprint || null,
    suspicious: botResult.suspicious,
    botFlags: botResult.flags,
  };

  await store.appendEvent(site.id, record);

  telegram
    .sendMessage(site.telegramChatId, telegram.formatEventMessage(site, record))
    .then(() => {
      // Follow the notification with a native interactive map pin of the
      // general area when the visitor shared GPS.
      if (record.gps) {
        return telegram.sendLocation(
          site.telegramChatId,
          record.gps.lat,
          record.gps.lon,
          record.gps.accuracy
        );
      }
    })
    .catch((err) => console.error(`[telegram] failed to notify for site ${site.id}:`, err.message));

  res.status(204).end();
});

module.exports = router;
