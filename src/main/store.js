// JSON config store under the Electron userData dir, written with 0600 perms
// because it holds provider API tokens.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const { atomicWriteJson, readJsonSafe } = require('./atomic');
const { clampMaxChars, clampIdleSeconds } = require('./toolfilter');
const { normalizeDomains } = require('./webdomains');
const { normalizeModes, normalizeUsage } = require('./connectorauto');

const DEFAULT_SETTINGS = {
  claudePath: '',            // empty = auto-detect
  fontSize: 14,
  scrollback: 5000,
  disableTelemetry: true,    // DISABLE_TELEMETRY / DISABLE_ERROR_REPORTING / DISABLE_AUTOUPDATER
  defaultProviderUid: null,
  defaultCwd: os.homedir(),
  theme: 'dark',            // 'dark' | 'light' (#47)
  failoverChain: [],        // ordered provider uids to retry a turn on (#42)
  closeToTray: false,       // keep chats alive when the window closes (#46)
  modelRouting: false,      // pick a model by task size for chats with no pinned model
  modelRouteTiers: {},      // { trivial, medium, heavy } model overrides for that routing
  notifyOnDone: true,       // desktop notification when a turn finishes (#36)
  // Per-provider lean tool set: fewer tool schemas = a smaller base prompt,
  // which is what lets 3-4B local models clear the ~70K context floor. #41
  leanTools: null,          // null = off; array of tool names = allowlist
  disallowedTools: [],
  sandbox: {                 // Bubblewrap-isolated bash (claude code sandbox)
    enabled: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    allowLocalBinding: true,
    allowedDomains: [],
  },
  contextMode: 'auto',      // context-mode plugin: 'auto' = Claude models only, 'on', 'off'
  // Shell-output filter: the model reads a compacted command result, the card
  // in the UI keeps the full text. 'off' hands the model the engine's own
  // (30k) limit. #feat-output-filter
  outputFilter: 'on',
  outputFilterMaxChars: 8000,
  connectorModes: { global: {}, projects: {} },   // per connector: auto (default) / on / off, for all projects or one folder
  connectorUsage: {},       // folder -> { connector: calls }: remembered so a new chat starts with the right ones
  connectorPick: 'auto',    // 'auto': pick connectors per message only for small windows; 'off'; 'always'
  webFetchDomains: [],      // sites WebFetch may read without asking; anything else asks first
  streamIdleSeconds: 180,   // how long a silent stream may stay silent before the turn is called dead
  autoNudge: false,         // off by default: avoids burning whole turns on closing remarks
  autoOpenWelcomeChat: false, // start on the blank home page, not in a chat rooted at defaultCwd
  thinkingBudget: 2048,     // sensible default to prevent unbounded thinking token burn (blank/0 = model default)
  localNumCtx: 73728,        // context to load local Ollama models with (claude base prompt ≈66K tokens; more costs RAM)
  forceCtx: {},             // per-model override: { "qwen3-4b": 32000 } skips the floor (#11)
  // ---- The SDK options the desktop app passes (0.9.40) ----
  // The machine's policy file is applied when it exists; the row only turns
  // the hand-off off for a user who wants the GUI to ignore it.
  managedSettings: true,
  // The connector servers this chat is pinned to. Empty = the CLI's own MCP
  // config stays the single source (nothing is registered twice).
  scopedMcpServers: [],
  hostConnectors: false,        // model calls connectors through the host broker (hostmcp.js)
  // Hand the CLI's ~/.claude/agents to the engine as agent definitions.
  sdkAgents: false,
  mainAgent: '',            // the agent that runs the main thread
  allowAdditionalDirectories: false,  // widen the engine's reach to allowedDirectories
  projectConfigRoot: '',    // the trusted checkout a worktree belongs to
  taskBudget: 0,            // token budget the model paces itself against
  planModeInstructions: '',  // custom plan-mode workflow
  userDialog: false,        // render the CLI's refusal-fallback dialog
  verbatimPrompts: false,   // send prompts as written (no @file expansion)
  continueSession: false,   // continue the newest conversation in this folder
  debugFile: '',            // engine debug log
  toolAliases: {},          // { Bash: 'mcp__workspace__bash' }
  toolConfig: {},           // per-tool configuration for the built-in tools
  outputFormat: null,       // { type: 'json_schema', schema: {...} }
  sessionMirror: '',        // mirror transcripts to this JSONL file
  loadTimeoutMs: 0,         // timeout for one session-store call
  perTaskStop: true,        // the UI has a per-task stop control
  pluginDelivery: 'argv',   // 'argv' | 'initialize'
  // Per-tool connector policy: { 'mcp__github__create_issue': 'always_ask_session' }
  connectorToolPolicy: {},
};

class Store {
  constructor() {
    this.file = null;
    // Config schema marker: bumped when the provider record shape changes so a
    // future release can migrate old files. 2 = secrets split into auth.json.
    this.data = { configVersion: 2, providers: [], settings: { ...DEFAULT_SETTINGS } };
  }

  init() {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    this.file = path.join(dir, 'config.json');
    // A file that exists but does not parse is preserved as *.corrupt-<ts>
    // before we start from defaults, so a half-written config is recoverable.
    const parsed = readJsonSafe(this.file);
    if (parsed && typeof parsed === 'object') this.data = { ...this.data, ...parsed };
    this.data.providers ??= [];
    this.data.configVersion ??= 2;
    this.data.settings = { ...DEFAULT_SETTINGS, ...(this.data.settings || {}) };
    // The budget is a promise about what the model may read: 500…100000. A
    // hand-edited config.json must not keep an out-of-range value in the
    // store, where the Settings box would show it. #R3
    if ('outputFilterMaxChars' in this.data.settings) {
      this.data.settings.outputFilterMaxChars =
        clampMaxChars(this.data.settings.outputFilterMaxChars);
    }
    this.data.settings.streamIdleSeconds = clampIdleSeconds(this.data.settings.streamIdleSeconds);
    this.data.settings.webFetchDomains = normalizeDomains(this.data.settings.webFetchDomains);
    this.data.settings.connectorModes = normalizeModes(this.data.settings.connectorModes);
    this.data.settings.connectorUsage = normalizeUsage(this.data.settings.connectorUsage);
    if (!['auto', 'off', 'always'].includes(this.data.settings.connectorPick)) this.data.settings.connectorPick = 'auto';
    this.save();
  }

  save() {
    atomicWriteJson(this.file, this.data);
  }

  get settings() { return this.data.settings; }
  set settings(v) { this.data.settings = v; this.save(); }

  get providers() { return this.data.providers; }
  set providers(v) { this.data.providers = v; this.save(); }
}

module.exports = { Store, DEFAULT_SETTINGS };
