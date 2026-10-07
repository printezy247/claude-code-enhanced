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
  sandbox: {                 // Bubblewrap-isolated bash (claude code sandbox)
    enabled: false,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    allowLocalBinding: true,
    allowedDomains: [],
  },
  localNumCtx: 131072,       // context to load local Ollama models with (claude base prompt needs ≥70K)
};

class Store {
  constructor() {
    this.file = null;
    this.data = { providers: [], settings: { ...DEFAULT_SETTINGS } };
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
