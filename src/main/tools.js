// Runtime tools skills rely on (bun/uv run skill scripts, git imports skills).
// GUI-launched PATH is thin (no .bashrc sourced), and Ubuntu ships fd as
// `fdfind`, so check `which` first, then known install locations/alt names.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ALT = { fd: ['fd', 'fdfind'] };
const EXTRAS = {
  bun: [path.join(os.homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/home/linuxbrew/.linuxbrew/bin/bun'],
  uv: [path.join(os.homedir(), '.local', 'bin', 'uv'), '/usr/local/bin/uv'],
  fd: ['/usr/bin/fdfind', '/usr/bin/fd', path.join(os.homedir(), '.local', 'bin', 'fd'), '/usr/local/bin/fd'],
  rg: ['/usr/bin/rg', '/usr/local/bin/rg'],
  git: ['/usr/bin/git', '/bin/git'],
};

function whichIs(c) {
  return new Promise((resolve) => {
    execFile('which', [c], (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}

async function check() {
  const tools = [];
  for (const name of ['git', 'bun', 'uv', 'rg', 'fd']) {
    let found = '';
    for (const cand of (ALT[name] || [name])) {
      found = await whichIs(cand);
      if (found) break;
    }
    if (!found) {
      for (const p of (EXTRAS[name] || [])) {
        try { fs.accessSync(p, fs.constants.X_OK); found = p; break; } catch { /* try next */ }
      }
    }
    tools.push({ name, found: !!found, path: found });
  }
  return { tools };
}

module.exports = { check, EXTRAS, ALT };
