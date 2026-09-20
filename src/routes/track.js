const express = require('express');
const crypto = require('crypto');

const { getConfig, getSiteById, getSites } = require('../lib/config');
const { validateSiteRequest, validateEvent, isDomainAllowed, extractHostname } = require('../lib/validateRequest');
const { isRateLimited } = require('../lib/rateLimit');
const botDetect = require('../lib/botDetect');
const geoip = require('../lib/geoip');
const { parseUserAgent } = require('../lib/useragent');
const store = require('../lib/store');
const visits = require('../lib/visits');
const identity = require('../lib/identity');
const telegram = require('../lib/telegram');

const router = express.Router();

// Engagement pings are chatty by design (one a minute during a long read, plus
// a flush whenever the tab is hidden), so they get their own, looser budget
// rather than eating into the event allowance.
const DEFAULT_ENGAGEMENT_RATE_LIMIT = { windowSeconds: 60, maxEvents: 30 };

// Nobody is actively engaged for a day; anything beyond this is a broken clock
// or a forged payload.
const MAX_ENGAGEMENT_MS = 24 * 60 * 60 * 1000;

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress;
}

function normalizeEngagement(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), MAX_ENGAGEMENT_MS);
}

// The unload beacon is sent as text/plain so it stays a CORS "simple request"
// and skips the preflight a page being torn down may not survive. Express has
// already parsed the body when it arrived as JSON.
function parseBeaconBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body || null;
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
  const { siteId, secret, event, page, device: clientDevice, fingerprint, gps, viewId } = body;

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

  const engagementMs = normalizeEngagement(body.engagementMs);
  const botResult = botDetect.evaluate({ req, config, event, client: clientDevice, engagementMs });
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
    // Identifies one page view. Several events can share it (the pageview plus
    // the clicks on that page), which is how later engagement pings find the
    // record — and how a re-sent pageview is recognised as the same one.
    viewId: typeof viewId === 'string' ? viewId.slice(0, 64) : null,
    engagementMs,
    engagementFinal: false,
    visit: null,
    ipVisit: null,
    telegramMessageId: null,
    suspicious: botResult.suspicious,
    botFlags: botResult.flags,
  };

  const outcome = await store.appendEvent(site.id, record, (rec, existing) => {
    if (visits.isDuplicate(existing, rec)) return { skip: true, reason: 'duplicate_view' };
    // Stamped inside the write lock so the counts are right even if two
    // beacons from this visitor land at the same moment. The IP is counted as
    // a second, independent handle: it can show the same person back on a new
    // browser, or that a "new" fingerprint isn't new at all.
    rec.visit = visits.summarizeBy(existing, rec, 'fingerprint');
    rec.ipVisit = visits.summarizeBy(existing, rec, 'ip');
  });

  // A re-sent pageview is not a new visit and must not fire a second alert.
  if (!outcome.stored) return res.status(204).end();

  telegram
    .sendMessage(
      site.telegramChatId,
      telegram.formatEventMessage(site, record, { identity: identity.get(record.fingerprint) })
    )
    .then((sent) => {
      // Remember which notification belongs to this event: engagement pings
      // edit it in place, and replying to it is how you name the visitor.
      const messageId = sent?.result?.message_id;
      if (messageId) {
        return store
          .updateEvent(site.id, (e) => e.id === record.id, (e) => ({ ...e, telegramMessageId: messageId }))
          .then(() => undefined);
      }
    })
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

// How long the visitor actually stayed. The pageview alert fires seconds after
// they arrive, so the engagement total isn't knowable yet — the snippet reports
// it as the visit goes on, and each ping rewrites the original alert rather
// than posting a new one.
router.post(
  '/engagement',
  express.text({ type: ['text/plain', 'application/json'], limit: '4kb' }),
  async (req, res) => {
    const config = getConfig();
    const body = parseBeaconBody(req) || {};
    const { siteId, secret, viewId, final } = body;

    if (!siteId || !secret || !viewId) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const site = getSiteById(siteId);
    const siteCheck = validateSiteRequest({ site, providedSecret: secret, req });
    if (!siteCheck.ok) {
      return res.status(403).json({ ok: false, error: siteCheck.reason });
    }

    const ip = getClientIp(req);
    const rateLimitCfg = config.engagementRateLimit || DEFAULT_ENGAGEMENT_RATE_LIMIT;
    if (isRateLimited(`${site.id}:${ip}:engagement`, rateLimitCfg)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    const engagementMs = normalizeEngagement(body.engagementMs);
    if (engagementMs === null) {
      return res.status(400).json({ ok: false, error: 'invalid_engagement' });
    }

    // Pings can arrive out of order, and engagement only ever grows — keep the
    // highest figure and don't rewrite the alert for sub-second changes.
    let changed = false;
    const updated = await store.updateEvent(
      site.id,
      (e) => e.viewId === viewId,
      (e) => {
        const current = typeof e.engagementMs === 'number' ? e.engagementMs : 0;
        const finalizing = Boolean(final) && !e.engagementFinal;
        if (engagementMs - current < 1000 && !finalizing) return null;
        changed = true;
        return {
          ...e,
          engagementMs: Math.max(engagementMs, current),
          engagementFinal: e.engagementFinal || Boolean(final),
        };
      }
    );

    if (updated && changed && updated.telegramMessageId) {
      telegram
        .editMessageText(
          site.telegramChatId,
          updated.telegramMessageId,
          telegram.formatEventMessage(site, updated, { identity: identity.get(updated.fingerprint) })
        )
        .catch((err) => {
          // Telegram rejects an edit that wouldn't change anything; harmless.
          if (!/not modified/i.test(err.message)) {
            console.error(`[telegram] failed to update alert for site ${site.id}:`, err.message);
          }
        });
    }

    res.status(204).end();
  }
);

module.exports = router;
