// Who may call the main process over IPC, how big a call may be, and which
// links may leave the app. Kept out of main.js so it can be tested without
// Electron.
'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

const DEFAULT_CAP = 1_000_000;
// Channels that carry pasted or attached images as base64. The renderer
// shrinks each image first, but a few screenshots still pass 1 MB. Every
// other channel, including any added later, keeps the 1 MB cap.
const LARGE_CAP = 24_000_000;
const CHANNEL_CAPS = new Map([
  ['chat:send', LARGE_CAP],
  ['chat:steer', LARGE_CAP],
  ['draft:images', LARGE_CAP],
]);

/** The largest JSON payload, in bytes, a channel accepts. */
function payloadCap(channel) {
  return CHANNEL_CAPS.get(channel) || DEFAULT_CAP;
}

/**
 * True when an IPC call comes from the app's own page. A devtools:// frame
 * is accepted only in a development build: nothing in a packaged app sends
 * from there, so accepting it was an open door with no use.
 */
function isAllowedSenderUrl(url, rendererDir, { packaged = true } = {}) {
  const u = String(url || '');
  if (!u) return false;
  if (u.startsWith('devtools://')) return !packaged;
  if (!u.startsWith('file://')) return false;
  try {
    const rel = path.relative(rendererDir, fileURLToPath(u));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Only http(s) links are handed to the system browser; nothing opens in-app. */
function isExternalLink(url) {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

module.exports = { payloadCap, isAllowedSenderUrl, isExternalLink, DEFAULT_CAP, LARGE_CAP };
