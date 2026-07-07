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

// "2026-07-06T14:32:05.123Z" -> "6 Jul 2026, 14:32 UTC"
function formatTimestamp(iso) {
  try {
    return new Date(iso)
      .toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      })
      .replace(',', '') + ' UTC';
  } catch {
    return iso;
  }
}

// Truncate long URLs so a message stays scannable.
function shorten(str, max = 60) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function formatEventMessage(site, record) {
  const lines = [];

  // Header: which site, which event, when.
  lines.push(`🔔 <b>${escapeHtml(site.name)}</b>`);
  lines.push(`<b>${escapeHtml(record.eventLabel)}</b> · <i>${escapeHtml(formatTimestamp(record.timestamp))}</i>`);

  // Location block.
  const geo = record.geo;
  const place = geo ? [geo.city, geo.region, geo.country].filter(Boolean).join(', ') : '';
  const locBits = [];
  if (place) locBits.push(`📍 ${escapeHtml(place)}`);
  locBits.push(`🖧 IP <code>${escapeHtml(record.ip)}</code>`);
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

module.exports = { sendMessage, sendLocation, verifyToken, formatEventMessage };
