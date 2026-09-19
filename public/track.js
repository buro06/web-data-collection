(function () {
  'use strict';

  var scriptTag = document.currentScript;
  if (!scriptTag) return;

  var SITE_ID = scriptTag.getAttribute('data-site-id');
  var SECRET = scriptTag.getAttribute('data-secret');
  var AUTO_PAGEVIEW = scriptTag.getAttribute('data-auto-pageview') !== 'false';
  var AUTO_PAGEVIEW_GPS = scriptTag.getAttribute('data-request-gps-on-pageview') === 'true';
  var SERVER_ORIGIN = new URL(scriptTag.src).origin;
  var TRACK_URL = SERVER_ORIGIN + '/api/track';
  var ENGAGEMENT_URL = SERVER_ORIGIN + '/api/engagement';
  var VENDOR_FP_URL = SERVER_ORIGIN + '/vendor/fingerprint.min.js';

  // How long to wait after load before firing the pageview (and, if enabled,
  // the GPS prompt) — mirrors how a search page personalises a beat after load.
  var PAGEVIEW_DELAY = toInt(scriptTag.getAttribute('data-pageview-delay'), 350);
  // Hard ceiling on the GPS wait. If the visitor approves within this window we
  // send with GPS; if they decline, ignore the prompt, or the browser stalls,
  // we give up at this point and send everything else without GPS.
  var GPS_TIMEOUT = toInt(scriptTag.getAttribute('data-gps-timeout'), 6000);
  // Active engagement the visitor must accumulate before the automatic
  // pageview is sent at all. Instant bounces, background prerenders and
  // double-fired beacons never reach it, so they never become events.
  var MIN_ENGAGEMENT = toInt(scriptTag.getAttribute('data-min-engagement'), 1000);
  // Silence for this long and the visitor is treated as no longer engaged.
  var IDLE_TIMEOUT = toInt(scriptTag.getAttribute('data-idle-timeout'), 30000);
  // How often the running engagement total is reported while they're still here.
  var ENGAGEMENT_PING = toInt(scriptTag.getAttribute('data-engagement-ping'), 60000);

  var pageLoadTime = performance.now();
  var fingerprintPromise = null;
  var fpValue = null; // latest resolved fingerprint, or null if not ready/failed
  // Identifies this page view across every beacon it produces, so the server
  // can attach later engagement reports to the event it already logged.
  var VIEW_ID = randomId();

  function toInt(val, fallback) {
    var n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
  }

  function randomId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
      if (window.crypto && crypto.getRandomValues) {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.prototype.map
          .call(bytes, function (b) {
            return ('0' + b.toString(16)).slice(-2);
          })
          .join('');
      }
    } catch (e) {
      /* fall through */
    }
    return String(Date.now()) + Math.random().toString(16).slice(2, 10);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function getFingerprint() {
    if (fingerprintPromise) return fingerprintPromise;
    fingerprintPromise = loadScript(VENDOR_FP_URL)
      .then(function () {
        return window.FingerprintJS.load();
      })
      .then(function (fp) {
        return fp.get();
      })
      .then(function (result) {
        fpValue = result.visitorId;
        return result.visitorId;
      })
      .catch(function () {
        fpValue = null;
        return null;
      });
    return fingerprintPromise;
  }

  // ---------------------------------------------------------------------
  // Active engagement
  //
  // Wall-clock time on a page says little — a tab can sit open for hours in
  // the background. "Engaged" means the page is visible AND the visitor has
  // done something (or only just arrived) within IDLE_TIMEOUT, so the number
  // reported is closer to attention than to elapsed time.
  //
  // Time is accounted at state transitions rather than on a ticking interval,
  // so an idle page costs nothing.
  // ---------------------------------------------------------------------
  var engagedMs = 0;
  var activeSince = null; // start of the stretch currently being counted
  var lastInteraction = Date.now();
  var idleTimer = null;

  function isEngaged() {
    return document.visibilityState !== 'hidden' && Date.now() - lastInteraction < IDLE_TIMEOUT;
  }

  function engagementMs() {
    if (activeSince === null) return Math.round(engagedMs);
    // An unnoticed idle-out ends the stretch when the visitor went quiet, not now.
    var end = Math.min(Date.now(), lastInteraction + IDLE_TIMEOUT);
    return Math.round(engagedMs + Math.max(0, end - activeSince));
  }

  function refreshEngagement(interacted) {
    var now = Date.now();
    if (interacted) lastInteraction = now;

    if (isEngaged()) {
      if (activeSince === null) activeSince = now;
      clearTimeout(idleTimer);
      // Wake up once when the idle window expires, to close the stretch.
      idleTimer = setTimeout(function () {
        refreshEngagement(false);
      }, Math.max(lastInteraction + IDLE_TIMEOUT - now, 0) + 50);
    } else if (activeSince !== null) {
      engagedMs = engagementMs();
      activeSince = null;
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click', 'wheel'].forEach(function (type) {
    window.addEventListener(
      type,
      function () {
        refreshEngagement(true);
      },
      { passive: true, capture: true }
    );
  });

  document.addEventListener('visibilitychange', function () {
    // Coming back to the tab counts as engagement; leaving closes the stretch.
    refreshEngagement(document.visibilityState !== 'hidden');
    if (document.visibilityState === 'hidden') reportEngagement({ force: true });
  });

  refreshEngagement(false);

  // Runs `cb` once the visitor has been engaged for `ms`, and never if they
  // leave first. Polls only while waiting, then stops — for a visible page
  // that is about a second. A tab opened in the background accrues nothing, so
  // its pageview waits (throttled by the browser) until the visitor actually
  // looks at it, and is abandoned if they never do.
  function whenEngagedFor(ms, cb) {
    if (engagementMs() >= ms) return cb();
    var giveUpAt = Date.now() + 30 * 60 * 1000;
    var timer = setInterval(function () {
      if (engagementMs() >= ms) {
        clearInterval(timer);
        cb();
      } else if (Date.now() > giveUpAt) {
        clearInterval(timer);
      }
    }, 200);
  }

  var viewReported = false; // an event exists server-side for VIEW_ID
  var lastReportedMs = 0;
  var finalReportSent = false;
  var REPORT_STEP_MS = 5000;

  // Reports the running engagement total. The server rewrites the original
  // Telegram alert in place, so a long visit updates its own notification
  // instead of producing a stream of new ones.
  function reportEngagement(options) {
    options = options || {};
    if (!viewReported || finalReportSent) return;

    var ms = engagementMs();
    var delta = ms - lastReportedMs;
    if (!options.final && delta < (options.force ? 1000 : REPORT_STEP_MS)) return;

    lastReportedMs = ms;
    if (options.final) finalReportSent = true;

    var payload = JSON.stringify({
      siteId: SITE_ID,
      secret: SECRET,
      viewId: VIEW_ID,
      engagementMs: ms,
      final: Boolean(options.final),
    });

    // text/plain keeps this a CORS "simple request": no preflight, which a
    // page being torn down may not stay alive long enough to complete.
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(ENGAGEMENT_URL, blob)) return;
      }
    } catch (e) {
      /* fall through to fetch */
    }
    fetch(ENGAGEMENT_URL, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: payload,
      keepalive: true,
    }).catch(function () {});
  }

  setInterval(function () {
    reportEngagement({});
  }, ENGAGEMENT_PING);

  window.addEventListener('pagehide', function () {
    reportEngagement({ final: true });
  });

  function getTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      return null;
    }
  }

  function collectDevice(dwellMs) {
    return {
      screen: {
        width: screen.width,
        height: screen.height,
        pixelRatio: window.devicePixelRatio || 1,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      language: navigator.language || null,
      timezone: getTimezone(),
      platform: navigator.platform || null,
      webdriver: navigator.webdriver === true,
      dwellMs: dwellMs,
    };
  }

  // Resolves with GPS coords if the visitor approves within `timeoutMs`,
  // otherwise resolves null (declined, no support, or timed out). A manual
  // hard timer backs up the geolocation `timeout` option because some browsers
  // never fire success/error while the permission prompt sits unanswered.
  function getGps(timeoutMs) {
    timeoutMs = timeoutMs || GPS_TIMEOUT;
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      var done = false;
      var finish = function (val) {
        if (done) return;
        done = true;
        clearTimeout(hardTimer);
        resolve(val);
      };
      var hardTimer = setTimeout(function () {
        finish(null);
      }, timeoutMs);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          finish({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        function () {
          finish(null);
        },
        { timeout: timeoutMs, maximumAge: 60000 }
      );
    });
  }

  // keepalive lets the request outlive a navigation, so the beacon still
  // arrives even if the page redirects immediately after. Returns the fetch
  // promise so callers can wait for it.
  function send(payload) {
    return fetch(TRACK_URL, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(function () {});
  }

  // options: { requestGps: boolean, gpsTimeout: number } — requestGps should
  // mirror the event's `requiresGps` flag in the server's config. If true, the
  // browser's native geolocation prompt is triggered and we wait up to
  // `gpsTimeout` ms for an answer before sending without GPS.
  //
  // Exactly ONE beacon is sent per call (guarded by `sent`). If the visitor
  // leaves the page before answering the prompt, a `pagehide` handler flushes
  // the beacon immediately (without GPS) so the pageview is never lost. GPS is
  // attached only when granted in time; declines/timeouts still send the rest.
  //
  // Returns a promise that resolves once the beacon has been dispatched.
  function track(eventName, options) {
    options = options || {};
    getFingerprint(); // kick off fingerprinting so fpValue is ready in time

    return new Promise(function (resolve) {
      var sent = false;

      function cleanup() {
        window.removeEventListener('pagehide', onHide);
      }

      function dispatch(gps) {
        cleanup();
        // Later engagement reports have something to attach to from here on.
        viewReported = true;
        resolve(
          send({
            siteId: SITE_ID,
            secret: SECRET,
            event: eventName,
            viewId: VIEW_ID,
            page: {
              url: window.location.href,
              referrer: document.referrer || null,
              title: document.title || null,
            },
            device: collectDevice(performance.now() - pageLoadTime),
            engagementMs: engagementMs(),
            fingerprint: fpValue,
            gps: gps || null,
          })
        );
      }

      // urgent=true (page unloading): send now with whatever fingerprint we
      // have. Otherwise wait for the fingerprint if it isn't ready yet.
      function finalize(gps, urgent) {
        if (sent) return;
        sent = true;
        if (!urgent && fpValue === null && fingerprintPromise) {
          fingerprintPromise.then(function () {
            dispatch(gps);
          });
        } else {
          dispatch(gps);
        }
      }

      function onHide() {
        finalize(null, true);
      }

      if (options.requestGps) {
        window.addEventListener('pagehide', onHide);
        getGps(options.gpsTimeout).then(function (gps) {
          finalize(gps, false);
        });
      } else {
        finalize(null, false);
      }
    });
  }

  // Fire an event (typically with requestGps) and THEN navigate to `url`.
  // Waits for the GPS prompt to be answered and the beacon to be sent before
  // redirecting, but is guaranteed to navigate within `maxWaitMs` (default 8s)
  // so a stalled prompt or slow network never traps the visitor on the page.
  function trackAndGo(eventName, url, options) {
    options = options || {};
    var navigated = false;
    var go = function () {
      if (navigated) return;
      navigated = true;
      window.location.href = url;
    };
    // Give the navigation ceiling enough headroom to clear the GPS wait,
    // so a redirect doesn't cut off a prompt the visitor is still answering.
    var timer = setTimeout(go, options.maxWaitMs || GPS_TIMEOUT + 2000);
    track(eventName, options).then(function () {
      clearTimeout(timer);
      go();
    });
  }

  window.WDC = { track: track, trackAndGo: trackAndGo, engagementMs: engagementMs, viewId: VIEW_ID };

  if (AUTO_PAGEVIEW) {
    var firePageview = function () {
      // Small delay so the beacon's dwell time is nonzero for real page loads
      // (a lightweight speed bump against naive direct-POST spam) and so the
      // GPS prompt appears a beat after the page settles rather than instantly.
      setTimeout(function () {
        // ...then hold it until the visit is real. A visitor who bounces before
        // MIN_ENGAGEMENT never produces an event at all.
        whenEngagedFor(MIN_ENGAGEMENT, function () {
          track('page_view', { requestGps: AUTO_PAGEVIEW_GPS, gpsTimeout: GPS_TIMEOUT });
        });
      }, PAGEVIEW_DELAY);
    };
    if (document.readyState === 'complete') firePageview();
    else window.addEventListener('load', firePageview);
  }
})();
