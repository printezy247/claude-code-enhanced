// Crash-safe JSON persistence, shared by every main-process store.
//
// A plain writeFileSync can be caught half-done by a crash or power loss, and
// the reader then sees truncated JSON. Combined with "corrupt -> defaults"
// resets that path silently wipes providers and API keys. Writes here go to a
// temp file in the same directory and rename over the target (atomic on POSIX,
// same filesystem), and reads back up any file that fails to parse instead of
// letting the next save overwrite the evidence.
'use strict';
const fs = require('fs');
const path = require('path');

/** Atomically write `text` to `file` (0600 by default — these files hold secrets). */
function atomicWrite(file, text, { mode = 0o600 } = {}) {
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, text, { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* best effort (Windows) */ }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/** Atomically write `data` as JSON. */
function atomicWriteJson(file, data, opts = {}) {
  atomicWrite(file, JSON.stringify(data, null, opts.compact ? 0 : 2), opts);
}

/**
 * Read and parse a JSON file.
 * Returns undefined when the file does not exist, and null when it exists but
 * does not parse — in that case the bad bytes are first preserved as
 * `<file>.corrupt-<timestamp>` so state stays recoverable.
 */
function readJsonSafe(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch {
    try {
      const backup = file + '.corrupt-' + Date.now();
      fs.copyFileSync(file, backup);
      console.error('[store] ' + path.basename(file) + ' failed to parse — preserved at ' + backup);
    } catch { /* backup is best effort */ }
    return null;
  }
}

module.exports = { atomicWrite, atomicWriteJson, readJsonSafe };
