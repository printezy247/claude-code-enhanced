// Terminal colour and cursor sequences (CSI, OSC) removed from text a CLI
// printed, so they never reach a Markdown card as `[0m` / `[32m` junk.
'use strict';
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** The text without escape sequences; anything not a string comes back as ''. */
function stripAnsi(s) {
  return typeof s === 'string' ? s.replace(ANSI, '') : '';
}

module.exports = { stripAnsi };
