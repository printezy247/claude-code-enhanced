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
const WRITE_TOOLS_LIST = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
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
  return String(input.file_path || input.notebook_path || input.path || input.target || '');
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

// The connector policy states. The desktop has four (allow / ask /
// ask-session / blocked); CCE's naming is 'always_*'. 'always_ask_session'
// is new: the user is asked once for a tool and the answer holds for the rest
// of the session, instead of a card for every single call. #t0-ask-session
const POLICY_STATES = ['always_allow', 'always_ask', 'always_ask_session', 'always_deny'];

// The SDK only knows three per-tool policies. 'always_ask_session' is a
// host-side decision (the grant lives in the host, not the CLI), so at the
// SDK boundary it degrades to 'always_ask' — the safe direction.
const SDK_POLICY = {
  always_allow: 'always_allow',
  always_ask: 'always_ask',
  always_ask_session: 'always_ask',
  always_deny: 'always_deny',
};

// A connector tool: the CLI names MCP tools `mcp__<server>__<tool>`.
function isConnectorTool(toolName) {
  return /^mcp__[^_]/.test(String(toolName || ''));
}

// Tools that change or destroy something outside the workspace. The desktop
// auto-asks for these even when the tool is otherwise allowed. The list is
// deliberately narrow: a false positive costs the user a prompt, a false
// negative costs them a deleted file.
const DESTRUCTIVE_PATTERNS = [
  /delete/i, /remove/i, /destroy/i, /drop\b/i, /truncate/i, /purge/i,
  /\bwrite\b/i, /\bcreate\b/i, /\bupdate\b/i, /\bpublish\b/i, /\bsend\b/i,
  /\bexecute\b/i, /\brun\b/i, /\bmerge\b/i, /\bforce/i, /\bkill\b/i, /\breset\b/i,
];

function isDestructiveTool(toolName) {
  const name = String(toolName || '');
  if (!name) return false;
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(name));
}

// Resolve the effective connector policy for a tool: settings override wins,
// then the static sets. Returns one of POLICY_STATES, or null when the tool
// has no policy of its own.
function connectorPolicy(toolName, settings) {
  const name = String(toolName || '');
  if (settings && settings.connectorToolPolicy && settings.connectorToolPolicy[name]) {
    const state = String(settings.connectorToolPolicy[name]);
    if (POLICY_STATES.includes(state)) return state;
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
  destructive: 'This tool changes or deletes data outside the workspace, so it always needs your confirmation.',
};

module.exports = {
  check, EXTRAS, ALT,
  // policy helpers
  WRITE_TOOLS, WRITE_TOOLS_LIST, isVmPath, targetFilePath, isOutsideDirs,
  ALWAYS_ASK_TOOLS, ALWAYS_DENY_TOOLS,
  connectorPolicy, MESSAGES,
  POLICY_STATES, SDK_POLICY, isConnectorTool, isDestructiveTool,
};
module.exports.WRITE_TOOLS = WRITE_TOOLS;
