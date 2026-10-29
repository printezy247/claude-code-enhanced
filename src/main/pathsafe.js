// Path containment for file paths that arrive over IPC.
//
// The renderer may ask the main process to read or write a file. Before this
// module existed those handlers took any string the renderer sent, so a
// crafted `../../etc/passwd` (or an absolute path anywhere on disk) was
// readable. A path is now resolved and must sit inside an allowed root.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TILDE = /^~(?=\/|$)/;

/**
 * Resolve `input` to an absolute path and refuse it when the real file lies
 * outside every allowed root.
 *
 * Existing files are compared by realpath, so a symlink inside a root that
 * points outside it is refused too. A file that does not exist yet (a save)
 * is compared through its nearest existing parent.
 *
 * @param {string} input  path from the renderer
 * @param {object} [opts]
 * @param {string[]} [opts.roots]  directories a path may live under
 * @param {string} [opts.base]     base for a relative path (default cwd)
 * @param {string} [opts.home]     home directory, for a leading `~`
 * @returns {{path: string, error?: undefined} | {path?: undefined, error: string}}
 */
function resolveSafe(input, opts = {}) {
  const home = opts.home || os.homedir();
  const roots = (opts.roots && opts.roots.length ? opts.roots : [home])
    .map((r) => path.resolve(r));
  if (typeof input !== 'string' || !input.trim()) return { error: 'path required' };
  if (input.includes('\u0000')) return { error: 'invalid path' };
  const expanded = input.replace(TILDE, home);
  const abs = path.resolve(opts.base || process.cwd(), expanded);

  const realOrNearest = (p) => {
    let cur = p;
    const tail = [];
    for (;;) {
      try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch { /* walk up */ }
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  };

  const real = realOrNearest(abs);
  const inside = roots.some((root) => {
    const rr = realOrNearest(root);
    const rel = path.relative(rr, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!inside) return { error: 'path is outside the allowed directories: ' + input };
  return { path: real };
}

module.exports = { resolveSafe, TILDE };
