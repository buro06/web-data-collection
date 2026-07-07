// Two independent gates against endpoint spam/abuse:
//  1. Per-site secret embedded in the tracking snippet (like a GA measurement
//     ID — it's visible in page source, so it identifies a site rather than
//     truly "authenticating" it).
//  2. Server-side Origin/Referer domain allowlist per site — the real
//     defense, since a spammer replaying the secret from curl/a script still
//     has to spoof a matching Origin header, which a normal fetch()/XHR from
//     a browser cannot do.
function extractHostname(urlLike) {
  try {
    return new URL(urlLike).hostname;
  } catch {
    return null;
  }
}

function isDomainAllowed(hostname, allowedDomains) {
  if (!hostname) return false;
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function validateSiteRequest({ site, providedSecret, req }) {
  if (!site) return { ok: false, reason: 'unknown_site' };
  if (providedSecret !== site.secret) return { ok: false, reason: 'invalid_secret' };

  const origin = req.headers.origin || req.headers.referer;
  const hostname = extractHostname(origin);
  if (!isDomainAllowed(hostname, site.allowedDomains)) {
    return { ok: false, reason: 'domain_not_allowed' };
  }

  return { ok: true };
}

function validateEvent(site, eventName) {
  const eventConfig = site.events?.[eventName];
  if (!eventConfig) return { ok: false, reason: 'unknown_event' };
  return { ok: true, eventConfig };
}

module.exports = { validateSiteRequest, validateEvent, isDomainAllowed, extractHostname };
