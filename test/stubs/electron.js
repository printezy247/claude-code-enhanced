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
/** Options each crashReporter.start() was called with. */
const crashReports = [];
/** OS power events (suspend/resume/unlock), emitted by tests. */
const powerMonitor = new EventEmitter();
const crashReporter = { start: (opts) => { crashReports.push(opts || {}); } };

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

/** Every window gets its own id, the way Electron numbers webContents. */
let nextWebContentsId = 1;

function makeWebContents() {
  const wc = {
    id: nextWebContentsId++,
    // The receiver is recorded too: the main process routes an event to the
    // window that owns it, and a test has to see which window got it.
    send: (channel, payload) => sent.push({ channel, payload, wcId: wc.id }),
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
  hide() { this.shown = false; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  restore() { this.shown = true; }
  minimize() { this.minimized = true; this.shown = false; }
  close() { this.destroyed = true; this.emit('closed'); }
  isDestroyed() { return this.destroyed; }
  isFocused() { return !!this.focused; }
  isMinimized() { return !!this.minimized; }
  isVisible() { return !!this.shown; }
  setSize() {}
  setBounds() {}
  setMenuBarVisibility() {}
  setMenu() {}
  setTitle() {}
  getBounds() { return { x: 0, y: 0, width: 1280, height: 820 }; }
  static getAllWindows() { return windows.filter(w => !w.destroyed); }
  static getFocusedWindow() { return windows[windows.length - 1]; }
}

class Notification extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; notifications.push(this); }
  show() {}
  close() {}
}

/** The last tray item created, so a test can click its menu. */
let lastTray = null;
class Tray extends EventEmitter {
  constructor(icon) {
    super();
    this.icon = icon;
    this.menu = null;
    this.destroyed = false;
    this.setToolTip = () => {};
    this.setContextMenu = (m) => { this.menu = m; };
    this.displayBalloon = () => {};
    lastTray = this;
  }
  destroy() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
}

const Menu = { buildFromTemplate: (t) => ({ t }), setApplicationMenu() {}, createPopup: () => ({ popup() {} }) };

// Preload support: the stub records what a preload script exposes so tests can
// drive the real src/preload/preload.js guard logic.
const exposed = new Map();
const invokeCalls = [];
const contextBridge = { exposeInMainWorld: (name, api) => exposed.set(name, api) };
const ipcRenderer = {
  invoke: async (channel, payload) => { invokeCalls.push({ channel, payload }); return { ok: true, channel }; },
  send: (channel, payload) => { invokeCalls.push({ channel, payload, send: true }); },
  on() {}, once() {}, removeListener() {},
};
// A real icon file makes a real image; a missing one makes an empty image.
// The tray path depends on this: a stub that always said "empty" made the
// whole close-to-tray branch unreachable from a test.
const nativeImage = {
  createFromPath: (file) => {
    let empty = true;
    try { empty = !fs.existsSync(file); } catch { empty = true; }
    const img = {
      isEmpty: () => empty,
      resize: () => img,
      toPNG: () => Buffer.alloc(0),
    };
    return img;
  },
  createFromDataURL: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }),
};
const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) };
const shell = {
  openExternal: async (url) => { opened.push(url); },
  openPath: async () => '',
  showItemInFolder() {},
};

module.exports = {
  app, ipcMain, BrowserWindow, Notification, Tray, Menu, nativeImage, dialog, shell,
  contextBridge, ipcRenderer, powerMonitor, crashReporter,
  // --- test helpers -------------------------------------------------------
  __state: {
    handlers, sent, notifications, opened, appEvents, windows, exposed, invokeCalls, crashReports,
    get tray() { return lastTray; },
  },
  __reset() {
    handlers.clear();
    sent.length = 0;
    notifications.length = 0;
    opened.length = 0;
    appEvents.clear();
    windows.length = 0;
    exposed.clear();
    invokeCalls.length = 0;
    nextWebContentsId = 1;
    lastTray = null;
  },
  __userDataDir: ensureUserData,
};