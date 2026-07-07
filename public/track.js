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

  var pageLoadTime = performance.now();
  var fingerprintPromise = null;

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
        return result.visitorId;
      })
      .catch(function () {
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

  function getGps(timeoutMs) {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          resolve({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        function () {
          resolve(null);
        },
        { timeout: timeoutMs || 5000, maximumAge: 60000 }
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

  // options: { requestGps: boolean } — should mirror the event's
  // `requiresGps` flag in the server's config. If true, the
  // browser's native geolocation permission prompt is triggered.
  // Returns a promise that resolves once the beacon has been dispatched
  // (after the GPS prompt is answered or times out).
  function track(eventName, options) {
    options = options || {};
    var dwellMs = performance.now() - pageLoadTime;

    return Promise.all([
      getFingerprint(),
      options.requestGps ? getGps() : Promise.resolve(null),
    ]).then(function (results) {
      var fingerprint = results[0];
      var gps = results[1];

      return send({
        siteId: SITE_ID,
        secret: SECRET,
        event: eventName,
        page: {
          url: window.location.href,
          referrer: document.referrer || null,
          title: document.title || null,
        },
        device: collectDevice(dwellMs),
        fingerprint: fingerprint,
        gps: gps,
      });
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
    var timer = setTimeout(go, options.maxWaitMs || 8000);
    track(eventName, options).then(function () {
      clearTimeout(timer);
      go();
    });
  }

  window.WDC = { track: track, trackAndGo: trackAndGo };

  if (AUTO_PAGEVIEW) {
    var firePageview = function () {
      // Small delay so the beacon's dwell time is nonzero for real page
      // loads — a lightweight speed bump against naive direct-POST spam.
      setTimeout(function () {
        track('page_view', { requestGps: AUTO_PAGEVIEW_GPS });
      }, 350);
    };
    if (document.readyState === 'complete') firePageview();
    else window.addEventListener('load', firePageview);
  }
})();
