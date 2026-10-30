// Read-only browsing of a remote folder over ssh: list it, read a file, show
// its git diff. Nothing here writes. Every value is quoted for the remote
// shell, ssh is started with an argument array (no local shell), it never asks
// for a password, and the local environment is not passed on.
'use strict';
const { execFile: nodeExecFile } = require('child_process');
const { shq, cdPart, minimalEnv } = require('./sshrun');
const { sshArgs } = require('./sshhosts');

const MAX_ENTRIES = 1000;
const MAX_BYTES = 262144;
const TIMEOUT_MS = 20000;

/** An absolute path or one under ~; nothing else is accepted. */
function checkPath(p) {
  if (typeof p !== 'string' || !p || p.length > 1000 || /[\0\n\r]/.test(p)) throw new Error('That is not a usable remote path.');
  if (p !== '~' && !p.startsWith('/') && !p.startsWith('~/')) throw new Error('Use an absolute path or one starting with ~/.');
  return p;
}

/** A path as one remote word; a leading ~/ stays unquoted so the remote shell expands it. */
function word(p) {
  if (p === '~') return '~';
  if (p.startsWith('~/')) return '~/' + shq(p.slice(2));
  return shq(p);
}

const listCommand = (p) => cdPart(checkPath(p)) + 'ls -1Ap';
const readCommand = (p) => 'head -c ' + MAX_BYTES + ' -- ' + word(checkPath(p));
const diffCommand = (p) => cdPart(checkPath(p)) + 'git --no-pager diff --no-color --no-ext-diff --no-textconv | head -c ' + MAX_BYTES;

/** Folders first, then files, each A to Z; capped so a huge folder cannot flood the window. */
function parseListing(text) {
  const all = String(text || '').split('\n').filter(Boolean).map((l) => (l.endsWith('/') ? { name: l.slice(0, -1), dir: true } : { name: l, dir: false }));
  all.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { entries: all.slice(0, MAX_ENTRIES), truncated: all.length > MAX_ENTRIES };
}

function createBrowser({ execFile = nodeExecFile, env = process.env } = {}) {
  const run = (host, remote) => new Promise((resolve, reject) => {
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...sshArgs(host), remote];
    execFile('ssh', args, { env: minimalEnv(env), timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES * 2, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ssh could not run that on ' + (host.label || host.host) + ': ' + String(stderr || err.message).trim().slice(0, 300)));
      resolve(String(stdout));
    });
  });
  return {
    async list(host, p) { return parseListing(await run(host, listCommand(p))); },
    async read(host, p) { const text = await run(host, readCommand(p)); return { text, truncated: Buffer.byteLength(text) >= MAX_BYTES }; },
    async diff(host, p) { const text = await run(host, diffCommand(p)); return { text, truncated: Buffer.byteLength(text) >= MAX_BYTES }; },
  };
}

module.exports = { createBrowser, listCommand, readCommand, diffCommand, parseListing, checkPath, MAX_ENTRIES, MAX_BYTES };
