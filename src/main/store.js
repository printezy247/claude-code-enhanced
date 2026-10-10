// JSON config store under the Electron userData dir, written with 0600 perms
// because it holds provider API tokens.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

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
  localNumCtx: 73728,        // context to load local Ollama models with (claude base prompt ≈66K tokens; more costs RAM)
  forceCtx: {},             // per-model override: { "qwen3-4b": 32000 } skips the floor (#11)
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
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...parsed };
    } catch { /* first run or corrupt file -> defaults */ }
    this.data.providers ??= [];
    this.data.configVersion ??= 2;
    this.data.settings = { ...DEFAULT_SETTINGS, ...(this.data.settings || {}) };
    this.save();
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get settings() { return this.data.settings; }
  set settings(v) { this.data.settings = v; this.save(); }

  get providers() { return this.data.providers; }
  set providers(v) { this.data.providers = v; this.save(); }
}

module.exports = { Store, DEFAULT_SETTINGS };
