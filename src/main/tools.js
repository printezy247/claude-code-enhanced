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

// ---- Path / command policy helpers (B1) -------------------------------------
// Write-capable tools: used to enforce read-only sessions and write-tool rules.
const WRITE_TOOLS_LIST = ['Write', 'Edit', 'MultiEdit', 'NotebookEditCell'];
const WRITE_TOOLS = new Set(WRITE_TOOLS_LIST);

function isVmPath(p) {
  if (!p || typeof p !== 'string') return false;
  const norm = p.replace(/\\/g, '/');
  return /^\/(proc|sys|dev)(\/|$)/i.test(norm)
    || /^\/private\/var\/vm(\/|$)/i.test(norm)
    || /^\\\\\.\\/i.test(p);
}

function targetFilePath(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  return String(input.file_path || input.path || input.target || '');
}

function isOutsideDirs(filePath, allowedDirs) {
  if (!filePath || !allowedDirs || !allowedDirs.length) return false;
  try {
    const home = os.homedir();
    const resolved = path.resolve(filePath.replace(/^~(?=\/|$)/, home));
    const claudeDir = path.resolve(home, '.claude');
    if (resolved === claudeDir || resolved.startsWith(claudeDir + path.sep)) return false;
    return !allowedDirs.some((dir) => {
      const rDir = path.resolve(String(dir).replace(/^~(?=\/|$)/, home));
      return resolved === rDir || resolved.startsWith(rDir + path.sep);
    });
  } catch { return false; }
}

// ---- Policy data: per-tool always_ask / always_deny sets for connector tools ----
// Empty by default; callers (settings, connectors) populate per session. Kept
// here so the policy data has a single home that tools.js/chats.js can read.
const ALWAYS_ASK_TOOLS = new Set();
const ALWAYS_DENY_TOOLS = new Set();
const ALWAYS_ASK = [];
const ALWAYS_DENY = [];

// Resolve the effective connector policy for a tool: settings override wins,
// then the static sets. Returns 'always_ask' | 'always_deny' | null.
function connectorPolicy(toolName, settings) {
  const name = String(toolName || '');
  if (settings && settings.connectorToolPolicy && settings.connectorToolPolicy[name]) {
    return settings.connectorToolPolicy[name];
  }
  if (ALWAYS_DENY_TOOLS.has(name)) return 'always_deny';
  if (ALWAYS_ASK_TOOLS.has(name)) return 'always_ask';
  return null;
}

// Denial messages (single source of truth).
const MESSAGES = {
  vmPath: 'Path is in a restricted VM or system location.',
  readOnly: 'Session is read-only in this session.',
  blockedTool: 'Tool blocked by policy.',
  outsideAllowed: 'Path is outside allowed working directories.',
  connectorDeny: 'Tool use denied by connector policy.',
};

module.exports = {
  check, EXTRAS, ALT,
  // policy helpers
  WRITE_TOOLS, WRITE_TOOLS_LIST, isVmPath, targetFilePath, isOutsideDirs,
  ALWAYS_ASK_TOOLS, ALWAYS_DENY_TOOLS, ALWAYS_ASK, ALWAYS_DENY,
  connectorPolicy, MESSAGES,
};
module.exports.WRITE_TOOLS = WRITE_TOOLS;
