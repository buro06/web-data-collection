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
  var VENDOR_FP_URL = SERVER_ORIGIN + '/vendor/fingerprint.min.js';

  // How long to wait after load before firing the pageview (and, if enabled,
  // the GPS prompt) — mirrors how a search page personalises a beat after load.
  var PAGEVIEW_DELAY = toInt(scriptTag.getAttribute('data-pageview-delay'), 350);
  // Hard ceiling on the GPS wait. If the visitor approves within this window we
  // send with GPS; if they decline, ignore the prompt, or the browser stalls,
  // we give up at this point and send everything else without GPS.
  var GPS_TIMEOUT = toInt(scriptTag.getAttribute('data-gps-timeout'), 6000);

  var pageLoadTime = performance.now();
  var fingerprintPromise = null;
  var fpValue = null; // latest resolved fingerprint, or null if not ready/failed

  function toInt(val, fallback) {
    var n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
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
        resolve(
          send({
            siteId: SITE_ID,
            secret: SECRET,
            event: eventName,
            page: {
              url: window.location.href,
              referrer: document.referrer || null,
              title: document.title || null,
            },
            device: collectDevice(performance.now() - pageLoadTime),
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

  window.WDC = { track: track, trackAndGo: trackAndGo };

  if (AUTO_PAGEVIEW) {
    var firePageview = function () {
      // Small delay so the beacon's dwell time is nonzero for real page loads
      // (a lightweight speed bump against naive direct-POST spam) and so the
      // GPS prompt appears a beat after the page settles rather than instantly.
      setTimeout(function () {
        track('page_view', { requestGps: AUTO_PAGEVIEW_GPS, gpsTimeout: GPS_TIMEOUT });
      }, PAGEVIEW_DELAY);
    };
    if (document.readyState === 'complete') firePageview();
    else window.addEventListener('load', firePageview);
  }
})();
