'use strict';
const fs = require('fs');
const path = require('path');

/** Absolute form of a path the agent wrote, relative paths taken from the chat folder. */
function absFor(cwd, p) {
  return path.resolve(String(cwd || '.'), String(p || ''));
}

/**
 * A file may be shared only if the agent wrote it in this chat and it is
 * still a regular file. Returns the real path, or null.
 * @param {Set<string>} written absolute paths recorded from Write/Edit calls
 */
function shareablePath(written, cwd, p) {
  if (!p || !(written instanceof Set)) return null;
  const abs = absFor(cwd, p);
  if (!written.has(abs)) return null;
  try {
    const real = fs.realpathSync(abs);
    return fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

module.exports = { absFor, shareablePath };
