// Electron stub for main-process tests.
//
// vitest.config.js aliases `electron` here, so src/main/* can be imported and
// driven in plain node: ipcMain handlers get captured, BrowserWindow becomes an
// inert stub, and app.getPath points at a per-test temp dir instead of the real
// userData directory.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let userDataDir = null;
function ensureUserData() {
  if (!userDataDir) userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-test-userdata-'));
  return userDataDir;
}

/** Registered ipcMain.handle(channel, fn) callbacks, keyed by channel. */
const handlers = new Map();
/** Channels sent to the renderer via webContents.send(). */
const sent = [];
/** Options passed to Notification({title, body}). */
const notifications = [];
/** URLs passed to shell.openExternal(). */
const opened = [];
/** Events registered with app.on(), so tests can emit them. */
const appEvents = new Map();
/** BrowserWindow instances created during the test. */
const windows = [];

const app = new EventEmitter();
app.setName = () => {};
app.commandLine = { appendSwitch() {}, hasSwitch: () => false };
app.isPackaged = false;
app.getPath = (name) => (name === 'userData' ? ensureUserData() : ensureUserData());
app.getVersion = () => '0.0.0-test';
app.getName = () => 'claude-code-enhanced';
app.getAppPath = () => path.join(__dirname, '..', '..');
app.whenReady = () => Promise.resolve();
app.quit = () => {};
app.exit = () => {};
app.focus = () => {};
app.dock = { show() {}, hide() {} };
app.requestSingleInstanceLock = () => true;
app.setLoginItemSettings = () => {};
app.setAsDefaultProtocolClient = () => {};
app.disableHardwareAcceleration = () => {};
app.on = (evt, fn) => { appEvents.set(evt, fn); return app; };
app.once = app.on;
app.emit = ((orig) => function (evt, ...a) {
  if (!appEvents.has(evt)) return false;
  appEvents.get(evt)(...a);
  return true;
})(app.emit);

const ipcMain = {
  handle(channel, fn) { handlers.set(channel, fn); },
  removeHandler(channel) { handlers.delete(channel); },
  on() {},
  removeAllListeners() {},
};

function makeWebContents() {
  const wc = {
    send: (channel, payload) => sent.push({ channel, payload }),
    on() {},
    once() {},
    executeJavaScript: async () => undefined,
    capturePage: async () => { throw new Error('not implemented in stub'); },
    openDevTools() {},
    isDestroyed: () => false,
    setWindowOpenHandler() {},
    session: { setPermissionRequestHandler() {} },
  };
  return wc;
}

class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.webContents = makeWebContents();
    this.destroyed = false;
    this.shown = false;
    windows.push(this);
  }
  loadFile() { this.shown = true; return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  show() { this.shown = true; }
  focus() {}
  close() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
  setMenuBarVisibility() {}
  setMenu() {}
  setTitle() {}
  getBounds() { return { x: 0, y: 0, width: 1280, height: 820 }; }
  static getAllWindows() { return windows.filter(w => !w.destroyed); }
  static getFocusedWindow() { return windows[windows.length - 1]; }
}

class Notification extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; notifications.push(opts); }
  show() {}
  close() {}
}

class Tray extends EventEmitter {
  constructor() { super(); this.setToolTip = () => {}; this.setContextMenu = () => {}; }
  destroy() {}
}

const Menu = { buildFromTemplate: (t) => ({ t }), setApplicationMenu() {}, createPopup: () => ({ popup() {} }) };
const nativeImage = { createFromPath: () => ({ isEmpty: () => true }), createFromDataURL: () => ({ isEmpty: () => true }) };
const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) };
const shell = {
  openExternal: async (url) => { opened.push(url); },
  openPath: async () => '',
  showItemInFolder() {},
};

module.exports = {
  app, ipcMain, BrowserWindow, Notification, Tray, Menu, nativeImage, dialog, shell,
  // --- test helpers -------------------------------------------------------
  __state: { handlers, sent, notifications, opened, appEvents, windows },
  __reset() {
    handlers.clear();
    sent.length = 0;
    notifications.length = 0;
    opened.length = 0;
    appEvents.clear();
    windows.length = 0;
  },
  __userDataDir: ensureUserData,
};