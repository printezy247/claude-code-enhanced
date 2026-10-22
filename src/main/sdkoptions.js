// The SDK options CCE hands to the engine, beyond the basics set in chats.js.
//
// The desktop app passes 61 options; the SDK's own type declares 57. CCE
// passes the subset a GUI user can actually control, and every key here is
// read from Settings — no speculative plumbing, no option the UI cannot
// explain. `test/sdk-options.test.js` pins the exact key set so a future SDK
// bump that drops one is caught by the suite.
// #t1-sdk-options
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Keys this module may add to the SDK options object. A key that is not on
// this list is a bug: the test compares the built object against it.
const SDK_OPTION_KEYS = [
  'additionalDirectories',
  'agent',
  'agents',
  'continue',
  'debugFile',
  'loadTimeoutMs',
  'managedSettings',
  'mcpServers',
  'onUserDialog',
  'outputFormat',
  'perTaskStopAffordance',
  'planModeInstructions',
  'pluginDelivery',
  'projectConfigRoot',
  'sessionStore',
  'sessionStoreFlush',
  'strictMcpConfig',
  'supportedDialogKinds',
  'taskBudget',
  'toolAliases',
  'toolConfig',
  'verbatimPrompts',
];

// ---- Subagent definitions ----------------------------------------------------
// The CLI loads ~/.claude/agents/*.md on its own. Passing them again through
// the SDK makes them visible to a host that filters tools, and lets CCE pin
// the model/tools of an agent. Off by default: the CLI's own copy is the
// source of truth, and two copies of the same agent name collide.
const AGENT_FILE = /\.md$/i;

function parseFrontmatter(text) {
  const src = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^["'].*["']$/.test(value)) value = value.slice(1, -1);
    meta[kv[1].toLowerCase()] = value;
  }
  return { meta, body: m[2] };
}

/** One agent file → the SDK's AgentDefinition (or null when unusable). */
function agentDefinition(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const name = String(meta.name || path.basename(file, path.extname(file)) || '').trim();
  const description = String(meta.description || '').trim();
  if (!name || !description) return null;
  const def = { description, prompt: body.trim() };
  const tools = String(meta.tools || '').trim();
  if (tools) {
    def.tools = tools.split(',').map((t) => t.trim()).filter(Boolean);
  }
  const model = String(meta.model || '').trim();
  if (model) def.model = model;
  return { name, definition: def };
}

/**
 * Every agent definition found in the given directories.
 * @returns {Record<string, object>} the SDK's `agents` map
 */
function agentDefinitions(dirs) {
  const out = {};
  for (const dir of dirs || []) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!AGENT_FILE.test(entry)) continue;
      const parsed = agentDefinition(path.join(dir, entry));
      if (parsed) out[parsed.name] = parsed.definition;
    }
  }
  return out;
}

/** The directories the CLI reads agents from: user level and project level. */
function agentDirs(dir) {
  const dirs = [path.join(os.homedir() || '', '.claude', 'agents')];
  if (dir) dirs.push(path.join(dir, '.claude', 'agents'));
  return dirs;
}

// ---- Option builders ---------------------------------------------------------

function str(v) {
  const s = String(v == null ? '' : v).trim();
  return s || '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function strList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || '').trim()).filter(Boolean);
}

/**
 * Build the option deltas.
 *
 * @param {object}  o
 * @param {object}  o.settings      the store's settings
 * @param {string}  o.dir           the chat's working directory
 * @param {object}  o.managed       managed-settings.json ({settings, path})
 * @param {object}  o.mcpServers    {name: config} map, already scoped
 * @param {function} o.onUserDialog the host's dialog handler
 * @returns {object} a partial SDK options object (only the keys that apply)
 */
function buildSdkOptions({ settings = {}, dir = '', managed = null, mcpServers = null, onUserDialog = null } = {}) {
  const out = {};

  // The machine's policy file. A managed workstation must not run the GUI
  // unmanaged just because the GUI did not know about the file. #t0
  if (settings.managedSettings !== false && managed && managed.settings && Object.keys(managed.settings).length) {
    out.managedSettings = managed.settings;
  }

  // Scoped connectors: the engine gets exactly these servers and ignores the
  // CLI's own .mcp.json, so a chat can be pinned to a known server set.
  if (mcpServers && Object.keys(mcpServers).length) {
    out.mcpServers = mcpServers;
    out.strictMcpConfig = true;
  }

  // Subagents, handed to the engine as definitions.
  if (settings.sdkAgents === true) {
    const agents = agentDefinitions(agentDirs(dir));
    if (Object.keys(agents).length) out.agents = agents;
  }
  const mainAgent = str(settings.mainAgent);
  if (mainAgent) out.agent = mainAgent;

  // Extra directories the agent may read. Off by default: it widens the
  // CLI's own reach, not just CCE's permission check.
  if (settings.allowAdditionalDirectories === true) {
    const dirs = strList(settings.allowedDirectories).map((d) =>
      path.resolve(String(d).replace(/^~(?=\/|$)/, os.homedir() || '/root')));
    if (dirs.length) out.additionalDirectories = dirs;
  }

  // The trusted checkout a worktree belongs to: project settings, hooks and
  // .mcp.json then come from the main checkout, not the worktree.
  const projectRoot = str(settings.projectConfigRoot);
  if (projectRoot) out.projectConfigRoot = path.resolve(projectRoot);

  // Token budget the model paces itself against.
  const budget = num(settings.taskBudget);
  if (budget) out.taskBudget = { maxTokens: budget };

  // Custom plan-mode workflow.
  const planInstructions = str(settings.planModeInstructions);
  if (planInstructions) out.planModeInstructions = planInstructions;

  // A dialog the CLI asks the host to render. Only kinds the host can really
  // draw are declared: an undeclared kind makes the CLI fail closed.
  if (settings.userDialog === true && typeof onUserDialog === 'function') {
    out.onUserDialog = onUserDialog;
    out.supportedDialogKinds = ['refusal_fallback_prompt'];
  }

  // Send prompts verbatim (no @file expansion, no slash dispatch) when the
  // text was assembled by the host rather than typed by the user.
  if (settings.verbatimPrompts === true) out.verbatimPrompts = true;

  // Continue the most recent conversation in this directory.
  if (settings.continueSession === true) out.continue = true;

  // Engine debug log.
  const debugFile = str(settings.debugFile);
  if (debugFile) out.debugFile = path.resolve(debugFile);

  // Redirect a built-in tool name onto another tool (e.g. Bash → an MCP
  // tool that runs in a sandbox).
  if (settings.toolAliases && typeof settings.toolAliases === 'object' && Object.keys(settings.toolAliases).length) {
    const aliases = {};
    for (const [from, to] of Object.entries(settings.toolAliases)) {
      const f = str(from);
      const t = str(to);
      if (f && t && f !== t) aliases[f] = t;
    }
    if (Object.keys(aliases).length) out.toolAliases = aliases;
  }

  // Per-tool configuration for the built-in tools.
  if (settings.toolConfig && typeof settings.toolConfig === 'object' && Object.keys(settings.toolConfig).length) {
    out.toolConfig = settings.toolConfig;
  }

  // Structured output for a whole turn.
  if (settings.outputFormat && typeof settings.outputFormat === 'object') {
    const of = settings.outputFormat;
    if (of.type === 'json_schema' && of.schema) {
      out.outputFormat = { type: 'json_schema', schema: of.schema };
    }
  }

  // Mirror transcripts to a file. The mirror needs the CLI's own writes, so
  // persistSession stays true (the SDK throws when both are set).
  const mirror = str(settings.sessionMirror);
  if (mirror) {
    out.sessionStore = createFileSessionStore(path.resolve(mirror));
    out.sessionStoreFlush = 'batched';
  }

  // How long a session-store call may take before the resume gives up.
  const loadTimeout = num(settings.loadTimeoutMs);
  if (loadTimeout) out.loadTimeoutMs = loadTimeout;

  // CCE renders a per-task stop control (chat:stopTask), so the CLI may hold
  // background tasks back on interrupt instead of killing them.
  if (settings.perTaskStop !== false) out.perTaskStopAffordance = true;

  // How plugins reach the CLI. 'initialize' keeps the command line short when
  // many plugins are loaded (Windows refuses a command line over 32k chars).
  const delivery = str(settings.pluginDelivery);
  if (delivery === 'initialize' || delivery === 'argv') out.pluginDelivery = delivery;

  return out;
}

// ---- Session store ------------------------------------------------------------

/**
 * A minimal SessionStore adapter: every transcript entry is appended to one
 * JSONL file. The SDK calls load()/listSubkeys() when it resumes a session,
 * so both have to answer.
 */
function createFileSessionStore(file) {
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
    }
    return out;
  };
  return {
    async load() { return read(); },
    async listSubkeys() { return []; },
    async store(key, value) {
      try {
        fs.appendFileSync(file, JSON.stringify({ key, value }) + '\n', { mode: 0o600 });
      } catch { /* a failed mirror must not break the turn */ }
    },
  };
}

module.exports = {
  SDK_OPTION_KEYS,
  parseFrontmatter,
  agentDefinition,
  agentDefinitions,
  agentDirs,
  buildSdkOptions,
  createFileSessionStore,
};
