// Loader for the renderer scripts in a jsdom window.
//
// src/renderer/*.js are plain scripts (no modules) that read `window.ccx`,
// `document` and each other's globals. This harness builds the DOM shell from
// index.html, installs a recording `ccx` stub, then evaluates app.js and chat.js
// inside the window context and hands back everything tests need to poke at.
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

/** A DOMPurify/marked stand-in: the real ones are UMD bundles loaded by tag. */
function stubMarkdown() {
  const win = this.window;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  win.marked = {
    parse: (t) => '<p>' + escapeHtml(t) + '</p>',
  };
  win.DOMPurify = {
    sanitize: (h) => String(h),
  };
}

/**
 * Boot the renderer in jsdom.
 * @param {object} opts
 * @param {object} opts.ipc  channel -> response (or function of payload)
 * @returns {{window: Window, ccx: object, calls: Array, dom: JSDOM}}
 */
function loadRenderer(opts = {}) {
  const html = fs.readFileSync(HTML, 'utf8');
  // Strip <script src> so jsdom does not try to fetch the UMD vendor bundles.
  const stripped = html.replace(/<script[^>]*src=[^>]*>\s*<\/script>/g, '');
  // runScripts 'outside-only' is what makes window.eval available, which is how
  // the plain <script> sources below get executed against this document.
  const dom = new JSDOM(stripped, {
    url: 'https://cce.local/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  stubMarkdown.call({ window });

  const calls = [];
  const listeners = { pty: [], chat: [] };
  const ccx = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      const entry = opts.ipc || {};
      const v = entry[channel];
      if (typeof v === 'function') return await v(payload);
      return v !== undefined ? v : { ok: true };
    },
    send: (channel, payload) => { calls.push({ channel, payload, sent: true }); },
    onPtyData: (cb) => { listeners.pty.push(cb); return () => {}; },
    onPtyExit: (cb) => { listeners.chat.push(cb); return () => {}; },
    onChatEvent: (cb) => { listeners.chat.push(cb); return () => {}; },
  };
  // jsdom ships neither of these, and app.js wires a ResizeObserver at boot.
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.ccx = ccx;
  window.Terminal = class { constructor() { this.cols = 80; this.rows = 24; } loadAddon() {} open() {} focus() {} dispose() {} write() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} hasSelection() { return false; } getSelection() { return ''; } };
  window.FitAddon = { FitAddon: class { fit() {} } };
  window.monaco = { editor: {} };

  // Both files are plain scripts sharing globals (app.js reads Chat, chat.js
  // reads switchView/toast from app.js), so they must run in ONE eval scope.
  // Each source's top-level `const` is then hoisted into that shared scope, and
  // the tail re-publishes the names tests need onto window.
  const src = ['chat.js', 'app.js'].map((f) => (
    fs.readFileSync(path.join(ROOT, 'src', 'renderer', f), 'utf8')
      + '\n//# sourceURL=' + f
  )).join('\n;\n');

  window.eval(src + `
;window.Chat = Chat;
window.switchView = switchView;
window.createSession = createSession;
window.toast = toast;
window.state = state;
window.tabRegistry = tabRegistry;
window.__activate = window.__activate;
`);

  return { dom, window, ccx, calls, listeners };
}

/** Resolve once every pending microtask/timer callback has had a turn. */
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
};

module.exports = { loadRenderer, flush };