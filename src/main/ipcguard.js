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

/**
 * Shape-check the fields of an IPC payload.
 *
 * Each spec entry is a kind: `'string'` (any non-empty string), `'id'`
 * (non-empty string, trimmed), `'nonempty'` (trimmed string with
 * non-whitespace), `'text'` (any string, empty allowed), `'object'`,
 * `{ enum: [...] }`, or `{ type, optional }`.
 * Returns an error string, or null when the payload fits.
 *
 * This is a shape guard, not a security boundary: the sender check is. Its job
 * is to turn `session:create` with `{ type: 7 }` into a readable `{ ok: false }`
 * instead of a stack trace deep inside a module.
 */
function checkFields(payload, spec) {
  const args = payload && typeof payload === 'object' ? payload : {};
  for (const [name, rule] of Object.entries(spec || {})) {
    const kind = typeof rule === 'string' ? rule : rule && rule.type;
    const optional = !!(rule && typeof rule === 'object' && rule.optional);
    const value = args[name];
    if (optional && (value === undefined || value === null)) continue;
    switch (kind) {
      case 'string':
        if (typeof value !== 'string' || !value) return `${name} must be a non-empty string`;
        break;
      case 'id':
        if (typeof value !== 'string' || !value.trim()) return `${name} must be a non-empty id`;
        if (value.length > 512) return `${name} is too long`;
        break;
      case 'nonempty':
        if (typeof value !== 'string' || !value.trim()) return `${name} must be a non-empty string`;
        break;
      case 'text':
        if (typeof value !== 'string') return `${name} must be a string`;
        break;
      case 'object':
        if (!value || typeof value !== 'object' || Array.isArray(value)) return `${name} must be an object`;
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a number`;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return `${name} must be true or false`;
        break;
      case undefined:
        if (rule && Array.isArray(rule.enum)) {
          if (!rule.enum.includes(value)) return rule.message ? `${rule.message}: ${String(value)}` : `${name} must be one of: ${rule.enum.join(', ')}`;
          break;
        }
        return `unknown validation rule for ${name}`;
      default:
        if (rule && Array.isArray(rule.enum)) {
          if (!rule.enum.includes(value)) return rule.message ? `${rule.message}: ${String(value)}` : `${name} must be one of: ${rule.enum.join(', ')}`;
          break;
        }
        return `unknown validation rule for ${name}`;
    }
  }
  return null;
}

module.exports = {
  payloadCap, isAllowedSenderUrl, isExternalLink, checkFields,
  DEFAULT_CAP, LARGE_CAP,
};
