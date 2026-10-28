// Loader for the renderer scripts in a jsdom window.
//
// The renderer (src/renderer/main.js and its modules) reads `window.ccx` and
// `document`. This harness builds the DOM shell from index.html, installs a
// recording `ccx` stub, then evaluates the esbuild bundle inside the window
// context and hands back everything tests need to poke at.
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const { execFileSync } = require('child_process');

let bundled = null;
/**
 * The renderer bundle, built once per test file. It is built in a child
 * process: esbuild refuses to load inside a jsdom test environment.
 */
const bundle = () => bundled || (bundled = execFileSync(
  process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.js'), '--stdout'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
));
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
      const r = typeof v === 'function' ? await v(payload) : (v !== undefined ? v : { ok: true });
      // Most suites drive the chat the app used to open on boot. Keep it for
      // them; a suite that tests the blank home page passes welcome: false.
      if (channel === 'settings:get' && opts.welcome !== false && r && r.settings && r.settings.autoOpenWelcomeChat === undefined) {
        return { ...r, settings: { ...r.settings, autoOpenWelcomeChat: true } };
      }
      return r;
    },
    send: (channel, payload) => { calls.push({ channel, payload, sent: true }); },
    onPtyData: (cb) => { listeners.pty.push(cb); return () => {}; },
    onPtyExit: (cb) => { listeners.chat.push(cb); return () => {}; },
    onChatEvent: (cb) => { listeners.chat.push(cb); return () => {}; },
  };
  // jsdom ships neither of these, and the renderer wires both at boot.
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // scrollIntoView is called on every permission card; jsdom leaves it undefined.
  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = function () {};
  }
  window.ccx = ccx;
  window.Terminal = class { constructor() { this.cols = 80; this.rows = 24; } loadAddon() {} open() {} focus() {} dispose() {} write() {} onData() {} onResize() {} attachCustomKeyEventHandler() {} hasSelection() { return false; } getSelection() { return ''; } };
  window.FitAddon = { FitAddon: class { fit() {} } };
  window.monaco = { editor: {} };

  // The renderer is ES modules bundled by scripts/build-renderer.js. Build it in
  // memory once per test file and evaluate the resulting classic script; its
  // entry (src/renderer/main.js) publishes the globals tests reach for
  // (Chat, switchView, createSession, toast, state, ...) on window.
  // src/shared/*.js are real <script> tags in index.html (stripped above), so
  // load them here too: chat code reads window.CCEIcons/CCEThink, providers CCETpl.
  for (const f of ['icons.js', 'think.js', 'tpl.js', 'usertext.js']) {
    const s = fs.readFileSync(path.join(ROOT, 'src', 'shared', f), 'utf8');
    window.eval(s + '\n//# sourceURL=shared/' + f);
  }
  window.eval(bundle() + '\n//# sourceURL=app.bundle.js');

  return { dom, window, ccx, calls, listeners };
}

/** Resolve once every pending microtask/timer callback has had a turn. */
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0));
};

module.exports = { loadRenderer, flush };