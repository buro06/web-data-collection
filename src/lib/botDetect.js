// Heuristic-only bot/scraper filtering, no external services:
//  - known crawler/tool user-agent substrings
//  - missing headers real browsers always send
//  - client-reported navigator.webdriver (Selenium/Puppeteer default)
//  - minimum dwell time between page load and an auto-fired pageview event
//    (scripted requests that don't actually load/render the page fire instantly)
function evaluate({ req, config, event, client }) {
  const flags = [];
  const ua = (req.headers['user-agent'] || '').toLowerCase();

  if (!ua) {
    flags.push('missing_user_agent');
  } else {
    const patterns = config.botDetection.blockedUserAgentPatterns || [];
    if (patterns.some((p) => ua.includes(p.toLowerCase()))) {
      flags.push('blocked_user_agent');
    }
  }

  if (!req.headers['accept-language']) flags.push('missing_accept_language');

  if (client?.webdriver === true) flags.push('webdriver_flag');

  if (event === 'page_view' && typeof client?.dwellMs === 'number') {
    const minDwell = config.botDetection.minDwellMsForPageview ?? 0;
    if (client.dwellMs < minDwell) flags.push('insufficient_dwell_time');
  }

  return { suspicious: flags.length > 0, flags };
}

module.exports = { evaluate };
