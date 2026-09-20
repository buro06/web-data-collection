const path = require('path');

const { getConfig, getSites } = require('./config');
const store = require('./store');
const visits = require('./visits');
const identity = require('./identity');
const diskUsage = require('./diskUsage');
const telegram = require('./telegram');

// Answers "how many times has this identity visited my website?" on demand, in
// the same chat the notifications arrive in — so the answer is a command away
// instead of a scroll back through the notification history.
//
// The bot long-polls for messages. Only chats already configured as a site's
// `telegramChatId` are answered; anyone else who finds the bot gets silence,
// so it can't be used as a lookup oracle for visitor data.
const POLL_TIMEOUT_SECONDS = 50;
const ERROR_BACKOFF_MS = 15000;
const MAX_LIST_ROWS = 25;
// Names go in the header line of every future alert — keep them scannable.
const MAX_NAME_LENGTH = 64;

const COMMAND_MENU = [
  { command: 'visits', description: 'Visit history for a fingerprint (or reply to an alert)' },
  { command: 'name', description: 'Name a fingerprint: /name <fp> Michael, or reply with /name Michael' },
  { command: 'forget', description: 'Remove the name from a fingerprint' },
  { command: 'top', description: 'Most frequent visitors: /top [count]' },
  { command: 'identities', description: 'List every named identity' },
  { command: 'usage', description: 'Disk space this install uses, and what is left' },
  { command: 'help', description: 'Show these commands' },
];

const HELP = [
  '<b>Visitor commands</b>',
  '',
  '<code>/visits &lt;fingerprint&gt;</code> — how many times that identity has visited',
  '<code>/name &lt;fingerprint&gt; &lt;name&gt;</code> — match the fingerprint to a person',
  '<code>/forget &lt;fingerprint&gt;</code> — drop the name again',
  '<code>/top [count]</code> — most frequent visitors per site',
  '<code>/identities</code> — every identity you have named',
  '<code>/usage</code> — disk space used, and what is left on the filesystem',
  '',
  'A few characters of a fingerprint is enough, as long as it is unambiguous.',
  '',
  '<b>Or just reply to an alert.</b> Reply to a notification with ' +
    '<code>/name Michael</code> or a bare <code>/visits</code> and the ' +
    'fingerprint is taken from the alert you replied to.',
].join('\n');

let polling = false;
let offset = 0;
let conflictLogged = false;

function commandsEnabled() {
  return getConfig().telegram?.commands?.enabled !== false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function start() {
  if (polling) return;
  if (!commandsEnabled()) return;
  if (!process.env.TG_BOT_TOKEN) {
    console.warn('[telegram] TG_BOT_TOKEN is not set — bot commands are disabled');
    return;
  }
  polling = true;
  telegram
    .setMyCommands(COMMAND_MENU)
    .catch((err) => console.error('[telegram] setMyCommands failed:', err.message));
  loop().catch((err) => {
    polling = false;
    console.error('[telegram] command listener stopped:', err.message);
  });
  console.log('[telegram] listening for bot commands');
}

function stop() {
  polling = false;
}

async function loop() {
  while (polling) {
    // Re-checked each pass so flipping the flag in config.json takes effect
    // without a restart, like every other setting in this project.
    if (!commandsEnabled()) {
      await sleep(5000);
      continue;
    }
    try {
      const updates = await telegram.getUpdates(offset, POLL_TIMEOUT_SECONDS);
      conflictLogged = false;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error('[telegram] command failed:', err.message);
        }
      }
    } catch (err) {
      // A 409 means something else is already polling this token (a second
      // instance, or a webhook). Say so once rather than every 15 seconds.
      const conflict = /conflict/i.test(err.message);
      if (!conflict || !conflictLogged) {
        console.error('[telegram] getUpdates failed:', err.message);
        if (conflict) {
          console.error('[telegram] another process is polling this bot token; commands are inactive here');
          conflictLogged = true;
        }
      }
      await sleep(ERROR_BACKOFF_MS);
    }
  }
}

function parseCommand(text) {
  // "/name@my_bot abc123 Michael" -> { name: 'name', args: 'abc123 Michael' }
  const match = /^\/([A-Za-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message?.text) return;

  const chatId = String(message.chat.id);
  const sites = getSites().filter((s) => String(s.telegramChatId) === chatId);
  if (!sites.length) return;

  const command = parseCommand(message.text);
  if (!command) return;

  switch (command.name) {
    case 'visits':
    case 'whois':
    case 'who':
      return cmdVisits(sites, chatId, command.args, message);
    case 'name':
    case 'identify':
      return cmdName(sites, chatId, command.args, message);
    case 'forget':
    case 'unname':
      return cmdForget(sites, chatId, command.args, message);
    case 'top':
    case 'visitors':
      return cmdTop(sites, chatId, command.args);
    case 'identities':
    case 'names':
      return cmdIdentities(sites, chatId);
    case 'usage':
    case 'disk':
      return cmdUsage(sites, chatId);
    case 'help':
    case 'start':
      return telegram.sendMessage(chatId, HELP);
    default:
      return undefined;
  }
}

const esc = telegram.escapeHtml;

function shortFp(fingerprint) {
  return fingerprint.length > 12 ? `${fingerprint.slice(0, 12)}…` : fingerprint;
}

// Prefix-matches a fingerprint against everything this chat can see: the event
// logs of its sites, plus any identity already named. A full-length id that
// matches nothing is still accepted, so a fingerprint copied from an old alert
// can be named after its events have aged out of the capped log.
function resolveAcrossSites(sites, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { matches: [] };

  const known = new Set();
  for (const site of sites) {
    for (const fingerprint of visits.resolveFingerprint(store.readEvents(site.id), q)) {
      known.add(fingerprint);
    }
  }
  for (const entry of identity.list()) {
    if (entry.fingerprint.toLowerCase().startsWith(q)) known.add(entry.fingerprint);
  }

  const matches = [...known];
  if (!matches.length && /^[0-9a-f]{16,}$/i.test(q)) return { matches: [q], unseen: true };
  return { matches };
}

// The fingerprint behind the alert a command replied to. Each notification's
// message_id is stamped onto its event record precisely so this lookup works.
function fingerprintFromReply(sites, message) {
  const replyTo = message.reply_to_message;
  if (!replyTo) return null;
  for (const site of sites) {
    const events = store.readEvents(site.id);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].telegramMessageId === replyTo.message_id) return events[i].fingerprint || null;
    }
  }
  return null;
}

// Resolves the fingerprint a command is about, from its argument or from the
// alert it replied to. Returns { fingerprint } or { error }.
function resolveTarget(sites, arg, message) {
  if (arg) {
    const { matches } = resolveAcrossSites(sites, arg);
    if (matches.length === 1) return { fingerprint: matches[0] };
    if (matches.length > 1) {
      return {
        error:
          `That prefix matches ${matches.length} fingerprints:\n` +
          matches.slice(0, 8).map((fp) => `<code>${esc(fp)}</code>`).join('\n') +
          '\n\nAdd a few more characters.',
      };
    }
    return { error: `No visitor matches <code>${esc(arg)}</code>.` };
  }

  const replyFingerprint = fingerprintFromReply(sites, message);
  if (replyFingerprint) return { fingerprint: replyFingerprint };
  if (message.reply_to_message) {
    return { error: 'That alert has no fingerprint on record — pass one explicitly.' };
  }
  return { error: 'Give me a fingerprint, or reply to one of the alerts.' };
}

function identityHeader(fingerprint) {
  const entry = identity.get(fingerprint);
  const lines = [
    entry?.name ? `👤 <b>${esc(entry.name)}</b>` : '👤 <i>Unidentified visitor</i>',
    `🆔 <code>${esc(fingerprint)}</code>`,
  ];
  if (entry?.note) lines.push(`📝 ${esc(entry.note)}`);
  return lines;
}

async function cmdVisits(sites, chatId, arg, message) {
  const target = resolveTarget(sites, arg, message);
  if (target.error) return telegram.sendMessage(chatId, target.error);

  const fingerprint = target.fingerprint;
  const lines = identityHeader(fingerprint);
  let seenAnywhere = false;

  for (const site of sites) {
    const events = store.readEvents(site.id);
    const stats = visits.statsFor(events, fingerprint);
    if (!stats) continue;
    seenAnywhere = true;

    const detail = [];
    detail.push(
      `<b>${stats.visitCount} ${stats.visitCount === 1 ? 'visit' : 'visits'}</b> · ` +
        `${stats.eventCount} ${stats.eventCount === 1 ? 'event' : 'events'}`
    );
    detail.push(`First seen ${esc(telegram.formatTimestamp(stats.firstSeen))}`);
    detail.push(`Last seen ${esc(telegram.formatTimestamp(stats.lastSeen))}`);

    const engaged = telegram.formatDuration(stats.engagementMs);
    if (engaged) detail.push(`⏱ ${engaged} active in total`);

    detail.push(stats.eventCounts.map(([label, count]) => `${esc(label)} ×${count}`).join(' · '));

    const place = stats.lastGeo
      ? [stats.lastGeo.city, stats.lastGeo.region, stats.lastGeo.country].filter(Boolean).join(', ')
      : null;
    if (place) detail.push(`📍 ${esc(place)}`);
    if (stats.lastIp) {
      const ipStats = visits.visitsFor(events, 'ip', stats.lastIp);
      detail.push(
        `🖧 <code>${esc(stats.lastIp)}</code>` +
          (ipStats
            ? ` · ${ipStats.visitCount} ${ipStats.visitCount === 1 ? 'visit' : 'visits'} from this IP`
            : '')
      );
    }
    if (stats.lastGps) {
      const { lat, lon } = stats.lastGps;
      detail.push(
        `🛰 ${stats.gpsCount} GPS ${stats.gpsCount === 1 ? 'fix' : 'fixes'} · ` +
          `<a href="https://maps.google.com/?q=${lat},${lon}">${lat.toFixed(5)}, ${lon.toFixed(5)}</a>`
      );
    }
    if (stats.suspiciousCount) detail.push(`⚠️ ${stats.suspiciousCount} flagged suspicious`);

    const pages = stats.topPages.slice(0, 3).map(([url, count]) => `${esc(url)} ×${count}`);
    if (pages.length) detail.push(`🔗 ${pages.join('\n🔗 ')}`);

    lines.push('');
    lines.push(`<b>${esc(site.name)}</b>`);
    lines.push(`<blockquote>${detail.join('\n')}</blockquote>`);
  }

  if (!seenAnywhere) {
    lines.push('');
    lines.push('<i>No visits on record.</i>');
  }

  return telegram.sendMessage(chatId, lines.join('\n'));
}

async function cmdName(sites, chatId, arg, message) {
  const replyFingerprint = fingerprintFromReply(sites, message);
  const tokens = arg.split(/\s+/).filter(Boolean);

  if (!tokens.length) {
    return telegram.sendMessage(
      chatId,
      'Usage: <code>/name &lt;fingerprint&gt; &lt;name&gt;</code>, or reply to an alert with <code>/name Michael</code>.'
    );
  }

  // In a reply the fingerprint is implied, so the whole argument is the name —
  // unless it starts with something that really is a fingerprint.
  let fingerprint = null;
  let name = null;
  const first = tokens[0];
  if (/^[0-9a-f]{6,}$/i.test(first)) {
    const { matches } = resolveAcrossSites(sites, first);
    if (matches.length === 1) {
      fingerprint = matches[0];
      name = tokens.slice(1).join(' ');
    } else if (matches.length > 1 && !replyFingerprint) {
      return telegram.sendMessage(chatId, `<code>${esc(first)}</code> matches ${matches.length} fingerprints — add a few more characters.`);
    }
  }
  if (!fingerprint) {
    if (!replyFingerprint) {
      return telegram.sendMessage(
        chatId,
        `No visitor matches <code>${esc(first)}</code>. Pass a fingerprint, or reply to an alert and just give the name.`
      );
    }
    fingerprint = replyFingerprint;
    name = tokens.join(' ');
  }

  name = name.slice(0, MAX_NAME_LENGTH).trim();
  if (!name) {
    return telegram.sendMessage(chatId, 'Give me a name too: <code>/name &lt;fingerprint&gt; Michael</code>');
  }

  const previous = identity.get(fingerprint);
  await identity.set(fingerprint, { name, source: `telegram:${chatId}` });

  const lines = [];
  lines.push(
    previous?.name
      ? `✏️ <b>${esc(previous.name)}</b> is now <b>${esc(name)}</b>`
      : `✅ Matched to <b>${esc(name)}</b>`
  );
  lines.push(`🆔 <code>${esc(fingerprint)}</code>`);

  // Show what naming them just brought into view: every past visit, too.
  const totals = sites
    .map((site) => ({ site, stats: visits.statsFor(store.readEvents(site.id), fingerprint) }))
    .filter((row) => row.stats);
  if (totals.length) {
    lines.push('');
    for (const { site, stats } of totals) {
      lines.push(
        `<b>${esc(site.name)}</b> — ${stats.visitCount} ${stats.visitCount === 1 ? 'visit' : 'visits'} ` +
          `since ${esc(telegram.formatDate(stats.firstSeen))}`
      );
    }
    lines.push('');
    lines.push('<i>Past and future visits from this browser are attributed to them, with or without location sharing.</i>');
  }

  return telegram.sendMessage(chatId, lines.join('\n'));
}

async function cmdForget(sites, chatId, arg, message) {
  const target = resolveTarget(sites, arg, message);
  if (target.error) return telegram.sendMessage(chatId, target.error);

  const removed = await identity.remove(target.fingerprint);
  if (!removed) {
    return telegram.sendMessage(chatId, `<code>${esc(shortFp(target.fingerprint))}</code> was not named.`);
  }
  return telegram.sendMessage(
    chatId,
    `🗑 Forgot <b>${esc(removed.name)}</b> — <code>${esc(target.fingerprint)}</code> is anonymous again.`
  );
}

async function cmdTop(sites, chatId, arg) {
  const requested = parseInt(arg, 10);
  const limit = Number.isNaN(requested) ? 10 : Math.min(Math.max(requested, 1), MAX_LIST_ROWS);

  const lines = ['<b>Most frequent visitors</b>'];
  for (const site of sites) {
    const rows = visits.topVisitors(store.readEvents(site.id), limit);
    lines.push('');
    lines.push(`<b>${esc(site.name)}</b>`);
    if (!rows.length) {
      lines.push('<i>No fingerprinted visits yet.</i>');
      continue;
    }
    const body = rows.map((row, index) => {
      const name = identity.nameFor(row.fingerprint);
      const who = name ? `<b>${esc(name)}</b>` : `<code>${esc(shortFp(row.fingerprint))}</code>`;
      return (
        `${index + 1}. ${who} — ${row.visitCount} ${row.visitCount === 1 ? 'visit' : 'visits'} · ` +
        `last ${esc(telegram.formatDate(row.lastSeen))}`
      );
    });
    lines.push(`<blockquote>${body.join('\n')}</blockquote>`);
  }
  return telegram.sendMessage(chatId, lines.join('\n'));
}

async function cmdIdentities(sites, chatId) {
  const entries = identity.list();
  if (!entries.length) {
    return telegram.sendMessage(
      chatId,
      'No identities named yet. Reply to an alert with <code>/name Michael</code> to match a fingerprint to a person.'
    );
  }

  const lines = [`<b>Named identities</b> (${entries.length})`, ''];
  for (const entry of entries.slice(0, MAX_LIST_ROWS)) {
    const totalVisits = sites.reduce((sum, site) => {
      const stats = visits.statsFor(store.readEvents(site.id), entry.fingerprint);
      return sum + (stats ? stats.visitCount : 0);
    }, 0);
    lines.push(
      `👤 <b>${esc(entry.name)}</b> — ${totalVisits} ${totalVisits === 1 ? 'visit' : 'visits'}\n` +
        `<code>${esc(entry.fingerprint)}</code>`
    );
  }
  if (entries.length > MAX_LIST_ROWS) lines.push(`<i>…and ${entries.length - MAX_LIST_ROWS} more.</i>`);

  return telegram.sendMessage(chatId, lines.join('\n'));
}

// Telegram renders <pre> in a monospace font, which is the only way these
// columns line up on a phone. Labels go left, figures right, so digits stack
// in the same place — unless the values are prose rather than numbers, which
// reads better flush left.
function table(rows, alignRight = true) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const text = String(cell);
          return i > 0 && alignRight ? text.padStart(widths[i]) : text.padEnd(widths[i]);
        })
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

async function cmdUsage(sites, chatId) {
  const fmt = diskUsage.formatBytes;
  const usage = await diskUsage.projectUsage();
  const disk = await diskUsage.filesystemStats();

  const lines = ['💾 <b>Disk usage</b>', ''];

  lines.push(`<b>${esc(path.basename(usage.root))}</b> · ${fmt(usage.total)}`);
  const breakdown = usage.breakdown.map((entry) => [entry.label, fmt(usage.parts[entry.key])]);
  breakdown.push(['Other', fmt(usage.other)]);
  lines.push(`<pre>${esc(table(breakdown))}</pre>`);

  // The event logs are the part that grows on its own, so show how close each
  // one is to the cap that stops it.
  const configured = getConfig().maxEventsPerSite;
  const cap = typeof configured === 'number' ? configured : 10000;
  const siteRows = [];
  let accounted = 0;
  for (const site of sites) {
    const bytes = await diskUsage.fileSize(store.filePathFor(site.id));
    accounted += bytes;
    const count = store.readEvents(site.id).length;
    siteRows.push([site.name, fmt(bytes), `${count} / ${cap > 0 ? cap : '∞'} events`]);
  }
  // Logs left behind by sites no longer in sites.json (or belonging to another
  // chat) still take up room — say so rather than letting the totals disagree.
  const unlisted = usage.parts.events - accounted;
  if (unlisted > 1024) siteRows.push(['(unlisted logs)', fmt(unlisted), '']);
  if (siteRows.length) {
    lines.push('');
    lines.push('<b>Event logs</b>');
    lines.push(`<pre>${esc(table(siteRows))}</pre>`);
  }

  lines.push('');
  if (disk) {
    const percent = disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0;
    lines.push('<b>Filesystem</b>');
    lines.push(
      `<pre>${esc(
        table(
          [
            ['Used', `${fmt(disk.used)} of ${fmt(disk.total)} (${percent}%)`],
            ['Available', fmt(disk.available)],
          ],
          false
        )
      )}</pre>`
    );
    // Worth shouting about: a full disk stops events being written at all.
    if (disk.available < 1024 * 1024 * 1024 || disk.available / disk.total < 0.1) {
      lines.push('');
      lines.push(`⚠️ <b>Low disk space</b> — only ${fmt(disk.available)} left.`);
    }
  } else {
    lines.push('<i>Filesystem stats unavailable on this platform.</i>');
  }

  return telegram.sendMessage(chatId, lines.join('\n'));
}

module.exports = { start, stop, parseCommand, handleUpdate };
