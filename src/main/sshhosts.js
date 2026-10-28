// SSH hosts (item 14): remember machines, open a real ssh terminal tab.
// The argv is built as an array — no shell ever sees the values — and the
// fields are validated so a saved host cannot smuggle ssh options.
'use strict';
const crypto = require('crypto');

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;      // name or IPv4-ish, no spaces/metachars
const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;         // never starts with '-'
const LABEL_RE = /^.{1,60}$/;

function normalize(input) {
  const host = String((input && input.host) || '').trim();
  const user = String((input && input.user) || '').trim();
  const label = String((input && input.label) || '').trim() || host;
  const identity = String((input && input.identity) || '').trim();
  if (!HOST_RE.test(host)) throw new Error('invalid ssh host: ' + JSON.stringify(host));
  if (user && !USER_RE.test(user)) throw new Error('invalid ssh user: ' + JSON.stringify(user));
  if (!LABEL_RE.test(label)) throw new Error('invalid ssh label');
  if (identity && !identity.startsWith('/')) throw new Error('identity must be an absolute path');
  const rawPort = input && input.port !== undefined && input.port !== '' ? Number(input.port) : 22;
  const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 22;
  if (input && input.port !== undefined && input.port !== '' && port !== Number(input.port)) {
    throw new Error('invalid ssh port');
  }
  return { id: String((input && input.id) || ''), label, host, user, port, identity };
}

/** ssh argv for a saved host — array form, never a shell string. */
function sshArgs(host) {
  const args = ['-o', 'ServerAliveInterval=30'];
  if (host.port && host.port !== 22) args.push('-p', String(host.port));
  if (host.identity) args.push('-i', host.identity);
  args.push(host.user ? host.user + '@' + host.host : host.host);
  return args;
}

function newId() { return 'h-' + crypto.randomBytes(6).toString('hex'); }

module.exports = { normalize, sshArgs, newId, HOST_RE, USER_RE };
