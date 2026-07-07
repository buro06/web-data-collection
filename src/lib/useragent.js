const { UAParser } = require('ua-parser-js');

function parseUserAgent(uaString) {
  const parser = new UAParser(uaString || '');
  const result = parser.getResult();
  const deviceType = result.device.type || 'desktop';
  return {
    userAgent: uaString || null,
    browser: { name: result.browser.name || null, version: result.browser.version || null },
    os: { name: result.os.name || null, version: result.os.version || null },
    deviceType,
  };
}

module.exports = { parseUserAgent };
