// Enterprise policy file (Claude Code "managed settings").
//
// The CLI reads this file itself, but a GUI host that spawns the CLI with its
// own flags must hand the policy over explicitly: the desktop passes
// `managedSettings` so the machine's policy applies to GUI chats too. Without
// it a managed workstation silently runs unmanaged in CCE.
// #t0-managed-settings
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Where Claude Code looks for the machine-wide policy, per platform.
const CANDIDATES = [
  '/etc/claude-code/managed-settings.json',
  '/Library/Application Support/ClaudeCode/managed-settings.json',
  'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
  path.join(os.homedir() || '/root', '.claude', 'managed-settings.json'),
];

// Policy tiers, strongest first. A key in the managed file wins over the
// user/project/local files the CLI merges underneath it.
const TIERS = ['managed', 'commandLine', 'user', 'project', 'local'];

/** The path the policy is read from (env override wins), or '' when there is none. */
function managedPath(env = process.env) {
  const override = String((env && env.CLAUDE_CODE_MANAGED_SETTINGS_PATH) || '').trim();
  if (override) return override;
  for (const candidate of CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch { /* not there, try the next one */ }
  }
  return '';
}

/**
 * Read the managed policy.
 * @returns {{path: string, settings: object, origin: 'managed'}|null}
 */
function load(env = process.env) {
  const file = managedPath(env);
  if (!file) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A broken policy file must not take the app down, and it must not be
    // silently treated as "no policy": the CLI would apply its own default.
    return { path: file, settings: {}, origin: 'managed', error: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path: file, settings: {}, origin: 'managed', error: 'malformed' };
  }
  return { path: file, settings: parsed, origin: 'managed' };
}

/** The tier a value came from. Managed wins over everything the user sets. */
function policyOrigin(source) {
  const idx = TIERS.indexOf(String(source || ''));
  return idx === -1 ? 'unknown' : TIERS[idx];
}

/**
 * The policy for one key: the managed value when there is one, else the
 * caller's value. Used where CCE merges a setting that the machine's policy
 * is allowed to override.
 */
function resolve(managed, key, fallback) {
  const m = managed && managed.settings ? managed.settings : null;
  if (m && Object.prototype.hasOwnProperty.call(m, key) && m[key] !== undefined) {
    return m[key];
  }
  return fallback;
}

module.exports = { CANDIDATES, TIERS, managedPath, load, policyOrigin, resolve };
