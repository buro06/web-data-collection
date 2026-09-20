const TELEGRAM_API = 'https://api.telegram.org';

function getBotToken() {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) throw new Error('TG_BOT_TOKEN is not set in the environment');
  return token;
}

async function callApi(method, payload) {
  const token = getBotToken();
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) {
    throw new Error(`Telegram ${method} failed: ${body.description || res.status}`);
  }
  return body;
}

async function sendMessage(chatId, text) {
  return callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

// Rewrites a notification already in the chat. Used to keep the engagement
// timer on an alert current as the visit goes on, instead of posting a second
// message every time the visitor's time-on-page changes.
async function editMessageText(chatId, messageId, text) {
  return callApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

// Sends a native, interactive Telegram map pin. `accuracy` (metres) renders a
// shaded "general area" circle around the point rather than a pinpoint.
async function sendLocation(chatId, lat, lon, accuracy) {
  const payload = { chat_id: chatId, latitude: lat, longitude: lon };
  if (accuracy) {
    // Telegram accepts 0–1500m; clamp so a wildly imprecise fix still sends.
    payload.horizontal_accuracy = Math.min(Math.max(accuracy, 0), 1500);
  }
  return callApi('sendLocation', payload);
}

// Long-poll for incoming commands. `timeoutSeconds` is served by Telegram: the
// request hangs open until an update arrives or the timeout expires, so this is
// one idle connection rather than a busy poll.
async function getUpdates(offset, timeoutSeconds) {
  const body = await callApi('getUpdates', {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ['message'],
  });
  return body.result || [];
}

// Populates the "/" menu in the Telegram client so the commands are
// discoverable without remembering them.
async function setMyCommands(commands) {
  return callApi('setMyCommands', { commands });
}

async function verifyToken() {
  const token = getBotToken();
  const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram getMe failed: ${body.description || res.status}`);
  return body.result;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const TIME_ZONE = 'America/Chicago'; // US Central (CST/CDT)

// "2026-07-06T14:32:05.123Z" -> "6 Jul 2026 09:32 CDT"
// Rendered in US Central time; the CST/CDT abbreviation is resolved from the
// en-US locale (en-GB renders it as a GMT offset) and switches automatically
// with daylight saving for the given date.
function formatTimestamp(iso) {
  try {
    const date = new Date(iso);
    const datePart = date
      .toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: TIME_ZONE,
      })
      .replace(',', '');
    const zonePart = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName');
    return zonePart ? `${datePart} ${zonePart.value}` : datePart;
  } catch {
    return iso;
  }
}

// Date only, for "returning since ..." context where the clock time is noise.
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: TIME_ZONE,
    });
  } catch {
    return iso;
  }
}

// 1 -> "1st", 2 -> "2nd", 11 -> "11th", 21 -> "21st"
function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// Returns null below a second so a notification never shows a meaningless "0s".
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

// Truncate long URLs so a message stays scannable.
function shorten(str, max = 60) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// The "who is this, and have they been here before?" line. It exists so the
// answer is in the alert itself — no scrolling back through months of
// notifications to work out whether this visitor is new.
function formatVisitorLine(record, identity) {
  const bits = [];

  if (identity?.name) bits.push(`👤 <b>${escapeHtml(identity.name)}</b>`);
  else if (record.fingerprint) bits.push('👤 <i>Unidentified</i>');
  else bits.push('👤 <i>No fingerprint</i>');

  const visit = record.visit;
  if (visit) {
    bits.push(visit.number === 1 ? '<b>first visit</b>' : `<b>${ordinal(visit.number)} visit</b>`);
    if (visit.returning && visit.firstSeen) bits.push(`since ${escapeHtml(formatDate(visit.firstSeen))}`);
  }

  const engaged = formatDuration(record.engagementMs);
  if (engaged) bits.push(`⏱ ${engaged}`);

  return bits.join(' · ');
}

// `options.identity` is the stored identity entry for record.fingerprint, if
// any. It's passed in rather than looked up here so this stays a pure render —
// the engagement endpoint re-renders the very same message to update it.
function formatEventMessage(site, record, options = {}) {
  const lines = [];

  // Header: which site, which event, when, and who.
  lines.push(`🔔 <b>${escapeHtml(site.name)}</b>`);
  lines.push(`<b>${escapeHtml(record.eventLabel)}</b> · <i>${escapeHtml(formatTimestamp(record.timestamp))}</i>`);
  lines.push(formatVisitorLine(record, options.identity));

  // Location block.
  const geo = record.geo;
  const place = geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(', ') : 'No Geo data';
  const locBits = [];
  if (place) locBits.push(`📍 ${escapeHtml(place)}`);
  // Counted but never named — an IP is shared by everyone behind it, so it
  // says "how often has this connection been here", not "who".
  const ipVisit = record.ipVisit;
  locBits.push(
    `🖧 IP <code>${escapeHtml(record.ip)}</code>` +
      (ipVisit ? ` · ${ordinal(ipVisit.number)} visit from this IP` : '')
  );
  if (record.gps) {
    const { lat, lon, accuracy } = record.gps;
    const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    locBits.push(
      `🛰 GPS <a href="https://maps.google.com/?q=${lat},${lon}">${coords}</a>` +
        (accuracy ? ` <i>(±${Math.round(accuracy)}m)</i>` : '')
    );
  }
  lines.push('');
  lines.push(`<blockquote>${locBits.join('\n')}</blockquote>`);

  // Device block.
  const d = record.device || {};
  const deviceBits = [
    d.deviceType,
    d.os && `${d.os.name || ''} ${d.os.version || ''}`.trim(),
    d.browser && `${d.browser.name || ''} ${d.browser.version || ''}`.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
  const deviceLines = [];
  if (deviceBits) deviceLines.push(`📱 ${escapeHtml(deviceBits)}`);
  if (d.screen) deviceLines.push(`🖥 ${d.screen.width}×${d.screen.height} @${d.screen.pixelRatio || 1}x`);
  if (d.timezone) deviceLines.push(`🕑 ${escapeHtml(d.timezone)}`);
  if (record.fingerprint) deviceLines.push(`🆔 <code>${escapeHtml(record.fingerprint)}</code>`);
  if (deviceLines.length) {
    lines.push('');
    lines.push(`<blockquote>${deviceLines.join('\n')}</blockquote>`);
  }

  // Page context.
  const pageLines = [];
  if (record.page?.url) pageLines.push(`🔗 ${escapeHtml(shorten(record.page.url))}`);
  if (record.page?.referrer) pageLines.push(`↩️ ${escapeHtml(shorten(record.page.referrer))}`);
  if (pageLines.length) {
    lines.push('');
    lines.push(pageLines.join('\n'));
  }

  if (record.suspicious) {
    lines.push('');
    lines.push(`⚠️ <b>Flagged suspicious</b>: ${escapeHtml((record.botFlags || []).join(', '))}`);
  }

  return lines.join('\n');
}

module.exports = {
  sendMessage,
  editMessageText,
  sendLocation,
  getUpdates,
  setMyCommands,
  verifyToken,
  formatEventMessage,
  escapeHtml,
  formatTimestamp,
  formatDate,
  formatDuration,
  ordinal,
};
