// Claude Code Enhanced — main process.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, clipboard, nativeImage, crashReporter } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { execFile } = require('child_process');
const { probeLoginEnv } = require('./loginenv');
const { debugLog } = require('./debug');
const { swapChat } = require('./failover');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const rendererDir = path.resolve(__dirname, '..', 'renderer');

app.setName('claude-code-enhanced');
if (process.env.CCE_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox');

// Native crashes (node-pty, the GPU process) leave no trace otherwise: the
// app just dies. The dump stays on this machine — uploadToServer is off —
// so a bug report can include it without shipping anything anywhere. #fix-crash-dumps
try {
  crashReporter.start({ uploadToServer: false, compress: true, rateLimit: 60_000 });
} catch { /* crash reporter unavailable in this environment */ }

// Surface async failures with a real stack instead of an anonymous warning.
process.on('unhandledRejection', (reason) => {
  console.error('[cce] unhandled rejection:', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[cce] uncaught exception:', (err && err.stack) || err);
});

const { Store } = require('./store');
const providers = require('./providers');
const catalog = require('./catalog');
const modelsdev = require('./modelsdev');
const { AuthStore } = require('./authstore');
const oauth = require('./oauth');
const localruntimes = require('./localruntimes');
const adapters = require('./adapters');
const bedrock = require('./bedrock');
const connectors = require('./connectors');
const tools = require('./tools');
const automemory = require('./automemory');
const localmodels = require('./localmodels');
const worktrees = require('./worktrees');
const { JobQueue } = require('./jobqueue');
const { runToPR } = require('./pipeline');
const { createInterruptedStore } = require('./interrupted');
const gitsurface = require('./gitsurface');
const workers = require('./workers');
const { sanitizeModel, warmOllamaModel, pickLocalDefault, ollamaModelCtx } = localmodels;
const SessionManager = require('./sessions');
const engines = require('./engines');
const webremote = require('./webremote');
const sshhosts = require('./sshhosts');
const sdkoptions = require('./sdkoptions');
const usageparse = require('./usageparse');
const codeindex = require('./codeindex');
const autolearn = require('./autolearn');
const marketplace = require('./marketplace');
const deeplink = require('./deeplink');
const updatecheck = require('./updatecheck');
const { startProxy, clearLastGoodModel } = require('./proxy');
const { effortLevels, modelCaps } = require('./modelcontext');
// Per-launch secret the translator proxy requires on every request. The proxy
// attaches real provider API keys, so without it any local process could spend
// them. See issue #8.
const proxyToken = require('crypto').randomBytes(24).toString('hex');
let proxyPort = null;
const ChatManager = require('./chats');
const { modelContext } = require('./modelcontext');
const { WindowRegistry, route } = require('./windows');
const ipcguard = require('./ipcguard');
const ipcschemas = require('./ipcschemas');
const { createDraftStore } = require('./drafts');
const { clampMaxChars, clampIdleSeconds } = require('./toolfilter');
const { normalizeDomains } = require('./webdomains');

const store = new Store();
const auth = new AuthStore();
const sessions = new SessionManager();
// The manager needs the proxy token so proxied chats authenticate.
// Which connectors each project has used. Counted per tool call, written at most
// every couple of seconds: the second chat in a repo starts with the right ones.
const connectorauto = require('./connectorauto');
let connectorSaveTimer = null;
const connectorMemory = {
  usage: (cwd) => (store.settings.connectorUsage || {})[cwd] || {},
  note: (cwd, server) => {
    store.settings.connectorUsage = connectorauto.recordUse(store.settings.connectorUsage, cwd, server);
    if (!connectorSaveTimer) {
      connectorSaveTimer = setTimeout(() => { connectorSaveTimer = null; try { store.save(); } catch { /* disk full: next one will */ } }, 2000);
      if (connectorSaveTimer.unref) connectorSaveTimer.unref();
    }
  },
};
const chats = new ChatManager({ proxyToken, contextOf: modelContext, connectorMemory });
// Which window owns which chat and terminal session. The managers are global
// — their ids come from one counter each — so a second manager would mint the
// same ids and two windows would fight over one chat. This registry is what
// keeps the windows apart. #feat-multi-window
const windowRegistry = new WindowRegistry();
// Background runs: one at a time by default, so two long jobs never fight
// over the machine or the provider's rate limit. #feat-jobs
const jobQueue = new JobQueue({ concurrency: 1 });
// What was running when the app last stopped, so the next start can offer
// to pick it back up. #feat-run-resume
const interrupted = createInterruptedStore(path.join(app.getPath('userData'), 'interrupted-runs.json'));

providers.useAuth(auth);
let win = null;
let tray = null;
let claudeInfo = { found: false, path: '', version: '' };
// When the CLI was last looked for. A window that regains focus re-probes,
// but not more than once every 10 s. #feat-multi-window
let lastClaudeProbe = Date.now();

// Resolved secrets per provider uid, so the proxy (which resolves synchronously
// per request) never has to touch disk or hit the network mid-turn.
const secretCache = new Map(); // uid -> { apiKey, authToken }
function refreshSecretCache() {
  secretCache.clear();
  for (const p of store.providers) {
    const r = auth.resolve(p.uid);
    // A provider whose catalog entry names an environment variable (models.dev
    // records one for API-key providers such as OpenCode Go's
    // OPENCODE_API_KEY) can be authenticated from the environment when no key
    // was stored in the app. Without this the preset was unusable unless the
    // key was pasted into the UI, and the request went out with no credential
    // at all ("Go requires a credential").
    let apiKey = r.apiKey || '';
    if (!apiKey) {
      const names = providers.envVarNames ? providers.envVarNames(p) : [];
      const source = { ...(loginEnv() || {}), ...process.env };
      for (const name of names) {
        if (source[name]) { apiKey = String(source[name]).trim(); break; }
      }
    }
    secretCache.set(p.uid, { apiKey, authToken: r.authToken || '' });
  }
}
function secretFor(uid) { return secretCache.get(uid) || {}; }
// providers.ensureFreshAuth rebuilds the cache after a successful refresh.
providers.setRefreshSecretCache(refreshSecretCache);

// OAuth flows in flight, keyed by a short session id handed to the renderer.
const oauthSessions = new Map();
let oauthSeq = 0;

// Reap abandoned sign-ins. If the Connect dialog is closed without completing,
// nothing else cancels the flow — the PKCE callback server would keep listening
// and the device-flow poll would keep spinning. #sec
const OAUTH_TTL_MS = 10 * 60 * 1000;
const oauthReaper = setInterval(() => {
  const now = Date.now();
  for (const [sid, sess] of oauthSessions) {
    if (now - (sess.createdAt || 0) > OAUTH_TTL_MS) {
      try { sess.flow && sess.flow.cancel && sess.flow.cancel(); } catch { /* noop */ }
      oauthSessions.delete(sid);
    }
  }
}, 60 * 1000);
oauthReaper.unref();
/**
 * Refresh an OAuth provider's token if it is expired (or about to).
 *
 * The implementation lives in providers.js -- ONE copy, so the retry, the
 * backoff and the authExpired flag cannot drift between two copies. This
 * only injects the main-process dependencies.
 */
async function ensureFreshAuth(inst) {
  return providers.ensureFreshAuth(inst, { auth, oauth, refreshSecretCache });
}

/**
 * The app icon. build/ was not in the packaged files, so the installed app had
 * no icon file: the tray item was an empty image nobody could see or click.
 * Resolved from the app root, and a 22px copy for panels that do not scale.
 */
function appIcon(size) {
  const file = path.join(app.getAppPath(), 'build', 'icon.png');
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
  return size && !img.isEmpty() ? img.resize({ width: size, height: size, quality: 'best' }) : img;
}

/** True only when a tray item exists with a real image to click. */
function trayUsable() {
  return !!(tray && !tray.isDestroyed() && trayHasIcon);
}
let trayHasIcon = false;

/**
 * Show every window that is not visible, and focus the newest one.
 *
 * The tray must not strand a window: with two windows open, closing the
 * newest one left the older, hidden one with no way back at all. #F9
 */
function showWindows() {
  const wins = windowRegistry.windows().filter((w) => w && !w.isDestroyed());
  for (const w of wins) {
    if (typeof w.isVisible === 'function' && w.isVisible()) continue;
    try { w.show(); } catch { /* the window may be gone */ }
  }
  const newest = wins[wins.length - 1];
  if (newest) { try { newest.focus(); } catch { /* not ready yet */ } }
}

/** Build the tray icon + menu (close-to-tray). #46 */
function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const icon = appIcon(22);
  trayHasIcon = !icon.isEmpty();
  if (!trayHasIcon) { console.error('[cce] tray icon missing; close will minimize instead'); return null; }
  try {
    tray = new Tray(icon);
    tray.setToolTip('Claude Code Enhanced');
    const menu = Menu.buildFromTemplate([
      { label: 'Show', click: () => showWindows() },
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => { const c = createWindow(); try { c.win.focus(); } catch { /* not ready */ } } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => showWindows());
  } catch (err) {
    console.error('[cce] tray unavailable:', String(err.message || err));
    tray = null;
  }
  return tray;
}

// ---------- claude CLI detection -------------------------------------------
function detectClaude() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const candidates = [
      process.env.CCE_CLAUDE_PATH,
      ...(isWin
        ? [
            path.join(process.env.ProgramFiles || 'C:\Program Files', 'Claude', 'Claude.exe'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\Program Files (x86)', 'Claude', 'Claude.exe'),
          ]
        : [
            path.join(os.homedir(), '.local', 'bin', 'claude'),
            '/usr/local/bin/claude',
            '/usr/bin/claude',
            '/snap/bin/claude',
          ]),
    ].filter(Boolean);
    const found = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!found) return resolve({ found: false, path: '', version: '' });
    execFile(found, ['--version'], { timeout: 15_000 }, (err, stdout) => {
      resolve({ found: true, path: found, version: (stdout || '').trim() || 'unknown' });
    });
  });
}

function claudePath() {
  const p = (store.settings.claudePath || '').trim();
  return p || (claudeInfo.found ? claudeInfo.path : 'claude');
}

// ---------- GUI PATH hole (#13) ----------------------------------------------
// A GUI-launched app never sources .bashrc, so the agent's Bash tool could not
// see bun, uv, nvm or anything else installed there — while tools.js happily
// reported those tools as present. Resolve the login-shell environment once and
// merge it into every spawned session.
let loginEnvCache = null;
let loginEnvPending = null;
/** Probe the login shell off the main thread; shared by every caller. */
function loginEnvReady() {
  if (loginEnvCache) return Promise.resolve(loginEnvCache);
  if (!loginEnvPending) {
    loginEnvPending = probeLoginEnv().then((env) => { loginEnvCache = env; loginEnvPending = null; return env; });
  }
  return loginEnvPending;
}
/** The cached environment ({} until the first probe lands). */
function loginEnv() {
  if (!loginEnvCache) loginEnvReady();
  return loginEnvCache || {};
}
/** Re-probe the login shell (newly installed tools appear). #21 */
function refreshLoginEnv() {
  loginEnvCache = null;
  return loginEnvReady();
}
/** PATH first, then anything the login shell added that we lack. */
function envWithLoginPath(base = {}) {
  const le = loginEnv();
  if (!le.PATH || le.PATH === (base.PATH || process.env.PATH)) return base;
  return { ...le, ...base, PATH: le.PATH };
}

// Lean tool sets for small local models. Every tool schema in the base prompt
// costs context, and the engine's own prompt plus skills is already ~68K, so
// cutting the tool list is the only real lever for a 3-4B model. #41
const LEAN_PRESETS = {
  readOnly: { label: 'Read-only (no writes)', tools: ['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion'] },
  lean: { label: 'Lean coding', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion'] },
  minimal: { label: 'Minimal (read + bash)', tools: ['Read', 'Grep', 'Bash'] },
};

// Every tool the checklist can offer. MCP tools (mcp__*) are dynamic per
// session and always stay on — the allowlist only trims built-ins. #12
const LEAN_ALL_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit',
  'Bash', 'BashOutput', 'KillShell', 'Grep', 'Glob', 'Task', 'Agent', 'TodoWrite',
  'Skill', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'ExitPlanMode'];
const LEAN_KNOWN = new Set(LEAN_ALL_TOOLS);

// Per-model context override (Settings → Local models). A model name mapped
// here skips the 70K floor and loads at exactly that size. #11
function forcedCtxFor(settings, model) {
  const map = (settings && settings.forceCtx) || {};
  const hit = map[String(model || '').toLowerCase()];
  return Number(hit) > 0 ? Number(hit) : 0;
}

/** Human-readable reason for an HTTP failure, so the UI shows a fix, not a 401. */
function classifyHttpError(status, bodyText) {
  const brief = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 180);
  // The key is fine; the gateway only serves approved clients on this route.
  if (/unauthorized client/i.test(String(bodyText || ''))) {
    return 'The provider refuses this client on this route (your key is not the problem). For AgentRouter, use the "AgentRouter (Claude route)" provider, which talks to it through the real claude CLI. ' + brief;
  }
  const map = {
    400: 'Request rejected (400) — usually a bad model id.',
    401: 'API key rejected (401) — invalid key, or the provider refused this client.',
    402: 'Payment required / no credits (402).',
    403: 'Key lacks access — wrong tier, region or permissions (403).',
    404: 'Endpoint or model not found (404) — check the base URL and model id.',
    413: 'Request too large for this model\u2019s context window (413).',
    422: 'The provider rejected the request shape (422).',
    429: 'Rate limit or quota exceeded (429) — wait or check billing.',
    500: 'Provider server error (500).',
    502: 'Bad gateway from the provider (502).',
    503: 'Provider unavailable (503).',
    529: 'Provider overloaded (529).',
  };
  return (map[status] || ('HTTP ' + status + '.')) + (brief ? '  ' + brief : '');
}

/** A minimal Anthropic /v1/messages probe — for native-protocol providers. */
async function testAnthropic(base, key, keyHeader, model) {
  const url = String(base || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/messages';
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
    // Some gateways (AgentRouter) allowlist the Claude Code client signature.
    'user-agent': 'claude-cli/2.1.289 (external, cli)',
    'x-app': 'cli',
  };
  if (key) { if (keyHeader === 'bearer') headers.Authorization = 'Bearer ' + key; else headers['x-api-key'] = key; }
  try {
    const res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: model || 'claude-3-5-sonnet-latest', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text().catch(() => '');
    if (res.ok) return { ok: true, status: res.status, detail: 'Anthropic endpoint accepted the key' };
    // A 400 about the model means the key and endpoint passed; only the id is off.
    if (res.status === 400 && /model/i.test(text)) {
      const sent = model || 'claude-3-5-sonnet-latest';
      return { ok: false, status: 400, error: 'Key and endpoint accepted, but the model id "' + sent + '" is not valid here. Set a valid Default model in Options (or the Models tab).' };
    }
    return { ok: false, status: res.status, error: classifyHttpError(res.status, text) };
  } catch (err) {
    return { ok: false, error: classifyNetError(err) };
  }
}

/** Human-readable network failure (DNS / TLS / timeout / refused). */
function classifyNetError(err) {
  const m = String((err && err.message) || err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'Hostname did not resolve — check the base URL (DNS).';
  if (/certificate|SSL|TLS|unrecognized name/i.test(m)) return 'TLS handshake failed — the host has no valid certificate for that name.';
  if (/ECONNREFUSED/i.test(m)) return 'Connection refused — is the server running on that port?';
  if (/timeout|aborted/i.test(m)) return 'Timed out — the provider did not answer.';
  return m;
}

// Session ids come back from a renderer that renders untrusted model output, so
// every session-management call re-checks the shape before touching the disk.
const isSessionIdLike = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(id || ''));

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

// ---------- proxy routing -----------------------------------------------------
// Ollama and other native-Anthropic providers used to bypass the translator, so
// a text-channel tool call from a small local model reached the engine as plain
// prose and nothing happened (#1). Local models now route through the proxy too,
// which recovers those calls. Cloud Anthropic-compatible providers stay direct.
function usesProxy(provider) {
  if (!provider || !proxyPort) return false;
  if (provider.protocol && provider.protocol !== 'anthropic') return true;
  // Gateways whose Anthropic replies lack `usage` need the repairing pass-through.
  const ent = providers.entryFor(provider);
  if (ent && (ent.normalizeUsage || ent.local)) return true;
  return !!provider.baseUrl && provider.alwaysTranslate !== false && isLocalBase(provider.baseUrl);
}
function isLocalBase(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.local');
  } catch { return false; }
}
function proxyBaseUrl(provider) {
  return 'http://127.0.0.1:' + proxyPort + '/px/' + provider.uid;
}

// ---------- window ----------------------------------------------------------
function createWindow(initialState) {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14141a',
    title: 'Claude Code Enhanced',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs `electron`; a sandboxed preload cannot drag the
      // main world's Node surface into the renderer if it is ever compromised.
      sandbox: true,
      spellcheck: false,
    },
  });
  w.setMenuBarVisibility(false);
  // The newest window is the active one: the tray, the dialogs and the
  // notifications act on it. #feat-multi-window
  win = w;
  // Per-window state restore: a reopened window inherits the state captured
  // from the last closed one unless an explicit state was passed in. #C7
  if (initialState == null) {
    const captured = windowRegistry.restoreState();
    if (captured) { initialState = captured; windowRegistry.clearRestoreState(); }
  }
  // Everything this window opens belongs to it.
  const wcId = windowRegistry.add(w, initialState || {});
  // Re-probe whenever a window regains focus while we still think the CLI is
  // absent. Startup can race a claude self-update (the ~/.local/bin/claude
  // symlink is briefly dangling), which stuck the "CLI not found" banner
  // until restart. Every window gets the probe, not just the first one.
  w.on('focus', () => {
    if (claudeInfo.found || Date.now() - lastClaudeProbe < 10_000) return;
    lastClaudeProbe = Date.now();
    detectClaude().then((info) => {
      if (!info.found) return;
      claudeInfo = info;
      if (w && !w.isDestroyed()) w.webContents.send('claude:detected', info);
    });
  });

  // A markdown link in a chat must not navigate the app away from itself, and a
  // target=_blank link must not open a second window with our preload attached.
  // Both happened before: clicking a link replaced the whole UI and left the
  // user with a blank page. #6
  w.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'file:') {
        const filePath = fileURLToPath(url);
        const rel = path.relative(rendererDir, filePath);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return;
      }
      event.preventDefault();
      if (/^https?:$/.test(target.protocol)) shell.openExternal(url);
    } catch {
      event.preventDefault();
    }
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (ipcguard.isExternalLink(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Refuse every permission request the renderer could make: the app needs no
  // camera, mic, geolocation or notifications permission from the page itself.
  w.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    .catch((err) => console.error('[cce] page load failed:', String(err)));
  w.on('closed', () => {
    if (win === w) win = null;
    // A window that goes away takes its chats and its terminals with it: the
    // engine processes and the ptys would otherwise outlive their owner and
    // keep burning tokens nobody sees. #feat-multi-window
    const chatIds = windowRegistry.itemsOf(wcId, 'chats');
    const sessionIds = windowRegistry.itemsOf(wcId, 'sessions');
    // The registry forgets the window, but remembers that these items died
    // with it: a late frame for one of them is dropped instead of falling
    // back to whichever window happens to be newest. #F3
    windowRegistry.remove(wcId);
    for (const chatId of chatIds) {
      try { chats.close(chatId); } catch { /* already gone */ }
    }
    for (const sid of sessionIds) {
      try { sessions.kill(sid); } catch { /* already gone */ }
    }
  });
  // Close-to-tray: the engine processes keep running, so closing the window
  // should not kill a 40-minute turn. Opt-in in Settings. #46
  w.on('close', (e) => {
    if (!store.settings.closeToTray || app.isQuitting) return;
    e.preventDefault();
    // Hiding with no clickable tray item stranded the app: no window, no icon,
    // only pkill could end it. Without a tray, minimize instead.
    if (!trayUsable()) { w.minimize(); return; }
    w.hide();
    tray.displayBalloon({
      title: 'Claude Code Enhanced',
      content: 'Still running in the tray. Click the tray icon to reopen, or press Ctrl+Q in the window to quit.',
    });
  });
  // Ctrl+Q quits for real from the window, tray or no tray.
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && !input.shift && !input.alt && String(input.key).toLowerCase() === 'q') {
      e.preventDefault();
      app.isQuitting = true;
      app.quit();
    }
  });

  if (process.env.CCE_SMOKE) {
    w.webContents.on('did-fail-load', (_e, code, desc) =>
      debugLog('CCE_SMOKE: did-fail-load', code, desc));
    w.webContents.on('render-process-gone', (_e, details) =>
      debugLog('CCE_SMOKE: render-process-gone', JSON.stringify(details)));
    w.webContents.on('console-message', (_e, level, msg, line, source) =>
      debugLog(`CCE_SMOKE: renderer[${level}] ${source}:${line} ${msg}`));
    w.webContents.once('did-finish-load', () => {
      debugLog('CCE_SMOKE: page loaded');
      w.webContents.executeJavaScript('window.__CCE_SMOKE = true').catch(() => {});
      setTimeout(() => {
        if (!w || w.isDestroyed()) return;
        w.webContents.executeJavaScript(
          '(async () => { if (window.cceLoadMonaco) await window.cceLoadMonaco();'
          + ' const out = { monaco: !!(window.monaco && window.monaco.editor), diff: "n/a" };'
          + ' try { const d = document.createElement("div");'
          + ' d.style.cssText = "position:absolute;left:-9999px;width:500px;height:200px";'
          + ' document.body.appendChild(d);'
          + ' const e = window.monaco.editor.createDiffEditor(d);'
          + ' e.setModel({ original: window.monaco.editor.createModel("a\\nb\\nc"),'
          + ' modified: window.monaco.editor.createModel("a\\nB\\nc") });'
          + ' await new Promise(r => setTimeout(r, 1500));'
          + ' out.diff = d.querySelector(".view-lines") ? "rendered" : "no-dom";'
          + ' e.dispose(); d.remove();'
          + ' } catch (err) { out.diff = "error: " + err.message; }'
          + ' try { if (typeof switchView === "function") { switchView("usage");'
          + ' await new Promise(r => setTimeout(r, 2500));'
          + ' out.usage = (document.querySelector("#usage-summary") || {}).textContent'
          + ' .replace(/\\s+/g, " ").slice(0, 140);'
          + ' out.usageRows = document.querySelectorAll(".usage-row").length;'
          + ' switchView("terminal"); } } catch (err) { out.usage = "error: " + err.message; }'
          + ' out.scripts = [...document.scripts].map(s => s.src.split("/").pop()).join(",");'
          + ' try { const tc = await ccx.invoke("tools:check");'
          + ' out.tools = (tc.tools || []).map(x => x.name + "=" + (x.found ? "yes" : "no")).join(",");'
          + ' } catch (err) { out.tools = "error: " + err.message; }'
          // The conversation index now comes from the SDK, not a per-file disk
          // scan: prove it answers and that branch titles survived.
          + ' try { const t0 = Date.now(); const ci = await ccx.invoke("chats:index");'
          + ' out.convos = (ci.sessions || []).length + " in " + (Date.now() - t0) + "ms";'
          + ' out.convoBranch = (ci.sessions || []).filter(s => s.branch).length;'
          + ' out.convoTitled = (ci.sessions || []).filter(s => s.renamed).length;'
          + ' } catch (err) { out.convos = "error: " + err.message; }'
          // Prove the list actually renders the new branch column.
          + ' try { document.querySelector("#btn-convo-drop").click();'
          + ' await new Promise(r => setTimeout(r, 2500));'
          + ' out.convoRows = document.querySelectorAll(".convo-row").length;'
          + ' out.convoMeta = (document.querySelector(".convo-meta") || {}).textContent || "";'
          + ' } catch (err) { out.convoRows = "error: " + err.message; }'
          + ' return JSON.stringify(out); })()'
        ).then(r => debugLog('CCE_SMOKE: probe ' + r))
          .catch(e => debugLog('CCE_SMOKE: probe failed ' + e));
      }, 4000);
      const shoot2 = async (file) => {
        try {
          if (!w || w.isDestroyed()) return;
          // The dropdown is built on demand, so it may not exist yet: the
          // optional chain keeps the smoke run quiet (it used to throw a
          // null classList error that looked like an app crash).
          await w.webContents.executeJavaScript('document.querySelector("#convo-drop")?.classList.add("hidden")');
          await new Promise(r => setTimeout(r, 300));
          const img = await w.webContents.capturePage();
          fs.writeFileSync(file, img.toPNG());
          debugLog('CCE_SMOKE: shot2', file);
        } catch (e) { console.error('CCE_SMOKE: capture2 failed:', e); }
      };
      const shootNarrow = async (file) => {
        try {
          if (!w || w.isDestroyed()) return;
          w.setSize(960, 640);
          await new Promise(r => setTimeout(r, 500));
          fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
          w.setSize(1280, 860);
          debugLog('CCE_SMOKE: shot-narrow', file);
        } catch (e) { console.error('CCE_SMOKE: narrow capture failed:', e); }
      };
      const shoot = async (file) => {
        try {
          if (!w || w.isDestroyed()) return;
          const img = await w.webContents.capturePage();
          fs.writeFileSync(file, img.toPNG());
          debugLog('CCE_SMOKE: shot', file);
        } catch (e) { console.error('CCE_SMOKE: capture failed:', e); }
      };
      const out = process.env.CCE_SMOKE_OUT || '/tmp/cce-smoke.png';
      if (process.env.CCE_SMOKE_CHATTEST) {
        // Turn matrix: local / anthropic-protocol / openai-proxy providers each
        // send one real prompt; capture the pane's errors and reply.
        setTimeout(async () => {
          const probe = await w.webContents.executeJavaScript(
            '(async () => {'
            + ' const all = await ccx.invoke("providers:all");'
            + ' const want = ["Ollama", "OpenRouter", "Mistral", "Cloudflare", "Google"];'
            + ' const rows = [];'
            + ' for (const p of (all.instances || []).filter(x => want.some(w => (x.name || "").includes(w)))) {'
            + '   try {'
            + '     const id = await Chat.createSession({ cwd: "/tmp", providerUid: p.uid });'
            + '     if (!id) { rows.push({ name: p.name, stage: "create", err: "no id" }); continue; }'
            + '     const paneIdx = document.querySelectorAll(".term-pane").length - 1;'
            + '     await ccx.invoke("chat:send", { id, text: "Reply with exactly: OK" });'
            + '     let reply = null, err = null;'
            + '     for (let i = 0; i < 20; i++) {'
            + '       await new Promise(z => setTimeout(z, 3000));'
            + '       const pane = document.querySelectorAll(".term-pane")[paneIdx];'
            + '       if (!pane) break;'
            + '       const e = pane.querySelector(".msg.error-msg");'
            + '       const a = [...pane.querySelectorAll(".assistant-msg")].pop();'
            + '       if (e) { err = e.textContent.slice(0, 200); break; }'
            + '       if (a && a.textContent.trim()) { reply = a.textContent.trim().slice(0, 80); break; }'
            + '     }'
            + '     rows.push({ name: p.name, stage: "turn", reply, err });'
            + '     await ccx.invoke("chat:close", { id });'
            + '   } catch (e) { rows.push({ name: p.name, stage: "throw", err: String(e.message || e) }); }'
            + ' }'
            + ' return JSON.stringify(rows); })()'
          );
          debugLog('CCE_SMOKE: chattest ' + probe);
        }, 3000);
      }
      if (process.env.CCE_SMOKE_PROXY) {
        // Regression probe for the translator-proxy chat path: create a chat
        // with the first openai-protocol provider (spawn only — no message is
        // sent, so no provider API calls happen). Caught the v0.7.0
        // "env is not defined" ReferenceError that the default-provider smoke
        // run could never reach.
        setTimeout(() => {
          w.webContents.executeJavaScript(
            '(async () => {'
            + ' const all = await ccx.invoke("providers:all");'
            + ' const p = (all.instances || []).find(x => x.protocol === "openai");'
            + ' if (!p) return JSON.stringify({ skipped: "no openai-protocol provider" });'
            + ' const r = await ccx.invoke("chat:create", { cwd: "/tmp", providerUid: p.uid });'
            + ' const out = { provider: p.name, ok: r.ok, error: r.error || null, id: r.id || null };'
            + ' if (r.ok && r.id) { await new Promise(r2 => setTimeout(r2, 3000));'
            + '   await ccx.invoke("chat:close", { id: r.id }); }'
            + ' const locals = (all.instances || []).filter(x => x.baseUrl && String(x.baseUrl).includes("11434"));'
            + ' if (locals.length) {'
            + '   const lm = await ccx.invoke("provider:listModels", { uid: locals[0].uid });'
            + '   const pick = (lm.models || []).find(m => m.ctx && m.ctx >= 70000);'
            + '   if (pick) { const r2 = await ccx.invoke("chat:create", { cwd: "/tmp", providerUid: locals[0].uid, model: pick.id });'
            + '     out.local = { model: pick.id, ok: r2.ok, error: r2.error || null };'
            + '     if (r2.ok && r2.id) { await new Promise(r3 => setTimeout(r3, 3000)); await ccx.invoke("chat:close", { id: r2.id }); } } }'
            + ' return JSON.stringify(out); })()'
          ).then(r => debugLog('CCE_SMOKE: proxy-create ' + r))
            .catch(e => debugLog('CCE_SMOKE: proxy-create failed ' + e));
        }, 6000);
      }
      if (process.env.CCE_SMOKE_TESTALL) {
        // Test every configured provider with its real credential and list models.
        setTimeout(async () => {
          const probe = await w.webContents.executeJavaScript(
            '(async () => {'
            + ' const all = await ccx.invoke("providers:all");'
            + ' const rows = [];'
            + ' for (const inst of (all.instances || [])) {'
            + '   const t = await ccx.invoke("providers:test", { uid: inst.uid });'
            + '   let models = [];'
            + '   try { const lm = await ccx.invoke("provider:listModels", { uid: inst.uid }); models = (lm.models || []).map(m => m.id).slice(0, 6); } catch (e) { models = ["<" + e.message + ">"]; }'
            + '   rows.push({ name: inst.name, base: inst.baseUrl, model: inst.model, ok: !!t.ok, status: t.status || null, error: t.error || null, count: t.modelCount || 0, sample: models, hint: inst.authHint || null, authType: inst.authType || null });'
            + ' }'
            + ' return JSON.stringify(rows); })()'
          );
          debugLog('CCE_SMOKE: testall ' + probe);
        }, 3000);
      }
      if (process.env.CCE_SMOKE_PROVIDERS) {
        // Regression probe for the provider settings surface: catalog, auth
        // status, local scan, and the Connect/detail modals rendering.
        setTimeout(async () => {
          const probe = await w.webContents.executeJavaScript(
            '(async () => {'
            + ' const cat = await ccx.invoke("catalog:all");'
            + ' const md = await ccx.invoke("modelsdev:stats");'
            + ' const auth = await ccx.invoke("auth:status");'
            + ' const scan = await ccx.invoke("localruntimes:scan");'
            + ' const all = await ccx.invoke("providers:all");'
            + ' const first = (all.instances || [])[0];'
            + ' let test = null, tabs = 0, rows = 0;'
            + ' if (first) {'
            + '   test = await ccx.invoke("providers:test", { uid: first.uid });'
            + '   ProvidersUI.openDetail(first.uid);'
            + '   await new Promise(r => setTimeout(r, 600));'
            + '   tabs = document.querySelectorAll(".provider-detail .tab").length;'
            + '   document.querySelectorAll(".modal-overlay").forEach(o => o.remove());'
            + ' }'
            + ' ProvidersUI.openConnect();'
            + ' await new Promise(r => setTimeout(r, 400));'
            + ' rows = document.querySelectorAll(".connect-list .connect-row").length;'
            + ' document.querySelectorAll(".modal-overlay").forEach(o => o.remove());'
            + ' const diags = [];'
            + ' for (const inst of (all.instances || [])) { diags.push(await ccx.invoke("providers:diagnostics", { uid: inst.uid })); }'
            + ' return JSON.stringify({ catalog: (cat.catalog || []).length, mdProviders: md.providers,'
            + '   mdModels: md.models, mdSource: md.source, encryption: auth.encryption,'
            + '   runtimes: (scan.runtimes || []).length, testOk: test && test.ok, tabs, connectRows: rows,'
            + '   diags: diags.map(d => ({ n: d.uid.slice(0, 6), proto: d.protocol, proxy: d.usesProxy, secret: d.hasSecret, tok: d.carriesToken })) }); })()'
          );
          debugLog('CCE_SMOKE: providers ' + probe);
        }, 3000);
      }
      if (process.env.CCE_SMOKE_DIALOG) {
        // Regression probe for the Add-provider dialog: switches presets and
        // reports whether template fields populate and key-only layout holds.
        setTimeout(() => {
          w.webContents.executeJavaScript(
            '(async () => {'
            + ' openProviderEditor(null);'
            + ' const dlg = document.querySelector("#modal-root .modal");'
            + ' const sel = dlg.querySelector("select");'
            + ' const inputs = () => [...dlg.querySelectorAll("input")];'
            + ' const snap = () => { const i = inputs(); const vis = (el) => el.closest("label").style.display !== "none";'
            + '   return { name: i[0].value, base: i[1].value, baseRO: i[1].readOnly, tokenVis: vis(i[2]), model: i[4].value }; };'
            + ' const out = {};'
            + ' for (const id of ["nararouter", "cloudflare-workers-ai", "mistral", "anthropic-oauth"]) {'
            + '   sel.value = id; sel.dispatchEvent(new Event("change"));'
            + '   await new Promise(r => setTimeout(r, 250));'
            + '   out[id] = snap(); }'
            + ' dlg.closest(".modal-overlay").remove();'
            + ' return JSON.stringify(out); })()'
          ).then(r => debugLog('CCE_SMOKE: dialog ' + r))
            .catch(e => debugLog('CCE_SMOKE: dialog failed ' + e));
        }, 4500);
      }
      if (process.env.CCE_SMOKE_SEND) {
        // Round-trip test: send a tiny message through the chat engine.
        setTimeout(() => {
          debugLog('CCE_SMOKE: sending test message to', chats.lastCreatedId);
          const r = chats.send(chats.lastCreatedId, 'Reply with exactly: OK');
          debugLog('CCE_SMOKE: send ->', JSON.stringify(r));
          setTimeout(() => shoot(out + '.early.png'), 5000);
          setTimeout(async () => { await shoot(out); app.quit(); }, 60000);
        }, Number(process.env.CCE_SMOKE_SEND_DELAY || 12000));
      } else {
        setTimeout(async () => {
          await shoot(out);
          await shoot2(out.replace(/\.png$/, '.quickbar.png'));
          await shootNarrow(out.replace(/\.png$/, '.narrow.png'));
          app.quit();
        }, Number(process.env.CCE_SMOKE_DELAY || 6000));
      }
    });
  }
  // The caller needs the id: it is how a window is told apart from another
  // one in the ownership registry. #feat-multi-window
  return { id: wcId, win: w };
}

// ---------- ipc --------------------------------------------------------------
// The event is passed on to the handler: only the sender's webContents id
// proves which window a call came from, and ownership is what makes a
// cross-window call refuseable. #feat-multi-window
function isValidSender(e) {
  // A bare/absent event is an in-process call (tests). Any real event (it has
  // a `sender` or a frame) with no frame URL fails closed.
  if (!e || (!e.sender && !e.senderFrame)) return true;
  if (!e.senderFrame || !e.senderFrame.url) return false;
  return ipcguard.isAllowedSenderUrl(e.senderFrame.url, rendererDir, { packaged: app.isPackaged });
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, payload) => {
    if (!isValidSender(e)) {
      return { ok: false, error: 'Blocked IPC from unauthorized origin: ' + (e.senderFrame && e.senderFrame.url) };
    }
    // Shape check before the handler runs, so a junk argument is a readable
    // refusal rather than a crash halfway through a write.
    const badArgs = ipcschemas.validateArgs(channel, payload);
    if (badArgs) return { ok: false, error: badArgs };
    if (payload != null) {
      try {
        const sz = Buffer.byteLength(JSON.stringify(payload));
        const cap = ipcguard.payloadCap(channel);
        if (sz > cap) return { ok: false, error: 'IPC payload too large (' + sz + ' bytes)' };
      } catch { /* not stringifyable */ }
    }
    try { return { ok: true, ...(await fn(payload || {}, e)) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
}

// ---------- window ownership -------------------------------------------------
/** The id of the window that sent an IPC message, or null. */
function senderWindowId(e) {
  const id = e && e.sender && e.sender.id;
  return typeof id === 'number' ? id : null;
}

/** The window an IPC message came from, falling back to the active one. */
function senderWin(e) {
  const id = senderWindowId(e);
  if (id == null) return win;
  return windowRegistry.winOf(id) || win;
}

/**
 * Refuse an operation on a chat or session another window owns.
 *
 * Returns the error message, or null when the call is allowed. An item
 * nobody owns is allowed: it predates the registry, or it was created before
 * this window existed.
 */
function refuseForeign(kind, itemId, e) {
  if (!itemId) return null;
  const owner = windowRegistry.ownerOf(kind, itemId);
  if (owner == null) return null;
  const from = senderWindowId(e);
  if (from != null && from !== owner) {
    return 'That ' + (kind === 'chats' ? 'chat' : 'session') + ' belongs to another window.';
  }
  return null;
}

/**
 * Wrap a handler so it refuses an item another window owns.
 *
 * The id of the chat or session is the first thing every one of these
 * payloads carries, so one wrapper covers them all.
 */
function owned(kind, fn) {
  return async (payload, e) => {
    const refusal = refuseForeign(kind, payload && payload.id, e);
    if (refusal) throw new Error(refusal);
    return fn(payload, e);
  };
}

function registerIpc() {
  handle('app:info', async (args) => {
    // The banner's re-check asks for a fresh look; everything else gets the cache.
    if (args && args.refresh) claudeInfo = await detectClaude();
    return {
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    claude: claudeInfo,
    home: os.homedir(),
    };
  });

  // ----- windows -----
  // A second application window. The renderer asks; the main process owns the
  // bookkeeping, because only it knows which window owns which chat.
  handle('window:new', async () => {
    const created = createWindow();
    try { created.win.focus(); } catch { /* the window may not be ready yet */ }
    return { id: created.id, count: windowRegistry.size };
  });

  // Release ping (#47, item 25): the same GitHub release feed, but compared
  // numerically per version segment (string order said 0.9.10 < 0.9.9) and
  // with fetch failures reported as errors — never as "you are up to date".
  // 404 still means "no releases yet" (expected before the first push).
  handle('update:check', async () => {
    const current = app.getVersion();
    const r = await updatecheck.check({ current });
    if (r.error) {
      if (/404/.test(r.error)) return { current, latest: null, note: 'no releases published yet' };
      return { current, latest: null, note: r.error, error: r.error };
    }
    return { current: r.current, latest: r.latest, url: r.url, updateAvailable: r.updateAvailable };
  });

  // cce:// deep links (item 24): one parse, one pending slot, a ping to any
  // open window; the renderer pulls the pending link (so a link that arrives
  // before the renderer finishes loading is not lost in an event nobody heard).
  let pendingDeepLink = null;
  function routeDeepLink(url) {
    const d = deeplink.parseCceUrl(String(url || ''));
    if (!d || d.action === 'unknown') return;
    pendingDeepLink = d;
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('deeplink'); } catch { /* window may be closing */ }
    }
  }
  handle('deeplink:pending', async () => {
    const link = pendingDeepLink;
    pendingDeepLink = null;
    return { ok: true, link };
  });

  // ----- providers -----
  handle('providers:all', async () => ({
    presets: providers.PRESETS,
    catalog: providers.catalogEntries(),
    modelsdev: modelsdev.stat(),
    leanPresets: Object.entries(LEAN_PRESETS).map(([id, p]) => ({ id, label: p.label, tools: p.tools })),
    leanAllTools: LEAN_ALL_TOOLS.slice(),
    instances: store.providers.map(providers.publicInstance),
    defaultUid: store.settings.defaultProviderUid,
  }));

  // Provider failover chain: retry a failed turn across the next provider in
  // the list. The engine reads ANTHROPIC_BASE_URL at spawn time, so failover
  // works between turns (a chat restart), not mid-turn. #42
  handle('provider:failover', owned('chats', async ({ id }, e) => {
    const chat = chats.chats.get(id);
    if (!chat) throw new Error('chat not found');
    const order = Array.isArray(store.settings.failoverChain) ? store.settings.failoverChain : [];
    if (!order.length) return { ok: false, error: 'no failover chain configured (Settings → Providers)' };
    const current = chat.providerInstance ? chat.providerInstance.uid : null;
    const idx = order.findIndex(u => u === current);
    const nextUid = order[(idx + 1) % order.length];
    const next = store.providers.find(p => p.uid === nextUid);
    if (!next) return { ok: false, error: 'failover provider ' + nextUid + ' no longer exists' };
    await ensureFreshAuth(next);
    // The live engine cannot be re-pointed; recreate the chat on the next
    // provider and carry the model + mode over.
    const resume = chat.sessionId || null;
    const optsFor = (prov, model) => ({
      cwd: chat.cwd,
      providerInstance: prov,
      settings: { ...store.settings, ...(prov && prov.leanTools ? { leanTools: prov.leanTools } : {}) },
      model,
      permissionMode: chat.permissionMode,
      resume,
      claudePath: (store.settings.claudePath || '').trim() || undefined,
      anthropicBaseUrl: prov && usesProxy(prov) ? proxyBaseUrl(prov) : undefined,
    });
    // If the new provider cannot start, the original chat is rebuilt.
    const created = await swapChat(chats, id, optsFor(next, next.model || chat.model), optsFor(chat.providerInstance, chat.model));
    // The replacement chat belongs to the window that asked for the failover.
    // #feat-multi-window
    const owner = senderWindowId(e);
    if (owner != null) windowRegistry.claim(owner, 'chats', created.id);
    windowRegistry.release('chats', id);
    return { ok: true, from: current, to: next.uid, newId: created.id, provider: providers.publicInstance(next) };
  }));

  handle('providers:save', async ({ instance }) => {
    if (!instance || !instance.name) throw new Error('provider name required');
    providers.normalizeModelFields(instance);
    // Lean tool allowlist per provider (#41). The renderer sends a preset id; the
    // raw tool array is also accepted but validated against the known names so
    // a typo cannot silently disable a tool.
    if ('leanToolsPreset' in instance || instance.leanTools != null) {
      const id = instance.leanToolsPreset;
      delete instance.leanToolsPreset;
      if (id === '__keep') {
        // Editing an existing provider without touching the field.
      } else if (id && LEAN_PRESETS[id]) {
        instance.leanTools = LEAN_PRESETS[id].tools.slice();
      } else if (id === 'custom' && Array.isArray(instance.leanToolsCustom)) {
        // Per-tool checklist from the provider editor. #12
        instance.leanTools = instance.leanToolsCustom.map(String).filter(t => LEAN_KNOWN.has(t));
        if (!instance.leanTools.length) instance.leanTools = null;
        delete instance.leanToolsCustom;
      } else if (Array.isArray(instance.leanTools)) {
        instance.leanTools = instance.leanTools.map(String).filter(t => LEAN_KNOWN.has(t));
        if (!instance.leanTools.length) instance.leanTools = null;
      } else {
        instance.leanTools = null;
      }
    }
    // Secrets never touch config.json any more: they go to the auth store.
    const incomingKey = typeof instance.apiKey === 'string' ? instance.apiKey.trim() : '';
    const incomingToken = typeof instance.authToken === 'string' ? instance.authToken.trim() : '';
    const clearSecret = !!instance.clearSecret;
    delete instance.apiKey;
    delete instance.authToken;
    delete instance.keepApiKey;
    delete instance.keepAuthToken;
    delete instance.clearSecret;

    const list = store.providers;
    const existing = list.find(p => p.uid === instance.uid);
    if (existing) {
      Object.assign(existing, instance);
    } else {
      instance.uid = instance.uid || providers.newUid();
      list.push(instance);
    }
    const uid = existing ? existing.uid : instance.uid;
    if (clearSecret) auth.delete(uid);
    else if (incomingKey || incomingToken) auth.setApiKey(uid, incomingKey || incomingToken, { origin: 'manual' });
    refreshSecretCache();
    if (!store.settings.defaultProviderUid) store.settings.defaultProviderUid = uid;
    store.save();
    return { uid };
  });

  handle('providers:delete', async ({ uid }) => {
    store.providers = store.providers.filter(p => p.uid !== uid);
    auth.delete(uid);
    refreshSecretCache();
    if (store.settings.defaultProviderUid === uid) {
      store.settings.defaultProviderUid = store.providers[0]?.uid || null;
    }
    store.save();
    return {};
  });

  handle('providers:default', async ({ uid }) => {
    if (!store.providers.some(p => p.uid === uid)) throw new Error('unknown provider');
    store.settings.defaultProviderUid = uid;
    store.save();
    return {};
  });

  // Pre-warm a model in Ollama (loads weights into memory) before the CLI's
  // setModel validation — local models otherwise exceed its confirm timeout.
  handle('provider:warmModel', async ({ uid, model, numCtx }) => {
    const p = store.providers.find(x => x.uid === uid);
    if (!p || !p.baseUrl || !model) return { warmed: false };
    const base = p.baseUrl.replace(/\/+$/, '');
    const body = { model, prompt: '', keep_alive: '30m', stream: false };
    if (numCtx) body.options = { num_ctx: Number(numCtx) };
    try {
      const res = await fetch(base + '/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      // 404 = not an Ollama server; skip silently (other providers need no warm-up)
      return { warmed: res.ok, skipped: res.status === 404 };
    } catch (err) {
      return { warmed: false, error: String((err && err.message) || err) };
    }
  });

  // OpenCode-style dynamic model discovery: query the provider's own
  // /v1/models endpoint (Ollama, LM Studio, llama.cpp, LiteLLM, OpenRouter…)
  // so every server-side model appears in the selector without manual config.
  // Light in-memory cache (30s) so opening many chats against the same provider
  // does not hammer /v1/models on every create.
  const modelListCache = new Map(); // key -> { ts, models }
  const MODEL_LIST_TTL_MS = 30000;
  const listModelsLive = async ({ uid, baseUrl: directBase, apiKey: directKey, protocol: directProtocol }) => {
    const p = store.providers.find(x => x.uid === uid);
    const base = directBase || (p && p.baseUrl);
    const s = uid ? secretFor(uid) : {};
    const key = directKey || s.apiKey || s.authToken || '';
    const protocol = directProtocol || (p && p.protocol) || 'openai';
    if (!base) return { models: [] };
    if (protocol !== 'anthropic') {
      try {
        const prov = {
          baseUrl: base,
          apiKey: key,
          protocol,
          keyHeader: (p && p.keyHeader) || 'bearer',
          headers: (p && p.headers) || {},
          presetId: p && p.presetId,
          modelsDevId: p && p.modelsDevId,
          id: p && p.id,
        };
        const res = await adapters.listModels(prov);
        const j = await res.json();
        const raw = j.data || j.models || [];
        const models = raw.map(m => ({ id: m.id || m.name, ctx: m.context_length || m.inputTokenLimit || null, catalog: m.catalog || false }))
          .filter(m => m.id).map(m => ({ ...m, id: String(m.id).replace(/^models\//, '') }))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (models.length) return { models, curated: p ? (p.models || []) : [] };
        // If upstream has no models or failed, fall back to the models.dev catalog
        const targetId = (p && (p.presetId || p.modelsDevId || p.id)) || (bedrock.isBedrockUrl(base) ? 'amazon-bedrock' : '');
        if (targetId) {
          const cat = modelsdev.modelsFor(targetId).map(m => ({
            id: m.id, name: m.name, ctx: (m.limit && m.limit.context) || null,
            cost: m.cost, tool_call: m.tool_call, catalog: true,
          })).sort((a, b) => a.id.localeCompare(b.id));
          if (cat.length) return { models: cat, curated: p ? (p.models || []) : [], source: 'models.dev catalog' };
        }
        return { models, curated: p ? (p.models || []) : [] };
      } catch (err) {
        const targetId = (p && (p.presetId || p.modelsDevId || p.id)) || (bedrock.isBedrockUrl(base) ? 'amazon-bedrock' : '');
        if (targetId) {
          const cat = modelsdev.modelsFor(targetId).map(m => ({
            id: m.id, name: m.name, ctx: (m.limit && m.limit.context) || null,
            cost: m.cost, tool_call: m.tool_call, catalog: true,
          })).sort((a, b) => a.id.localeCompare(b.id));
          if (cat.length) return { models: cat, curated: p ? (p.models || []) : [], source: 'models.dev catalog' };
        }
        return { models: [], error: String((err && err.message) || err) };
      }
    }
    const headers = {};
    if (key) headers.Authorization = 'Bearer ' + key;
    if (s.apiKey) headers['x-api-key'] = s.apiKey;
    const pick = (json) => {
      let models = (json.data || []).map(m => ({ id: m.id, ctx: m.context_length || null }));
      if (!models.length && Array.isArray(json.models)) {
        models = json.models.map(m => ({ id: m.name || m.model, ctx: null }));
      }
      const seen = new Set();
      return models.filter(m => m.id && !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.id.localeCompare(b.id));
    };
    try {
      const res = await fetch(base + '/v1/models', { headers, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let models = pick(await res.json());
      // Ollama's OpenAI-compat /v1/models lists every tag with no context info,
      // which would disable the too-small-ctx filter. When the server answers
      // /api/tags it IS Ollama — probe per-model context so unusable models hide.
      try {
        const tagsRes = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(4000) });
        if (tagsRes.ok) {
          const names = [...new Set((((await tagsRes.json()).models) || []).map(m => m.name || m.model).filter(Boolean))];
          if (names.length) {
            models = await Promise.all(names.slice(0, 40).map(async (n) => ({ id: n, ctx: await ollamaModelCtx(base, n) })));
            models.sort((a, b) => a.id.localeCompare(b.id));
          }
        }
      } catch { /* not an Ollama server — keep the /v1/models result */ }
      // OpenRouter-style catalogs report context_length per model
      models = models.map(m => ({ ...m, ctx: m.ctx ?? null }));
      const result = { models };
      if (uid) {
        const ck = base + '|' + protocol + (key ? '|keyed' : '');
        modelListCache.set(ck, { ts: Date.now(), models: result.models });
      }
      return result;
    } catch (err) {
      // Fallback: Ollama tags + per-model context probe (so unusable ones get filtered)
      try {
        const res2 = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(6000) });
        const j2 = await res2.json();
        const names = [...new Set((j2.models || []).map(m => m.name || m.model).filter(Boolean))].sort();
        const probed = await Promise.all(names.slice(0, 40).map(async (n) => ({
          id: n, ctx: await ollamaModelCtx(base, n),
        })));
        const result2 = { models: probed };
        if (uid) {
          const ck = base + '|' + protocol + (key ? '|keyed' : '');
          modelListCache.set(ck, { ts: Date.now(), models: result2.models });
        }
        return result2;
      } catch (err2) {
        return { models: [], error: String((err2 && err2.message) || err2) };
      }
    }
  };
  const listModelsCached = async (args) => {
    const p = store.providers.find(x => x.uid === args.uid);
    const base = args.baseUrl || (p && p.baseUrl);
    const protocol = args.protocol || (p && p.protocol) || 'openai';
    const key = args.apiKey || '';
    const ck = base + '|' + protocol + (key ? '|keyed' : '');
    const cached = modelListCache.get(ck);
    if (cached && Date.now() - cached.ts < MODEL_LIST_TTL_MS) return { models: cached.models };
    return (await listModelsLive(args)) || {};
  };
  // Declared models (saved list + preset recommendations) are always offered,
  // so a failed or empty live listing never hides what the user configured.
  handle('provider:listModels', async (args) => {
    const r = (await listModelsCached(args)) || {};
    // Context-pinned copies the app creates for Ollama are an implementation detail.
    if (Array.isArray(r.models)) r.models = r.models.filter(m => !localmodels.isCtxVariant(m.id));
    const p = store.providers.find(x => x.uid === args.uid);
    const entry = p ? providers.entryFor(p) : null;
    const catModels = (p && (p.presetId || p.modelsDevId)) ? modelsdev.modelsFor(p.presetId || p.modelsDevId) : [];
    const declared = p ? [...(p.models || []), ...(entry && entry.recommendedModels || []), ...catModels.map(m => m.id)] : [];
    const have = new Set((r.models || []).map(m => m.id));
    const extra = [...new Set(declared)].filter(id => id && !have.has(id)).map(id => {
      const cm = catModels.find(m => m.id === id);
      return { id, ctx: (cm && cm.limit && cm.limit.context) || null, declared: true };
    });
    // Say what to do when a local runtime is simply not running.
    const base = args.baseUrl || (p && p.baseUrl) || '';
    if (r.error && isLocalBase(base) && !(r.models || []).length) {
      r.error = 'Nothing is listening at ' + base + ' (' + r.error + '). Start your local runtime, e.g. `ollama serve`.';
    }
    return { ...r, models: [...(r.models || []), ...extra], curated: r.curated || (p ? (p.models || []) : []) };
  });

  // ----- provider catalog / models.dev / auth / local runtimes -----
  handle('catalog:all', async () => ({ catalog: providers.catalogEntries(), modelsdev: modelsdev.stat() }));

  handle('modelsdev:refresh', async () => modelsdev.refresh());
  handle('modelsdev:stats', async () => modelsdev.stat());
  handle('catalog:models', async ({ providerId, q, limit }) => {
    if (q) return { models: modelsdev.searchModels(q, limit || 40) };
    if (!providerId) return { models: [] };
    const p = modelsdev.get(providerId);
    return {
      provider: p ? { id: p.id, name: p.name, api: p.api, npm: p.npm, doc: p.doc, env: p.env } : null,
      models: modelsdev.modelsFor(providerId),
    };
  });
  handle('catalog:model', async ({ providerId, modelId }) => ({ model: modelsdev.model(providerId, modelId) }));

  // Secret-free auth status for every provider (drives the "key set" chips).
  handle('auth:status', async ({ uids }) => ({
    uids: auth.listAll(uids || store.providers.map(p => p.uid)),
    encryption: auth.encryptionAvailable,
  }));
  handle('auth:setKey', async ({ uid, key }) => {
    if (!uid) throw new Error('uid required');
    auth.setApiKey(uid, key, { origin: 'manual' });
    refreshSecretCache();
    return { summary: auth.summary(uid) };
  });
  handle('auth:clear', async ({ uid }) => { auth.delete(uid); refreshSecretCache(); return {}; });

  // Connectivity probe: list models + classify the failure so the UI can say
  // "invalid key" instead of showing a raw 401 JSON blob.
  handle('providers:test', async ({ uid, baseUrl, apiKey, protocol, keyHeader }) => {
    const p = uid ? store.providers.find(x => x.uid === uid) : null;
    const s = uid ? secretFor(uid) : {};
    const base = baseUrl || (p && p.baseUrl) || '';
    const key = apiKey || s.apiKey || s.authToken || '';
    const proto = protocol || (p && p.protocol) || 'openai';
    if (!base) {
      return proto === 'anthropic'
        ? { ok: true, note: 'official Anthropic API', detail: key ? 'API key set' : 'no key — run /login in a terminal, or add one' }
        : { ok: false, error: 'No base URL set for this provider.' };
    }
    // Some keys only work at one of a provider's hosts; say which instead of a bare 401.
    const mismatch = providers.keyUrlMismatch(base, key);
    if (mismatch) return { ok: false, error: mismatch };
    // A local runtime is tested by asking it what it has, not by sending a
    // Claude model name it cannot know (which 404s and looks like a dead server).
    if (isLocalBase(base)) {
      try {
        const root = String(base).replace(/\/+$/, '').replace(/\/v1$/, '');
        const r = await fetch(root + '/api/tags', { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const names = (((await r.json()).models) || []).map(m => m.name || m.model).filter(Boolean);
          if (!names.length) return { ok: false, error: 'Ollama is running but has no models. Pull one, e.g. `ollama pull qwen3:4b`.' };
          return { ok: true, modelCount: names.length, detail: names.length + ' local models', endpoint: 'ollama /api/tags' };
        }
      } catch (err) {
        return { ok: false, error: 'Nothing is listening at ' + base + '. Start Ollama with `ollama serve`.' };
      }
    }
    if (proto === 'anthropic') {
      const ent = p ? providers.entryFor(p) : null;
      const t = await testAnthropic(base, key, keyHeader || (p && p.keyHeader) || 'bearer', (p && p.model) || (ent && ent.defaultModel) || '');
      return { ...t, endpoint: 'anthropic /v1/messages' };
    }
    if (bedrock.isBedrockUrl(base)) {
      // bedrock-runtime has no GET /models — probe a minimal completion.
      const t = await bedrock.probe(base, key, (p && p.model) || '');
      return { ...t, endpoint: 'bedrock /openai/v1/chat/completions' };
    }
    try {
      const prov = { baseUrl: base, apiKey: key, protocol: proto, keyHeader: keyHeader || (p && p.keyHeader) || 'bearer', headers: (p && p.headers) || {} };
      const res = await adapters.listModels(prov);
      const text = await res.text().catch(() => '');
      if (!res.ok) return { ok: false, status: res.status, error: classifyHttpError(res.status, text) };
      let count = 0;
      try { const j = JSON.parse(text); count = (j.data || j.models || []).length; } catch { /* non-JSON but 200 */ }
      // Listing models proves the key, not the model: ask the saved model for a
      // few tokens so a bad id or an unsupported request shows its real error.
      const tModel = (p && p.model) || '';
      if (tModel) {
        const cr = await adapters.callUpstream(prov, { model: tModel, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, false, AbortSignal.timeout(40_000))
          .catch((e) => ({ ok: false, status: 0, text: async () => classifyNetError(e) }));
        if (!cr.ok) {
          const ct = await cr.text().catch(() => '');
          return { ok: false, status: cr.status, modelCount: count, error: 'Key works, but model "' + tModel + '" did not answer: ' + (cr.status ? classifyHttpError(cr.status, ct) : ct) };
        }
      }
      return { ok: true, status: res.status, modelCount: count, detail: (key ? 'key accepted' : 'no key (local runtime?)') + (tModel ? ' · ' + tModel + ' replied' : '') };
    } catch (err) {
      return { ok: false, error: classifyNetError(err) };
    }
  });

  // Non-secret diagnostics: does this provider have a credential, and what
  // environment will a session actually get? (Never returns the secret itself.)
  handle('providers:diagnostics', async ({ uid }) => {
    const p = store.providers.find(x => x.uid === uid);
    if (!p) throw new Error('unknown provider');
    const env = providers.envFor(p, { ...store.settings, disableTelemetry: false });
    const s = secretFor(uid);
    return {
      uid,
      protocol: p.protocol || 'anthropic',
      baseUrl: p.baseUrl || '',
      usesProxy: usesProxy(p),
      hasSecret: !!(s.apiKey || s.authToken),
      authType: auth.typeOf(uid),
      envKeys: Object.keys(env),
      carriesToken: !!(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
      model: p.model || '',
    };
  });

  // Begin an OAuth sign-in. Returns the URL (and a device code where needed).
  handle('providers:connect', async ({ presetId, clientId, redirectUri }) => {
    const entry = catalog.byId(presetId);
    if (!entry) throw new Error('unknown provider preset');
    if (!entry.oauth) throw new Error('this provider does not use OAuth — add an API key instead');
    const cfg = { ...entry.oauth };
    if (clientId) cfg.clientId = clientId;
    if (!cfg.clientId && cfg.clientIdEnv) cfg.clientId = process.env[cfg.clientIdEnv] || '';
    if (!cfg.clientId) {
      return {
        needsClientId: true,
        hint: cfg.clientIdEnv
          ? 'Provide an OAuth application id (or set ' + cfg.clientIdEnv + ' in the environment).'
          : 'Provide an OAuth application id for this provider.',
      };
    }
    const flow = oauth.begin(presetId, cfg, { redirectUri });
    const sessionId = 'o' + (++oauthSeq);
    oauthSessions.set(sessionId, { flow, presetId, entry, cfg, createdAt: Date.now() });
    if (flow.method === 'device') {
      const ready = await flow.ready;
      return { ok: true, sessionId, method: 'device', url: ready.url, userCode: ready.userCode,
        instructions: 'Open ' + ready.url + ' and enter the code ' + ready.userCode + ', then keep this dialog open.' };
    }
    return { ok: true, sessionId, method: flow.method, url: flow.url, instructions: flow.instructions };
  });

  // Finish an OAuth sign-in: paste-code calls in with `code`; PKCE/device wait.
  handle('providers:oauth-complete', async ({ sessionId, code, uid, name, placeholders }) => {
    const sess = oauthSessions.get(sessionId);
    if (!sess) throw new Error('this sign-in expired — start it again');
    let tokens;
    if (sess.flow.method === 'code') tokens = await sess.flow.exchange(code);
    else tokens = await sess.flow.wait();
    if (sess.cfg.exchange === 'copilot') {
      const cop = await oauth.refreshCopilot(tokens.access);
      tokens = { ...tokens, access: cop.access, refresh: cop.refresh, expires: cop.expires, meta: { ...(tokens.meta || {}), copilot: true } };
    }
    let inst = uid ? store.providers.find(x => x.uid === uid) : store.providers.find(x => x.presetId === sess.presetId);
    if (!inst) {
      inst = providers.makeInstance(sess.entry, { name, placeholders });
      store.providers.push(inst);
    }
    inst.authKind = 'oauth';
    if (!inst.baseUrl) {
      const tpl = sess.entry.baseUrlTemplate || sess.entry.baseUrl || '';
      inst.baseUrl = tpl ? catalog.resolveTemplate(tpl, placeholders || inst.placeholders) : '';
    }
    auth.setOAuth(inst.uid, tokens);
    if (sess.cfg.writesCredentials === 'claude-cli' && tokens.access) oauth.writeClaudeCredentials(tokens);
    refreshSecretCache();
    if (!store.settings.defaultProviderUid) store.settings.defaultProviderUid = inst.uid;
    store.save();
    oauthSessions.delete(sessionId);
    return { ok: true, uid: inst.uid, summary: auth.summary(inst.uid), provider: providers.publicInstance(inst) };
  });
  handle('providers:oauth-cancel', async ({ sessionId }) => {
    const sess = oauthSessions.get(sessionId);
    if (sess) { try { sess.flow.cancel && sess.flow.cancel(); } catch { /* noop */ } oauthSessions.delete(sessionId); }
    return {};
  });

  // Local runtimes (Ollama / LM Studio / llama.cpp / vLLM)
  handle('localruntimes:scan', async () => {
    const extra = store.providers
      .filter(p => p.baseUrl && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(p.baseUrl))
      .map(p => ({ id: p.uid, name: p.name, baseUrl: p.baseUrl }));
    return { runtimes: await localruntimes.scan(extra) };
  });
  handle('localruntimes:models', async ({ uid, baseUrl }) => {
    const p = uid ? store.providers.find(x => x.uid === uid) : null;
    const base = baseUrl || (p && p.baseUrl);
    if (!base) throw new Error('no base URL');
    return await localruntimes.list(base);
  });
  handle('localruntimes:manage', async ({ uid, baseUrl, model, action, numCtx, keepAlive }) => {
    const p = uid ? store.providers.find(x => x.uid === uid) : null;
    const base = baseUrl || (p && p.baseUrl);
    if (!base || !model) throw new Error('base URL and model are required');
    return await localruntimes.manage(base, { model, action, numCtx, keepAlive });
  });

  // ----- connectors -----
  handle('connectors:presets', async () => ({ presets: connectors.PRESETS }));

  handle('connectors:list', async () => {
    const res = await connectors.list(claudePath());
    return res;
  });

  // Health-checked, parsed `claude mcp list` — drives the status chips in the panel.
  // The scan spawns a process and health-checks every server, so it is cached
  // for a short while; every mutation below invalidates it.
  const connectorStatus = connectors.createStatusCache({ ttl: 30_000, load: () => connectors.status(claudePath()) });
  handle('connectors:status', async () => connectorStatus.get());
  handle('connectors:refresh', async () => { connectorStatus.invalidate(); return connectorStatus.get(); });

  handle('connectors:add', async ({ presetId, scope, header }) => {
    const preset = connectors.PRESETS.find(p => p.id === presetId);
    if (!preset) throw new Error('unknown preset');
    const res = await connectors.add(claudePath(), { preset, scope, header });
    connectorStatus.invalidate();
    return res;
  });

  handle('connectors:addCustom', async ({ name, url, header, scope }) => {
    const res = await connectors.addCustom(claudePath(), { name, url, header, scope });
    connectorStatus.invalidate();
    return res;
  });

  handle('connectors:remove', async ({ name }) => {
    const res = await connectors.remove(claudePath(), { name });
    connectorStatus.invalidate();
    return res;
  });

  // ----- sessions -----
  handle('session:create', async ({ cwd, type = 'claude', providerUid, continueLast = false, yolo = false, cols = 110, rows = 28, initText = '', hostId = '' }, e) => {
    const dir = (cwd || store.settings.defaultCwd || os.homedir()).replace(/^~(?=\/|$)/, os.homedir());
    if (!fs.existsSync(dir)) throw new Error(`directory not found: ${dir}`);

    await loginEnvReady();
    let command, args = [];
    if (type === 'shell') {
      command = process.env.SHELL || 'bash';
    } else if (type === 'ssh') {
      // A remembered host, opened as a real ssh tab (item 14). The argv is an
      // array built by sshhosts.sshArgs — no shell ever sees these values.
      const hostsList = Array.isArray(store.settings.sshHosts) ? store.settings.sshHosts : [];
      const host = hostsList.find((h) => h && h.id === hostId);
      if (!host) throw new Error('unknown ssh host: ' + (hostId || '(none given)'));
      command = 'ssh';
      args = sshhosts.sshArgs(host);
    } else if (engines.REGISTRY.some((e) => e.id === type)) {
      const resolved = await engines.commandFor(type, { PATH: (await loginEnvReady()).PATH || process.env.PATH });
      if (resolved.error) throw new Error(resolved.error);
      command = resolved.command;
      args = resolved.args;
    } else if (type !== 'claude') {
      throw new Error(`unknown session type: ${type} (known: claude, shell, ssh, ${engines.REGISTRY.map((e) => e.id).join(', ')})`);
    } else {
      command = claudePath();
      if (continueLast) args.push('--continue');
      if (yolo) args.push('--dangerously-skip-permissions');
    }
    const provider = store.providers.find(p => p.uid === providerUid)
      || store.providers.find(p => p.uid === store.settings.defaultProviderUid)
      || null;
    const env = envWithLoginPath({ ...process.env, ...providers.envFor(provider, store.settings) });
    // OpenAI-protocol providers only work through the built-in translator; the
    // terminal CLI gets the same ANTHROPIC_BASE_URL override as SDK chats.
    if (usesProxy(provider)) {
      env.ANTHROPIC_BASE_URL = proxyBaseUrl(provider);
      // Proxy token, not the provider key — the proxy adds the real credential.
      env.ANTHROPIC_AUTH_TOKEN = proxyToken;
      env.ANTHROPIC_API_KEY = '';
    }
    if (!env.TERM) env.TERM = 'xterm-256color';

    const created = sessions.create({ cwd: dir, command, args, env, cols, rows, type });
    // The terminal belongs to the window that opened it. #feat-multi-window
    const owner = senderWindowId(e);
    if (owner != null) windowRegistry.claim(owner, 'sessions', created.id);
    if (initText) {
      setTimeout(() => sessions.write(created.id, initText), 1500);
    }
    return { ...created, provider: provider ? providers.publicInstance(provider) : null };
  });

  handle('session:list', async () => ({ sessions: sessions.list() }));
  ipcMain.on('session:write', (e, { id, data }) => {
    if (refuseForeign('sessions', id, e)) return;
    sessions.write(id, data);
  });
  handle('session:resize', owned('sessions', async ({ id, cols, rows }) => { sessions.resize(id, cols, rows); return {}; }));
  handle('session:kill', owned('sessions', async ({ id }) => {
    sessions.kill(id);
    windowRegistry.release('sessions', id);
    return {};
  }));

  sessions.on('data', (id, data) => {
    // The output belongs to the window that opened the session. #feat-multi-window
    const target = route(windowRegistry, 'sessions', id, win);
    if (target && !target.isDestroyed()) target.webContents.send('pty:data', { id, data });
  });
  sessions.on('exit', (id, exitCode) => {
    const target = route(windowRegistry, 'sessions', id, win);
    if (target && !target.isDestroyed()) target.webContents.send('pty:exit', { id, exitCode });
  });

  // ----- chats (Agent SDK) -----
  chats.on('event', (id, evt) => {
    if (process.env.CCE_SMOKE && evt && (evt.kind === 'error' || evt.kind === 'status')) {
      debugLog('CCE_SMOKE: chat-' + evt.kind, id, evt.kind === 'error' ? String(evt.error).slice(0, 200) : 'busy=' + evt.busy);
    }
    // The window that owns the chat: the event belongs to it, and a
    // notification about that chat must raise THAT window — not the newest
    // one, which with two windows open is a different chat's window. #F8
    const owner = route(windowRegistry, 'chats', id, win);
    // "Always allow" on a fetch: remember the site for every later chat.
    if (evt && evt.kind === 'web-domain-approved' && evt.host) {
      store.settings.webFetchDomains = normalizeDomains([...(store.settings.webFetchDomains || []), evt.host]);
      store.save();
    }
    // Desktop notification for permission prompts — the card is easy to miss
    // behind a terminal window, and an unanswered one silently times out.
    // The notification carries Allow/Deny buttons where the OS supports them
    // (Windows/macOS; on Linux it stays click-to-focus).
    if (evt && evt.kind === 'permission') {
      notify('Claude needs permission: ' + (evt.toolName || 'tool'),
        'Allow or deny from the notification, or open Claude Code Enhanced (auto-denies in 6 minutes).', owner, {
          actions: [{ type: 'button', text: 'Allow' }, { type: 'button', text: 'Deny' }],
          onAction: (i) => {
            try { chats.answer(id, evt.requestId, i === 0 ? 'allow' : 'deny'); }
            catch { /* already answered or timed out */ }
          },
        });
    }
    // Interrupted-run memory: a turn that starts is written to disk, a turn
    // that ends is forgotten. Whatever survives a restart is offered back.
    if (evt && evt.kind === 'status') {
      const live = chats.chats.get(id);
      // Engine chats are not Claude sessions: "resume interrupted run" cannot reopen them.
      if (evt.busy === true && live && !live.engine) {
        interrupted.record({ id, cwd: live.cwd || '', sessionId: live.sessionId || null, model: live.model || '' });
      } else if (evt.busy === false) {
        interrupted.forget(id);
      }
    }
    // Finished turns, but only when the window is in the background: a
    // notification for work the user is already watching is noise. #36
    if (evt && evt.kind === 'status' && evt.busy === false && store.settings.notifyOnDone !== false) {
      // The window that owns the chat decides whether the user is watching.
      // #feat-multi-window
      const focused = owner && !owner.isDestroyed() && owner.isFocused();
      // A chat whose window is gone — closed by the user, or taken down with
      // its window — has nobody to raise: the notification would be a ghost. #R1
      if (owner && !owner.isDestroyed() && !focused && !finished.has(id)) {
        finished.add(id);
        const fin = chats.chats.get(id);
        notify(((fin && fin.engine) ? fin.model : 'Claude') + ' finished', 'A turn in ' + path.basename(chats.chats.get(id)?.cwd || 'a session') + ' is ready.', owner);
      }
    }
    if (evt && evt.kind === 'status' && evt.busy === true) finished.delete(id);
    // The event belongs to the window that owns the chat. #feat-multi-window
    if (owner && !owner.isDestroyed()) owner.webContents.send('chat:event', { id, ...evt });
  });
  // Chats already busy when the window loses focus must not notify on finish.
  const finished = new Set();

  /**
   * A desktop notification.
   *
   * `target` is the window that must come up when the notification is
   * clicked: the one that owns the chat, not the newest window. #F8
   * `opts.actions` adds buttons (Windows/macOS); `opts.onAction(i)` receives
   * the index of the button that was pressed. #feat-notify-actions
   */
  function notify(title, body, target, opts) {
    if (process.env.CCE_QUIET_NOTIFY) return;
    try {
      const nOpts = { title, body };
      if (opts && opts.actions) nOpts.actions = opts.actions;
      const n = new Notification(nOpts);
      n.on('click', () => {
        // The owning window may be gone by the time the notification is
        // clicked: fall back to the newest window rather than doing nothing. #N1
        const w = (target && !target.isDestroyed()) ? target : win;
        if (w && !w.isDestroyed()) w.show();
      });
      if (opts && typeof opts.onAction === 'function') {
        n.on('action', (details) => {
          const i = details && typeof details.actionIndex === 'number' ? details.actionIndex : 0;
          try { opts.onAction(i); } catch { /* caller's problem, not the notifier's */ }
        });
      }
      n.show();
    } catch { /* notifications unavailable */ }
  }

  // Local-model pre-warm helpers live in ./localmodels (tested by scripts/check.js).
  handle('chat:create', async ({ cwd, providerUid, model, permissionMode, yolo, resume, fork, resumeAt, worktree: wantWorktree, engine }, e) => {
    // A stale or renamed cwd otherwise reaches the engine, which dies with the
    // misleading "CLI path wrong / auth expired" watchdog message.
    if (cwd) {
      const dir = path.resolve(String(cwd).replace(/^~(?=\/|$)/, os.homedir()));
      try {
        if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'not a directory: ' + dir };
      } catch { return { ok: false, error: 'directory not found: ' + dir }; }
    }
    // Codex / Antigravity / OpenCode in the chat view: the CLI runs headless,
    // one process per turn, with its own login and models. #feat-engine-chat
    if (engine) {
      const resolved = await engines.commandFor(String(engine), { PATH: (await loginEnvReady()).PATH || process.env.PATH });
      if (resolved.error) return { ok: false, error: resolved.error };
      const dir = path.resolve(String(cwd || store.settings.defaultCwd || os.homedir()).replace(/^~(?=\/|$)/, os.homedir()));
      const created = chats.createEngine({
        engine: String(engine), command: resolved.command, cwd: dir,
        env: envWithLoginPath({ ...process.env }), yolo: !!yolo, model: sanitizeModel(model || ''),
      });
      const owner = senderWindowId(e);
      if (owner != null) windowRegistry.claim(owner, 'chats', created.id);
      return created;
    }
    // Isolated git worktree per chat (desktop scratch-workspace parity). The
    // session then runs inside the worktree, not the shared checkout. #feat-worktree
    let worktree = null;
    if (wantWorktree && cwd) {
      worktree = worktrees.add(cwd);
      if (worktree.error) return { ok: false, error: worktree.error };
      cwd = worktree.path;
      resume = null;   // the fresh tree has no conversation of its own
    }
    // A worktree made for a chat that then fails to start is removed again,
    // branch and all, instead of piling up under .claude/worktrees.
    try {
    const provider = store.providers.find(p => p.uid === providerUid)
      || store.providers.find(p => p.uid === store.settings.defaultProviderUid) || null;
    if (provider) await ensureFreshAuth(provider);
    const useProxy = usesProxy(provider);
    // Local Ollama providers: pre-warm the model at a context size that fits the
    // claude engine's base prompt (Ollama's default 4-16K ctx 400s instantly).
    let effModel = sanitizeModel(model || (provider && provider.model) || '');
    // No default on a remote third-party provider: use one of its own models,
    // not the engine's default from ~/.claude/settings.json ("sonnet").
    if (!effModel && provider && provider.baseUrl && !isLocalBase(provider.baseUrl)) {
      const own = sanitizeModel(providers.chatModelFor(provider, ''));
      if (own) { effModel = own; model = own; }
    }
    if (provider && provider.baseUrl && isLocalBase(provider.baseUrl) && !effModel) {
      const picked = await pickLocalDefault(provider.baseUrl);
      if (picked) { effModel = picked; model = picked; }
    }
    // Warm local models even when the chat is routed through the translator
    // proxy: Ollama's OpenAI endpoint has no num_ctx parameter, so the proxy's
    // chat calls inherit whatever context the model loaded with — without this
    // warm they load at the Modelfile default (4-16K) and the engine's base
    // prompt can't fit. warmOllamaModel self-skips non-Ollama servers.
    if (provider && provider.baseUrl && effModel && (isLocalBase(provider.baseUrl) || !useProxy)) {
      const warm = await warmOllamaModel(provider.baseUrl, effModel, Number(store.settings.localNumCtx || localmodels.CCE_DEFAULT_CTX), { forceCtx: forcedCtxFor(store.settings, effModel), local: isLocalBase(provider.baseUrl) });
      if (!warm.ok) { worktrees.remove(worktree); return { ok: false, error: warm.error }; }
      if (warm.corrected) model = warm.corrected;   // typo/alias fixed against the server's real tags
    }
    const created = await chats.create({
      cwd, providerInstance: provider,
      // A provider's own lean tool list overrides the global setting. #41
      settings: {
        ...store.settings,
        ...(provider && Array.isArray(provider.leanTools) && provider.leanTools.length
          ? { leanTools: provider.leanTools }
          : {}),
      },
      model, permissionMode, yolo, resume, fork, resumeAt,
      anthropicBaseUrl: useProxy ? proxyBaseUrl(provider) : undefined,
      // Only override the engine when the user set an explicit path in Settings;
      // auto-wiring the system CLI stalls (SDK expects its matching engine version).
      claudePath: (store.settings.claudePath || '').trim() || undefined,
    });
    // The chat belongs to the window that opened it. #feat-multi-window
    const owner = senderWindowId(e);
    if (owner != null) windowRegistry.claim(owner, 'chats', created.id);
    // Report back the model actually in force (auto-picked or typo-corrected)
    // so the renderer's dropdown doesn't keep showing 'provider default'.
    return { ...created, model: model || '', worktree };
    } catch (err) {
      worktrees.remove(worktree);
      throw err;
    }
  });
  handle('chat:last', async ({ cwd }) => ({ sessionId: chats.lastChatFor(cwd) }));
  handle('chat:send', owned('chats', async ({ id, text, blocks, override }) => chats.send(id, text, blocks, { override })));
  handle('chat:steer', owned('chats', async ({ id, text, blocks, override }) => (override ? chats.steer(id, text, blocks, { override }) : chats.steer(id, text, blocks))));
  handle('chat:interrupt', owned('chats', async ({ id }) => { await chats.interrupt(id); return {}; }));
  handle('chat:set-model', owned('chats', async ({ id, model }) => {
    // Mid-chat model switches need the same local pre-warm as chat creation:
    // without it, Ollama serves the model at its default (tiny) context.
    const chat = chats.chats.get(id);
    const prov = chat && chat.providerInstance;
    if (prov) {
      await ensureFreshAuth(prov);
      if (prov.uid) clearLastGoodModel(prov.uid);
    }
    const eff = sanitizeModel(model || (prov && prov.model) || '');
    model = sanitizeModel(model);
    // Warm on any local base or direct (non-proxied) provider — proxied local
    // chats need it just as much, since the proxy cannot carry num_ctx.
    const needsWarm = !!(prov && prov.baseUrl) && (isLocalBase(prov.baseUrl) || !usesProxy(prov));
    if (needsWarm && eff) {
      const warm = await warmOllamaModel(prov.baseUrl, eff, Number(store.settings.localNumCtx || localmodels.CCE_DEFAULT_CTX), { forceCtx: forcedCtxFor(store.settings, eff), local: isLocalBase(prov.baseUrl) });
      if (!warm.ok) return { blocked: true, modelCtx: warm.native, error: warm.error };
      if (warm.corrected) model = warm.corrected;   // dropdown/custom entry fixed to a real tag
    }
    const r = await chats.setModel(id, model);
    return { ...(r && typeof r === 'object' ? r : null), model };
  }));
  // Switch a live chat to another saved provider. The engine reads its env at
  // spawn, so the session cannot be re-pointed mid-chat — recreate on the
  // target provider and resume the same conversation. #feat-provider-toggle
  handle('chat:set-provider', owned('chats', async ({ id, uid, model: wantModel }, e) => {
    const chat = chats.chats.get(id);
    if (!chat) return { ok: false, error: 'chat not found' };
    if (chat.busy) return { ok: false, error: 'a turn is running — stop it before switching provider' };
    const next = store.providers.find(p => p.uid === uid);
    if (!next) return { ok: false, error: 'unknown provider ' + uid };
    await ensureFreshAuth(next);
    const resume = chat.sessionId || null;
    const created = await chats.create({
      cwd: chat.cwd,
      providerInstance: next,
      // A provider's own lean tool list overrides the global setting. #41
      settings: {
        ...store.settings,
        ...(Array.isArray(next.leanTools) && next.leanTools.length ? { leanTools: next.leanTools } : {}),
      },
      model: sanitizeModel(wantModel || '') || next.model || '',
      // The mode the user picked, so "auto" survives the switch (the engine
      // mode alone cannot say whether CCE's auto policy was on).
      permissionMode: chat.autoPolicy ? 'auto' : chat.permissionMode,
      resume,
      claudePath: (store.settings.claudePath || '').trim() || undefined,
      anthropicBaseUrl: usesProxy(next) ? proxyBaseUrl(next) : undefined,
    });
    // The new chat replaces the old one in the same window. #feat-multi-window
    const owner = senderWindowId(e);
    if (owner != null) windowRegistry.claim(owner, 'chats', created.id);
    // Close the old engine AFTER the new one exists so an abort frame from the
    // old session cannot race the recreate.
    try { chats.close(id); } catch { /* already gone */ }
    windowRegistry.release('chats', id);
    return {
      ok: true, id: created.id,
      provider: providers.publicInstance(next),
      model: created.model || next.model || '',
      permissionMode: created.permissionMode || chat.permissionMode,
      autoPolicy: !!created.autoPolicy,
    };
  }));
  // Effort levels the chat's current model accepts (none = hide the picker).
  handle('chat:effort-levels', owned('chats', async ({ id }) => {
    const c = chats.chats.get(id);
    if (!c) throw new Error('chat not found');
    const prov = c.providerInstance || null;
    return { levels: effortLevels(prov, c.model || (prov && prov.model) || ''), current: c.effort || '' };
  }));
  // What the catalog says about one model (for the picker's caption and the
  // vision / context / tools warnings). Null fields mean "unknown, assume fine".
  handle('chat:model-info', async ({ id, uid, model }) => {
    const c = id ? chats.chats.get(id) : null;
    const prov = uid ? store.providers.find(p => p.uid === uid) : (c && c.providerInstance) || null;
    const m = String(model || (c && uid == null && c.model) || (prov && prov.model) || '').slice(0, 200);
    return { ok: true, model: m, context: modelContext(prov, m) || 0, ...modelCaps(prov, m) };
  });
  handle('chat:set-mode', owned('chats', async ({ id, mode }) => chats.setMode(id, mode)));
  // Per-chat reasoning effort and thinking budget. The settings existed in
  // chats.create but had no runtime control and no UI at all. #38
  handle('chat:effort', owned('chats', async ({ id, effort, thinking }) => {
    const c = chats.chats.get(id);
    if (!c) throw new Error('chat not found');
    const out = {};
    if (effort !== undefined) {
      const e = String(effort || '').trim();
      c.effort = e;
      const r = await c.q.applyFlagSettings({ effort: e || null });
      out.effort = e;
      out.applied = !!r;
    }
    if (thinking !== undefined && typeof c.q.setMaxThinkingTokens === 'function') {
      const t = Number(thinking) || 0;
      c.thinking = t;
      await c.q.setMaxThinkingTokens(t > 0 ? t : null);
      out.thinking = t;
    }
    return out;
  }));
  // Model list straight from the engine (display names, context sizes) instead
  // of the hard-coded opus/sonnet/haiku options. #39
  handle('chat:permission-answer', owned('chats', async ({ id, requestId, decision, answers, message }) => chats.answer(id, requestId, decision, answers, message)));
  handle('chat:elicit-answer', owned('chats', async ({ id, requestId, action, content }) => chats.answerElicitation(id, requestId, action, content)));
  handle('chat:close', owned('chats', async ({ id }) => {
    chats.close(id);
    windowRegistry.release('chats', id);
    // A deliberately closed chat is not an interrupted run. #feat-run-resume
    interrupted.forget(id);
    return {};
  }));
  handle('chat:skills', async ({ cwd }) => ({ skills: chats.scanSkills(cwd) }));
  handle('chat:commands', owned('chats', async ({ id }) => ({ commands: await chats.commands(id) })));
  // Desktop-parity controls
  handle('chat:context', owned('chats', async ({ id }) => ({ usage: await chats.context(id) })));
  handle('chat:checkpoints', owned('chats', async ({ id }) => ({ checkpoints: chats.checkpoints(id) })));
  handle('chat:rewind', owned('chats', async ({ id, uuid, dryRun }) => await chats.rewind(id, uuid, { dryRun: !!dryRun })));
  handle('chat:mcp', owned('chats', async ({ id, op, name, enabled, tools, policy }) => {
    if (op === 'status') return { servers: await chats.mcpStatus(id) };
    if (op === 'toggle') return { server: await chats.mcpToggle(id, name, enabled) };
    if (op === 'reconnect') return { server: await chats.mcpReconnect(id, name) };
    // Per-tool approval policy for a connector (the desktop app's
    // "always ask" for destructive connector tools). The SDK carries the
    // policy on the server definition, so the definition is resolved from the
    // CLI config — the re-registered copy must keep the server's own
    // credentials or it fails and loses every tool.
    if (op === 'policy') {
      const def = await connectors.definition(claudePath(), name);
      if (!def) throw new Error('no definition for MCP server: ' + name);
      const res = await chats.mcpSetPolicy(id, def.name, def.config, tools, policy || 'always_ask');
      return { server: await chats.mcpStatus(id), added: res && res.added, errors: (res && res.errors) || [] };
    }
    throw new Error('unknown mcp op: ' + op);
  }));
  handle('chat:agents', owned('chats', async ({ id }) => ({ agents: await chats.agents(id) })));
  handle('chat:flags', owned('chats', async ({ id, patch }) => ({ applied: await chats.applyFlags(id, patch) })));
  handle('chat:stopTask', owned('chats', async ({ id, taskId }) => await chats.stopTask(id, taskId)));
  handle('chat:supported-models', owned('chats', async ({ id }) => {
    const c = chats.chats.get(id);
    if (!c) return { models: [] };
    try { return { models: await c.q.supportedModels() }; }
    catch (err) { return { models: [], error: String(err.message || err) }; }
  }));
  // Runtime tools skills rely on (bun/uv run skill scripts, git imports skills).
  handle('tools:check', async () => await tools.check());

  // Re-read the login-shell environment so tools installed while the app is
  // running become visible to new sessions. #21
  handle('env:refresh', async () => {
    const env = await refreshLoginEnv();
    return { PATH: env.PATH || process.env.PATH || '' };
  });

  // Import skills from a git repo: clone shallow, copy every directory that
  // holds a SKILL.md into ~/.claude/skills/<name>.
  handle('skill:import', async ({ url }) => {
    const u = String(url || '').trim();
    if (!/^(https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+|git@[\w.]+:[\w.-]+\/[\w.-]+?)(\.git)?$/.test(u)) {
      throw new Error('expected a GitHub / GitLab / Bitbucket repository URL');
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-skill-'));
    try {
      await execFileAsync('git', ['clone', '--depth', '1', u, path.join(tmp, 'repo')], { timeout: 60_000 });
      const found = [];
      const walk = (d, depth) => {
        if (depth > 4 || found.length >= 10) return;
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) found.push(d);
        for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1);
      };
      walk(path.join(tmp, 'repo'), 0);
      if (!found.length) throw new Error('no SKILL.md found in that repository');
      const destRoot = path.join(process.env.HOME || os.homedir(), '.claude', 'skills');
      fs.mkdirSync(destRoot, { recursive: true });
      const copyDir = (src, dst) => {
        fs.mkdirSync(dst, { recursive: true });
        for (const e of fs.readdirSync(src, { withFileTypes: true })) {
          if (e.isSymbolicLink()) continue;   // never copy links out of a clone
          const s = path.join(src, e.name), d = path.join(dst, e.name);
          if (e.isDirectory()) copyDir(s, d);
          else fs.copyFileSync(s, d);
        }
      };
      const imported = [];
      const skipped = [];
      for (const dir of found) {
        const name = path.basename(dir);
        if (!/^[\w.-]{1,60}$/.test(name)) continue;
        const dest = path.join(destRoot, name);
        // Never silently overwrite an installed skill. #23
        if (fs.existsSync(dest)) { skipped.push(name); continue; }
        copyDir(dir, dest);
        imported.push(name);
      }
      if (!imported.length && skipped.length) {
        throw new Error('already installed: ' + skipped.join(', ') + ' — remove them first to overwrite');
      }
      if (!imported.length) throw new Error('skill folder names were not usable');
      return { imported, skipped };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Skill and agent enable/disable (#C4)
  const skilltoggle = require('./skilltoggle');
  handle('skills:toggle', async ({ name, enabled }) => {
    skilltoggle.setSkill(name, !enabled);
    return { ok: true, enabled: skilltoggle.isSkillEnabled(name) };
  });
  handle('agents:toggle', async ({ name, enabled }) => {
    skilltoggle.setAgent(name, !enabled);
    return { ok: true, enabled: skilltoggle.isAgentEnabled(name) };
  });
  // The skills manager: the list on disk, one skill's content, the enabled
  // state and a fresh scan. #p7-skills
  handle('skills:list', async ({ skillsDir, cwd }) => ({
    skills: skilltoggle.scanSkills({ skillsDir, cwd }),
  }));
  handle('skills:read', async ({ path }) => skilltoggle.readSkill(path));
  handle('cmd:detail', async ({ name, cwd }) => require('./cmddetail').commandDetail({ name, cwd }));
  handle('skills:set-enabled', async ({ name, enabled }) => {
    const res = skilltoggle.setSkillEnabled(name, !!enabled);
    return { ok: true, ...res };
  });
  // Skills sync (item 18): diff what is on disk against the last sync
  // snapshot, and drop toggles for skills that were deleted — cce-disabled.json
  // must not remember names that no longer exist.
  handle('skills:sync', async () => {
    const disk = skilltoggle.scanSkills().map((s) => String((s && s.name) || s));
    const st = skilltoggle.readStore();
    const r = skilltoggle.syncState({
      onDisk: disk,
      snapshot: Array.isArray(st.snapshot) ? st.snapshot : [],
      disabled: st.skills,
    });
    skilltoggle.writeStore({ skills: r.disabledAfter, agents: st.agents, snapshot: r.snapshot });
    return { ok: true, ...r };
  });
  // Auto-learn skills (item 19): probe prompt, proposals from the model, and
  // the pending queue. A skill file is only written when you accept it.
  const autoLearn = autolearn.createAutoLearn({
    skillsDir: path.join(process.env.HOME || os.homedir(), '.claude', 'skills'),
    storeFile: path.join(app.getPath('userData'), 'autolearn-pending.json'),
  });
  handle('skills:autolearn-prompt', async () => ({ ok: true, prompt: autolearn.PROBE_PROMPT }));
  handle('skills:autolearn-propose', async ({ text }) => ({
    ok: true,
    queued: autoLearn.addPending(autolearn.parseProposals(String(text || ''))),
  }));
  handle('skills:autolearn-pending', async () => ({ ok: true, pending: autoLearn.listPending() }));
  handle('skills:autolearn-resolve', async ({ name, accept }) => ({
    ok: true,
    ...(await autoLearn.resolve(String(name || ''), !!accept)),
  }));
  // The plugin manager: a DXT/MCPB archive is verified (manifest, then
  // signature) before anything is installed or registered. #p7-plugins
  const plugins = require('./plugins');
  // The renderer never names a file: the user picks it in a dialog and the
  // main process keeps the path. A compromised renderer therefore cannot
  // make the host read or install an arbitrary path.
  const pickedPlugins = new Map();   // path -> picked at
  const PLUGIN_PICK_TTL_MS = 10 * 60 * 1000;
  handle('plugins:list', async () => ({
    plugins: plugins.listPlugins(plugins.defaultPluginsDir()),
  }));
  handle('plugins:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a plugin (.dxt / .mcpb)',
      properties: ['openFile'],
      filters: [{ name: 'Plugin', extensions: ['dxt', 'mcpb', 'zip'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const source = res.filePaths[0];
    const info = plugins.inspectPlugin(source);
    pickedPlugins.set(source, Date.now());
    return {
      ok: true,
      source,
      manifest: info.manifest,
      manifestCheck: plugins.verifyManifest(info.manifest, { root: info.root }),
      signature: plugins.verifySignature(info.manifest, info.bytes),
      problems: info.problems,
    };
  });
  handle('plugins:install', async ({ source }) => {
    const picked = pickedPlugins.get(String(source || ''));
    if (!picked || Date.now() - picked > PLUGIN_PICK_TTL_MS) {
      throw new Error('pick the plugin file first — the install path must come from the file dialog');
    }
    return await plugins.installPlugin({
      source, targetDir: plugins.defaultPluginsDir(), cliPath: claudePath(),
    });
  });
  handle('plugins:uninstall', async ({ name }) => await plugins.uninstallPlugin({
    name, targetDir: plugins.defaultPluginsDir(), cliPath: claudePath(),
  }));

  // ---- The host-side MCP client -----------------------------------------
  // The desktop can hold an MCP connection in the host, not only in the CLI.
  // CCE's client speaks HTTP and SSE (stdio stays with the CLI) and needs no
  // dependency of its own. #p6-mcp-client
  const mcpclient = require('./mcpclient');
  // Only a server the user configured may be called: the name is resolved
  // through the CLI's own MCP config, so a renderer cannot point the host at
  // an arbitrary URL.
  const mcpTokens = new Map();   // server name -> device-flow token, memory only
  const mcpServerOf = async (name) => {
    const def = await connectors.definition(claudePath(), String(name));
    if (!def) throw new Error('no MCP server named ' + name);
    const cfg = def.config || {};
    if (cfg.type !== 'http' && cfg.type !== 'sse') {
      throw new Error('the host client speaks HTTP and SSE only; ' + name + ' is ' + cfg.type);
    }
    return cfg;
  };
  const mcpClientOf = (name, cfg) => {
    const key = String(name);
    const token = mcpTokens.get(key);
    if (token && token.expiresAt != null && token.expiresAt <= Date.now()) mcpTokens.delete(key);
    return new mcpclient.McpClient({
      url: cfg.url,
      headers: mcpclient.headersWithAuth(cfg.headers || {}, mcpTokens.get(key)),
      transport: cfg.type === 'sse' ? 'sse' : 'http',
    });
  };
  // The model reaches connectors through this broker; it holds the URLs,
  // headers and tokens, so none of them enter a prompt. Opt-in per chat.
  chats.setHostMcp(require('./hostmcp').createBroker({
    resolveServer: async (name) => {
      const def = await connectors.definition(claudePath(), String(name));
      return def ? def.config : null;
    },
    getToken: (name) => mcpTokens.get(String(name)),
    clearToken: (name) => mcpTokens.delete(String(name)),
    isToolActive: (sessionId, connector, tool) => connectors.isConnectorToolActive(sessionId, connector, tool),
  }));
  handle('mcp:list-tools', async ({ name }) => {
    const cfg = await mcpServerOf(name);
    const client = mcpClientOf(name, cfg);
    try {
      await client.initialize();
      return { ok: true, tools: await client.listTools() };
    } finally {
      await client.close();
    }
  });
  handle('mcp:call-tool', async ({ name, tool, args }) => {
    const cfg = await mcpServerOf(name);
    const client = mcpClientOf(name, cfg);
    try {
      await client.initialize();
      return { ok: true, result: await client.callTool(String(tool || ''), args || {}) };
    } finally {
      await client.close();
    }
  });
  handle('mcp:list-resources', async ({ name }) => {
    const cfg = await mcpServerOf(name);
    const client = mcpClientOf(name, cfg);
    try {
      await client.initialize();
      return { ok: true, resources: await client.listResources() };
    } finally {
      await client.close();
    }
  });
  handle('mcp:read-resource', async ({ name, uri }) => {
    const cfg = await mcpServerOf(name);
    const client = mcpClientOf(name, cfg);
    try {
      await client.initialize();
      return { ok: true, result: await client.readResource(String(uri || '')) };
    } finally {
      await client.close();
    }
  });
  handle('mcp:authenticate', async ({ name }, e) => {
    // The server is resolved through the CLI's own MCP config, so the
    // renderer cannot point the host's OAuth flow at an arbitrary host.
    const cfg = await mcpServerOf(name);
    // The code is returned the moment the server issues it, so the user can
    // type it in; polling for approval continues in the background and the
    // result is announced on 'mcp:auth-done' (the token stays in main).
    let announce;
    const codeReady = new Promise((resolve, reject) => { announce = { resolve, reject }; });
    const target = senderWin(e);
    mcpclient.deviceCodeAuth({
      url: cfg.url,
      oauth: { scopes: Array.isArray(cfg.scopes) ? cfg.scopes : undefined },
      onCode: (c) => announce.resolve({ ok: true, userCode: c.userCode, verificationUri: c.verificationUri, expiresIn: c.expiresIn }),
    }).then((tok) => {
      const expiresIn = Number(tok.expiresIn);
      mcpTokens.set(String(name), {
        accessToken: tok.accessToken,
        tokenType: tok.tokenType,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      });
      if (target && !target.isDestroyed()) target.webContents.send('mcp:auth-done', { name, ok: true });
    }).catch((err) => {
      announce.reject(err);   // no-op once the code was returned
      if (target && !target.isDestroyed()) target.webContents.send('mcp:auth-done', { name, ok: false, error: String((err && err.message) || err) });
    });
    return codeReady;
  });
  // Ollama model manager: running models, catalog, load/unload with context size
  const ollamaBase = (p) => (p && p.baseUrl ? p.baseUrl.replace(/\/+$/, '') : null);
  handle('ollama:ps', async ({ uid }) => {
    const base = ollamaBase(store.providers.find(x => x.uid === uid));
    if (!base) throw new Error('provider has no base URL');
    const res = await fetch(base + '/api/ps', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    return { models: (j.models || []).map(m => ({
      name: m.name, size: m.size, sizeVram: m.size_vram, expires: m.expires_at,
    })) };
  });
  handle('ollama:tags', async ({ uid }) => {
    const base = ollamaBase(store.providers.find(x => x.uid === uid));
    if (!base) throw new Error('provider has no base URL');
    const res = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    return { models: (j.models || []).map(m => ({
      name: m.name, size: m.size,
      paramSize: m.details && m.details.parameter_size,
      quant: m.details && m.details.quantization_level,
    })) };
  });
  handle('ollama:manage', async ({ uid, model, action, numCtx, keepAlive }) => {
    const base = ollamaBase(store.providers.find(x => x.uid === uid));
    if (!base) throw new Error('provider has no base URL');
    if (action === 'load') {
      // Same memory-aware step-down as chat pre-warm — a too-large num_ctx
      // kills the runner instead of loading.
      const warm = await warmOllamaModel(base, model, numCtx || Number(store.settings.localNumCtx || localmodels.CCE_DEFAULT_CTX), { forceCtx: forcedCtxFor(store.settings, model) });
      return { ok: warm.ok, ctx: warm.ctx, error: warm.error };
    }
    const body = { model, prompt: '', stream: false };
    if (action === 'unload') body.keep_alive = 0;
    else body.keep_alive = keepAlive || '30m';
    const res = await fetch(base + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    return { ok: res.ok, status: res.status };
  });


  handle('chat:history', async ({ cwd }) => ({ sessions: await chats.history(cwd) }));
  // Replay a stored session transcript so resumed chats show their past conversation.
  handle('chat:transcript', async ({ cwd, sessionId }) => (await chats.transcriptVia(cwd, sessionId)) || chats.transcript(cwd, sessionId));
  handle('chat:delete', async ({ cwd, sessionId }) => chats.deleteSession(cwd, sessionId));
  handle('chat:deleteFolder', async ({ cwd }) => chats.deleteFolder(cwd));
  handle('chat:fork', owned('chats', async ({ id }) => chats.forkParams(id)));

  // ----- session management through the SDK (#52) -----
  // Rename, tag (archive) and branch-from-a-message all used to be impossible
  // from CCE: a /rename done in a terminal session showed up in the list with
  // the old title, and there was no way to hide or branch a conversation.
  handle('session:rename', async ({ sessionId, title, cwd }) => {
    if (!isSessionIdLike(sessionId)) throw new Error('invalid session id');
    const { renameSession } = await chats.sdk();
    if (typeof renameSession !== 'function') throw new Error('this SDK build cannot rename sessions');
    await renameSession(sessionId, String(title || '').slice(0, 200), cwd ? { dir: cwd } : undefined);
    return {};
  });

  // Archive is a tag, not a delete: the transcript stays on disk and the row can
  // be unhidden. Deleting is still one click away in the same menu.
  handle('session:tag', async ({ sessionId, tag, cwd }) => {
    if (!isSessionIdLike(sessionId)) throw new Error('invalid session id');
    const { tagSession } = await chats.sdk();
    if (typeof tagSession !== 'function') throw new Error('this SDK build cannot tag sessions');
    await tagSession(sessionId, tag ? String(tag).slice(0, 64) : null, cwd ? { dir: cwd } : undefined);
    return {};
  });

  handle('session:fork', async ({ sessionId, upToMessageId, title, cwd }) => {
    if (!isSessionIdLike(sessionId)) throw new Error('invalid session id');
    const { forkSession } = await chats.sdk();
    if (typeof forkSession !== 'function') throw new Error('this SDK build cannot fork sessions');
    const opts = {};
    if (cwd) opts.dir = cwd;
    if (upToMessageId) opts.upToMessageId = String(upToMessageId);
    if (title) opts.title = String(title).slice(0, 200);
    const res = await forkSession(sessionId, opts);
    return { sessionId: res.sessionId, title: res.title || null };
  });

  // Subagent transcripts, for a drill-down of what a Task call actually did.
  handle('session:subagents', async ({ sessionId }) => {
    if (!isSessionIdLike(sessionId)) throw new Error('invalid session id');
    const { listSubagents } = await chats.sdk();
    if (typeof listSubagents !== 'function') return { agents: [] };
    return { agents: (await listSubagents(sessionId)) || [] };
  });

  // Memory (CLAUDE.md) — view/edit what the engine already loads
  handle('memory:read', async ({ cwd }) => {
    const home = process.env.HOME || os.homedir();
    const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    const globalPath = path.join(home, '.claude', 'CLAUDE.md');
    const dir = (cwd || '').replace(/^~(?=\/|$)/, home);
    let project = null;
    if (cwd) {
      const primary = path.join(dir, 'CLAUDE.md');
      const alt = path.join(dir, '.claude', 'CLAUDE.md');
      const primaryContent = read(primary);
      const altContent = primaryContent === null ? read(alt) : null;
      const content = primaryContent ?? altContent;
      // Report the file that actually yielded the content, not always primary.
      project = { path: primaryContent === null && altContent !== null ? alt : primary, altPath: alt, content, exists: content !== null };
    }
    return { global: { path: globalPath, content: read(globalPath) }, project };
  });
  // Auto-memory proposals: the model suggests, Jack approves. Opt-in via settings.autoMemory.
  handle('memory:probe-prompt', async () => ({ prompt: automemory.PROBE_PROMPT }));
  handle('memory:propose', async ({ cwd, text }) => ({ queued: automemory.addPending(cwd, automemory.parseProposals(text)) }));
  handle('memory:pending', async ({ cwd }) => ({ pending: automemory.listPending(cwd) }));
  handle('memory:resolve', async ({ cwd, slug, accept }) => automemory.resolve(cwd, String(slug || ''), !!accept));
  handle('memory:save', async ({ path: p, content }) => {
    const home = process.env.HOME || os.homedir();
    const real = path.resolve(String(p || '').replace(/^~(?=\/|$)/, home));
    if (real !== home && !real.startsWith(home + path.sep)) throw new Error('path outside home directory');
    const allowed = real === path.join(home, '.claude', 'CLAUDE.md')
      || /\/CLAUDE\.md$/.test(real)
      || /\/\.claude\/rules\/[\w.-]+\.md$/.test(real)
      || /\/\.claude\/settings(\.local)?\.json$/.test(real);
    if (!allowed) throw new Error('that file is not editable here');
    const text = String(content ?? '');
    if (/settings(\.local)?\.json$/.test(real)) JSON.parse(text);   // fail loud on broken JSON
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, text);
    return { saved: true, bytes: Buffer.byteLength(text) };
  });

  // Export a stored conversation to markdown. #45
  handle('chat:export', async ({ cwd, sessionId }) => {
    const { items } = chats.transcript(cwd, sessionId);
    const out = [];
    for (const it of items) {
      if (it.t === 'user') out.push('## You\n\n' + it.text);
      else if (it.t === 'assistant') out.push('## Claude\n\n' + it.text);
      else if (it.t === 'thinking') out.push('<details><summary>thinking</summary>\n\n' + it.text + '\n\n</details>');
      else if (it.t === 'tool') {
        out.push('### ' + it.name + '\n\n```json\n' + JSON.stringify(it.input || {}, null, 2).slice(0, 2000) + '\n```');
        if (it.output) out.push('```\n' + String(it.output).slice(0, 4000) + '\n```');
      }
    }
    const md = ['# Conversation ' + sessionId, '_cwd: ' + (cwd || '?') + ' · exported ' + new Date().toISOString() + '_', ''].join('\n') + out.join('\n\n');
    const res = await dialog.showSaveDialog(win, {
      defaultPath: path.join(store.settings.defaultCwd || os.homedir(), 'conversation-' + String(sessionId).slice(0, 8) + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    fs.writeFileSync(res.filePath, md);
    return { saved: true, path: res.filePath, bytes: Buffer.byteLength(md) };
  });

  // Read a file so an Edit diff can show real context lines instead of only the
  // old_string snippet, and so the split view can show a file. #29
  // The renderer must not be able to read arbitrary disk (~/.ssh, ~/.aws, …):
  // only files under a currently-open project root (a live chat or terminal
  // session cwd) are readable, resolved through realpath so `..` and symlink
  // tricks cannot escape upward.
  const readableRoots = () => {
    const home = process.env.HOME || os.homedir();
    const roots = [];
    const add = (d) => {
      if (!d) return;
      const p = path.resolve(String(d).replace(/^~(?=\/|$)/, home));
      try { roots.push(fs.realpathSync(p)); } catch { roots.push(p); }
    };
    for (const c of chats.chats.values()) add(c.cwd);
    for (const s of sessions.list()) add(s.cwd);
    return roots;
  };
  // Sensitive files that should not be read through the file:read bridge even
  // when they live under an open project (secrets, keys, tokens). The agent can
  // still read these itself through the claude CLI; this only blocks the host
  // bridge that the renderer uses for diffs and @-mentions.
  const SENSITIVE_RE = /\.env$|\.env\.|\.pem$|\.key$|id_(rsa|ed25519|ecdsa)|\.gnupg|google_credentials|service_account|credentials\.json$|secrets\./i;
  // Guarded text save for the visual markdown editor (item 21). Same readable
  // roots as file:read, never a sensitive file, only .md/.markdown/.txt, and
  // the same size ceiling — the renderer cannot use this to rewrite config or
  // credentials, only prose files inside an open project.
  handle('file:saveText', async ({ path: p, content }) => {
    if (!p) throw new Error('path required');
    const home = process.env.HOME || os.homedir();
    const real = path.resolve(String(p).replace(/^~(?=\/|$)/, home));
    let target;
    try { target = fs.realpathSync(real); } catch { target = real; }   // new file: parent must exist below
    const roots = readableRoots();
    if (!roots.some((r) => target === r || target.startsWith(r + path.sep))) {
      throw new Error('path is outside any open project');
    }
    if (SENSITIVE_RE.test(target)) throw new Error('that file is not editable here');
    if (!/\.(md|markdown|txt)$/i.test(target)) throw new Error('only .md/.markdown/.txt files can be saved here');
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('file too large (1 MB max)');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), path: target };
  });

  handle('file:read', async ({ path: p, maxBytes }) => {
    if (!p) throw new Error('path required');
    const home = process.env.HOME || os.homedir();
    const real = path.resolve(String(p).replace(/^~(?=\/|$)/, home));
    let target;
    try { target = fs.realpathSync(real); } catch { throw new Error('file not found'); }
    const roots = readableRoots();
    if (!roots.some((r) => target === r || target.startsWith(r + path.sep))) {
      throw new Error('path is outside any open project');
    }
    if (SENSITIVE_RE.test(target)) throw new Error('that file is not readable here');
    const limit = Math.min(Number(maxBytes) > 0 ? Number(maxBytes) : 200000, 2000000);
    const st = fs.statSync(target);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > limit) return { path: target, tooLarge: true, size: st.size, content: '' };
    return { path: target, tooLarge: false, size: st.size, content: fs.readFileSync(target, 'utf8') };
  });

  // Everything the engine reads as memory/rules for a project — one panel edits them.
  handle('memory:files', async ({ cwd }) => {
    const home = process.env.HOME || os.homedir();
    const dir = (cwd || '').replace(/^~(?=\/|$)/, home);
    const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
    const files = [];
    const add = (label, p) => { const c = read(p); if (c !== null) files.push({ label, path: p, content: c }); };
    const addNew = (label, p) => { if (read(p) === null) files.push({ label, path: p, content: '' }); };

    addNew('global CLAUDE.md', path.join(home, '.claude', 'CLAUDE.md'));
    addNew('project CLAUDE.md', path.join(dir, 'CLAUDE.md'));
    addNew('project CLAUDE.md (.claude)', path.join(dir, '.claude', 'CLAUDE.md'));
    const listMd = (root, label) => {
      try {
        for (const f of fs.readdirSync(root).filter(x => x.endsWith('.md')).slice(0, 30)) {
          add(label + ' ' + f, path.join(root, f));
        }
      } catch { /* no dir */ }
    };
    listMd(path.join(home, '.claude', 'rules'), 'rule:');
    listMd(path.join(dir, '.claude', 'rules'), 'rule:');
    add('user settings (hooks)', path.join(home, '.claude', 'settings.json'));
    add('project settings (hooks)', path.join(dir, '.claude', 'settings.json'));
    add('local settings (hooks)', path.join(dir, '.claude', 'settings.local.json'));
    return { files };
  });

  // git context for the chat header (project folder + linked GitHub repo)
  handle('git:info', async ({ cwd }) => {    const dir = (cwd || '').replace(/^~(?=\/|$)/, os.homedir());
    const run = (args) => new Promise((resolve) => {
      execFile('git', args, { cwd: dir, timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
    });
    const [remote, branch, dirty, inside] = await Promise.all([
      run(['remote', 'get-url', 'origin']),
      run(['branch', '--show-current']),
      run(['status', '--porcelain']),
      run(['rev-parse', '--is-inside-work-tree']),
    ]);
    let repo = null;
    const m = remote && remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (m) repo = m[1];
    const dirtyCount = dirty ? dirty.split('\n').filter(Boolean).length : 0;
    // Porcelain lines: "XY path" — the file list feeds the right-hand
    // tasks panel's Changes section.
    const files = dirty ? dirty.split('\n').filter(Boolean).slice(0, 60).map(l => l.slice(3)) : [];
    // `ok` matters: the right-hand panel drops the whole card when it is
    // missing, so the git rows and the changed-file list never appeared.
    // `isRepo` separates "no repository here" from "a repository with no
    // remote" — without it the Overview claimed "working tree clean" in a
    // folder that is not under git at all.
    return { ok: true, remote, branch, repo, dirty: dirtyCount, files, isRepo: inside === 'true' };
  });

  // ---- The git surface (the desktop's side panel) ------------------------
  // The diff, the stats, the commit list and one commit's patch. The status
  // is cached for a few seconds, so a panel that polls does not spawn a git
  // process per frame. #p8-git-surface
  handle('git:diff', async ({ cwd, staged, paths, context }) =>
    await gitsurface.diff(cwd, { staged: !!staged, paths, context }));
  handle('git:diff-stats', async ({ cwd, staged, paths }) =>
    await gitsurface.diffStats(cwd, { staged: !!staged, paths }));
  handle('git:commits', async ({ cwd, limit }) => await gitsurface.commits(cwd, { limit }));
  handle('git:commit-diff', async ({ cwd, sha }) => await gitsurface.commitDiff(cwd, { sha }));
  handle('git:status', async ({ cwd }) => await gitsurface.status(cwd));
  handle('git:cache-invalidate', async ({ cwd }) => gitsurface.invalidate(cwd));

  // package.json scripts / Makefile targets for the ▶ run menu
  handle('project:scripts', async ({ cwd }) => {
    const dir = (cwd || '').replace(/^~(?=\/|$)/, os.homedir());
    const out = { scripts: [], hasMakefile: false };
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      out.scripts = Object.keys(pkg.scripts || {}).slice(0, 24);
    } catch { /* no package.json */ }
    try { out.hasMakefile = fs.existsSync(path.join(dir, 'Makefile')); } catch { /* ignore */ }
    return out;
  });

  // project file list for @-mentions
  handle('project:files', async ({ cwd }) => {
    const dir = (cwd || '').replace(/^~(?=\/|$)/, os.homedir());
    const gitLs = await new Promise((resolve) => {
      execFile('git', ['ls-files'], { cwd: dir, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    });
    if (gitLs) return { files: gitLs.split('\n').filter(Boolean).slice(0, 3000) };
    // The walk runs on a worker thread: a big folder used to block the main
    // process (and with it the whole window) while it read the tree. The
    // worker falls back to the in-process walk if it cannot start.
    // #t0-workers
    try {
      const files = await workers.run('file-index', { dir, limit: 3000 });
      if (Array.isArray(files)) return { files: files.slice(0, 3000) };
    } catch (err) {
      console.warn('[project:files] the file index worker failed:', String((err && err.message) || err));
    }
    const files = [];
    const walk = (d, depth) => {
      if (depth > 6 || files.length > 2500) return;
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else files.push(path.relative(dir, p));
        if (files.length > 2500) return;
      }
    };
    walk(dir, 0);
    return { files: files.slice(0, 3000) };
  });

  // Full-text search across the stored transcripts. The scan runs on a
  // worker thread so a big ~/.claude/projects tree does not freeze the
  // window. #t0-workers
  handle('chats:search', async ({ query, dir, limit }) => {
    const q = String(query || '').trim();
    if (!q) return { query: q, matches: [], count: 0 };
    const root = dir || path.join(process.env.HOME || os.homedir(), '.claude', 'projects');
    try {
      const res = await workers.run('transcript-search', { query: q, dir: root, limit: limit || 200 });
      return {
        query: q,
        count: Array.isArray(res && res.matches) ? res.matches.length : 0,
        matches: Array.isArray(res && res.matches) ? res.matches : [],
      };
    } catch (err) {
      console.warn('[chats:search] the transcript search worker failed:', String((err && err.message) || err));
      return { query: q, matches: [], count: 0, error: String((err && err.message) || err) };
    }
  });

  // desktop-style history index: every session on disk, flat + recency-sorted
  handle('chats:index', async () => ({ sessions: await chats.index() }));
  // The board: every live chat with what it is doing and whether it needs
  // the user. #feat-board
  handle('chats:board', async () => ({
    rows: [...chats.chats.entries()].map(([id, c]) => ({
      id,
      cwd: c.cwd || '',
      busy: !!c.busy,
      needsYou: chats._permsOf(id).length,
      model: c.model || '',
      sessionId: c.sessionId || null,
    })),
  }));
  // ---- Phase 3 (items 11-14) --------------------------------------------------
  // Engine tabs: which Codex/Antigravity/OpenCode binaries are on PATH. #feat-engines
  handle('engines:list', async () => ({
    engines: await engines.detect({ PATH: (await loginEnvReady()).PATH || process.env.PATH }),
  }));
  // Per-agent model overrides: which model each subagent runs. #feat-agent-models
  handle('agents:models', async () => {
    const defs = sdkoptions.agentDefinitions(sdkoptions.agentDirs(store.settings.defaultCwd));
    return { agents: Object.keys(defs).sort(), overrides: { ...(store.settings.agentModels || {}) } };
  });
  handle('agents:set-model', async ({ name, model }) => {
    const n = String(name || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) throw new Error('invalid agent name');
    const overrides = { ...(store.settings.agentModels || {}) };
    const m = sanitizeModel(model || '');
    if (m) overrides[n] = m; else delete overrides[n];
    store.settings = { ...store.settings, agentModels: overrides };
    return { overrides };
  });
  // Web/QR remote (item 13): loopback server, pairing token in the QR. #feat-webremote
  const remote = webremote.createWebRemote({
    boardRows: () => [...chats.chats.entries()].map(([id, c]) => ({
      id, cwd: c.cwd || '', busy: !!c.busy, needsYou: chats._permsOf(id).length,
    })),
    pendingPerms: () => [...chats.pendingPerms.entries()].map(([requestId, p]) => ({
      requestId, chatId: p.chatId, toolName: p.toolName,
    })),
    send: async (id, text) => {
      if (!chats.chats.has(id)) return { ok: false, error: 'no such chat' };
      await chats.send(id, text);
      return { ok: true };
    },
    answer: (requestId, decision) => {
      const p = chats.pendingPerms.get(requestId);
      if (!p) return { ok: false, error: 'no such request' };
      chats.answer(p.chatId, requestId, decision);
      return { ok: true };
    },
  });
  const remoteQrFor = async (url) => {
    try {
      const QRCode = require('qrcode');
      return await QRCode.toString(url, { type: 'svg', margin: 1 });
    } catch { return ''; }
  };
  handle('webremote:status', async () => ({ ...remote.status(), qr: '' }));
  handle('webremote:start', async () => {
    const status = await remote.start({ host: '127.0.0.1', port: 0 });
    return { ...status, qr: await remoteQrFor(status.url) };
  });
  handle('webremote:stop', async () => { remote.stop(); return { running: false }; });
  // SSH hosts (item 14): remembered machines, opened as terminal tabs. #feat-ssh
  handle('sshhosts:list', async () => ({
    hosts: (Array.isArray(store.settings.sshHosts) ? store.settings.sshHosts : []).map((h) => ({ ...h })),
  }));
  handle('sshhosts:save', async ({ host }) => {
    const rec = sshhosts.normalize(host || {});
    const list = Array.isArray(store.settings.sshHosts) ? [...store.settings.sshHosts] : [];
    const id = rec.id || sshhosts.newId();
    const saved = { ...rec, id };
    const at = list.findIndex((h) => h && h.id === id);
    if (at >= 0) list[at] = saved; else list.push(saved);
    store.settings = { ...store.settings, sshHosts: list };
    return { host: saved };
  });
  handle('sshhosts:delete', async ({ id }) => {
    const list = (Array.isArray(store.settings.sshHosts) ? store.settings.sshHosts : [])
      .filter((h) => !(h && h.id === id));
    store.settings = { ...store.settings, sshHosts: list };
    return { ok: true };
  });
  // Background jobs: queue, list, cancel. Done/failed jobs notify. #feat-jobs
  // Codebase index (item 15): build/search/status for the current project.
  // The stored index is JSON per cwd; nothing leaves the machine.
  const projIndex = codeindex.shared();
  const idxDir = (cwd) => String(cwd || store.settings.defaultCwd || os.homedir());
  handle('codeindex:build', async ({ cwd }) => ({ ok: true, ...(await projIndex.build(idxDir(cwd))) }));
  handle('codeindex:status', async ({ cwd }) => ({ ok: true, ...projIndex.status(idxDir(cwd)) }));
  handle('codeindex:search', async ({ cwd, query }) => ({
    ok: true,
    hits: projIndex.search(idxDir(cwd), String(query || '')),
  }));

  // Marketplace (item 20): a curated catalog. MCP entries install through the
  // exact connector path the Connectors view uses (nothing downloaded); plugin
  // entries open their HTTPS page — unpacking stays local-file-only in plugins.js.
  handle('marketplace:list', async () => ({ ok: true, entries: marketplace.list() }));
  handle('marketplace:install', async ({ id }) => marketplace.install(String(id || ''), {
    addConnector: async (cfg) => {
      if (cfg.preset) {
        const preset = connectors.PRESETS.find((p) => p.id === cfg.preset);
        if (!preset) throw new Error('unknown preset: ' + cfg.preset);
        return connectors.add(claudePath(), { preset, scope: 'user' });
      }
      return connectors.addCustom(claudePath(), { name: cfg.name, url: cfg.url, scope: 'user' });
    },
    openExternal: (url) => shell.openExternal(String(url)),
  }));

  jobQueue.on('update', (job) => {
    if (job.state === 'done' || job.state === 'failed') {
      notify('Background job ' + (job.state === 'done' ? 'finished' : 'failed'),
        job.label + (job.error ? ' — ' + job.error : ''), win);
    }
  });
  /** Resolves when the chat's current turn ends (or the chat is gone). */
  const waitForIdle = (id, timeoutMs = 30 * 60 * 1000) => new Promise((resolve) => {
    const onEvt = (eid, evt) => {
      if (eid !== id || !evt) return;
      if (evt.kind === 'status' && evt.busy === false) { cleanup(); resolve({ ok: true }); }
      else if (evt.kind === 'exit' || evt.kind === 'error') { cleanup(); resolve({ ok: false, error: evt.error || 'exited' }); }
    };
    const timer = setTimeout(() => { cleanup(); resolve({ ok: false, error: 'turn timed out after 30 minutes' }); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); chats.off('event', onEvt); };
    chats.on('event', onEvt);
  });
  handle('jobs:list', async () => ({ jobs: jobQueue.list() }));
  handle('jobs:cancel', async ({ id }) => ({ canceled: jobQueue.cancel(String(id || '')) }));
  // A background chat run: created without a window, prompted, waited on,
  // closed. Permission prompts still raise a notification (with Allow/Deny).
  handle('jobs:add', async ({ cwd, prompt, label, providerUid, model }) => {
    if (!prompt) return { ok: false, error: 'a prompt is required' };
    let dir = null;
    if (cwd) {
      dir = path.resolve(String(cwd).replace(/^~(?=\/|$)/, os.homedir()));
      try { if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'not a directory: ' + dir }; }
      catch { return { ok: false, error: 'directory not found: ' + dir }; }
    }
    const provider = store.providers.find(p => p.uid === providerUid)
      || store.providers.find(p => p.uid === store.settings.defaultProviderUid) || null;
    const job = jobQueue.add({
      kind: 'chat',
      label: String(label || prompt).slice(0, 120),
      cwd: dir || '',
      run: async (j) => {
        const created = await chats.create({
          cwd: dir || store.settings.defaultCwd || os.homedir(),
          providerInstance: provider,
          settings: store.settings,
          model: sanitizeModel(model || (provider && provider.model) || ''),
          claudePath: (store.settings.claudePath || '').trim() || undefined,
        });
        j.log.push('chat ' + created.id);
        try {
          const sent = chats.send(created.id, String(prompt));
          if (sent && sent.ok === false) throw new Error(sent.error || 'could not send the prompt');
          const end = await waitForIdle(created.id);
          if (!end.ok) throw new Error(end.error || 'the run failed');
        } finally {
          try { chats.close(created.id); } catch { /* already gone */ }
        }
        return { chatId: created.id };
      },
    });
    return { job };
  });
  // Task → PR: worktree, run, commit, push, open the PR — as one queued job.
  // #feat-pipeline
  handle('pipeline:start', async ({ cwd, prompt, title, providerUid }) => {
    if (!cwd || !prompt) return { ok: false, error: 'folder and prompt are required' };
    const dir = path.resolve(String(cwd).replace(/^~(?=\/|$)/, os.homedir()));
    try { if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'not a directory: ' + dir }; }
    catch { return { ok: false, error: 'directory not found: ' + dir }; }
    const provider = store.providers.find(p => p.uid === providerUid)
      || store.providers.find(p => p.uid === store.settings.defaultProviderUid) || null;
    const job = jobQueue.add({
      kind: 'pipeline',
      label: 'task → PR: ' + String(title || prompt).slice(0, 80),
      cwd: dir,
      run: () => runToPR({
        worktree: async (d) => worktrees.add(d),
        createChat: async ({ cwd: c }) => chats.create({
          cwd: c, providerInstance: provider, settings: store.settings,
          model: sanitizeModel((provider && provider.model) || ''),
          claudePath: (store.settings.claudePath || '').trim() || undefined,
        }),
        send: async (id, text) => {
          const r = chats.send(id, text);
          if (r && r.ok === false) throw new Error(r.error || 'could not send the prompt');
        },
        waitIdle: (id) => waitForIdle(id),
        git: async (args, cw) => execFileAsync('git', args, { cwd: cw, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }).then(r => r.stdout),
        hasGh: () => execFileAsync('gh', ['--version'], { timeout: 10000 }).then(() => true, () => false),
        ghPr: async (args, cw) => execFileAsync('gh', args, { cwd: cw, timeout: 120000 }).then(r => r.stdout),
        closeChat: async (id) => { try { chats.close(id); } catch { /* already gone */ } },
      }, { cwd: dir, prompt: String(prompt), title: title ? String(title) : '' }),
    });
    return { job };
  });
  // Interrupted runs from the previous start. Anything still on disk whose
  // chat is not live is a run that was cut short. #feat-run-resume
  handle('runs:interrupted', async () => ({
    runs: interrupted.list().filter(r => !chats.chats.has(r.id)),
  }));
  handle('runs:ack', async ({ id }) => { interrupted.forget(String(id || '')); return {}; });

  // Usage dashboard: sum total_cost_usd over result frames in stored transcripts.
  handle('usage:scan', async () => {
    const home = process.env.HOME || os.homedir();
    const root = path.join(home, '.claude', 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return { days: [], total: 0 }; }
    const files = [];
    for (const d of dirs) {
      const p = path.join(root, d.name);
      let list = [];
      try { list = fs.readdirSync(p).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of list) {
        try {
          const full = path.join(p, f);
          const st = fs.statSync(full);
          files.push({ full, mtime: st.mtimeMs, size: st.size });
        } catch { /* skip */ }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);

    const days = new Map();
    const models = new Map();
    let total = 0, counted = 0;
    const slice = files.slice(0, 500);
    for (let i = 0; i < slice.length; i++) {
      const f = slice[i];
      // Transcripts can be megabytes — yield so the window stays responsive.
      if (i && i % 10 === 0) await new Promise((r) => setImmediate(r));
      let text = '';
      try {
        const fd = fs.openSync(f.full, 'r');
        try {
          const len = Math.min(f.size, 2 * 1024 * 1024);        // cap huge transcripts
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, 0);
          text = buf.toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { continue; }
      // Line parsing lives in usageparse.js so the per-model split is unit-tested.
      const r = usageparse.parseTranscript(text);
      if (!r.msgs) continue;
      const day = new Date(f.mtime).toISOString().slice(0, 10);
      const d = days.get(day) || { day, cost: 0, sessions: 0, turns: 0, tokens: 0 };
      d.cost += r.cost; d.sessions += 1; d.turns += r.msgs; d.tokens += r.inTok + r.outTok;
      days.set(day, d);
      total += r.cost;
      for (const [name, m] of Object.entries(r.models)) {
        const acc = models.get(name) || { tokens: 0, cost: 0 };
        acc.tokens += m.tokens; acc.cost += m.cost;
        models.set(name, acc);
      }
      counted++;
    }
    const list = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 45);
    const modelsOut = Object.fromEntries([...models].sort((a, b) => b[1].tokens - a[1].tokens));
    return { days: list, total, sessions: counted, models: modelsOut };
  });


  // ----- dialogs / shell -----
  handle('dialog:pickDir', async ({ defaultPath }, e) => {
    // The picker belongs to the window that asked for it, not to whichever
    // window happens to be newest. #feat-multi-window
    const res = await dialog.showOpenDialog(senderWin(e), {
      properties: ['openDirectory'],
      defaultPath: defaultPath || store.settings.defaultCwd || os.homedir(),
    });
    return { canceled: res.canceled, path: res.canceled ? null : res.filePaths[0] };
  });

  // Images pasted into a message not sent yet, kept across a crash in 0600
  // files instead of localStorage. #phase5
  const drafts = createDraftStore(path.join(app.getPath('userData'), 'drafts'));
  handle('draft:images', async ({ op, key, images }) => {
    if (op === 'save') { drafts.save(key, images); return {}; }
    if (op === 'load') return { images: drafts.load(key) };
    throw new Error('unknown op');
  });

  // Attach files to a chat turn. Images come back as base64 blocks, text files
  // as inline content; the size caps match the renderer's own limits. #32
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_TEXT_BYTES = 400 * 1024;
  // All inline content of one pick together; past it, files go as path refs so
  // the turn stays under chat:send's IPC cap (24 MB, base64 adds a third).
  const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
  const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
  handle('dialog:pickFiles', async (_payload, e) => {
    const res = await dialog.showOpenDialog(senderWin(e), {
      properties: ['openFile', 'multiSelections'],
      defaultPath: store.settings.defaultCwd || os.homedir(),
    });
    if (res.canceled) return { files: [] };
    const files = [];
    let totalBytes = 0;
    for (const p of res.filePaths.slice(0, 10)) {
      const name = path.basename(p);
      try {
        const st = fs.statSync(p);
        const ext = path.extname(p).toLowerCase();
        const mediaType = MIME_BY_EXT[ext] || '';
        if (IMAGE_TYPES.test(mediaType)) {
          if (st.size > MAX_IMAGE_BYTES) { files.push({ name, path: p, size: st.size, ref: true }); continue; }
          const b = fs.readFileSync(p); totalBytes += b.length;
          if (totalBytes > MAX_TOTAL_BYTES) { files.push({ name, path: p, size: st.size, ref: true }); continue; }
          files.push({ name, mediaType, base64: b.toString('base64') });
        } else if (/\.(md|txt|json|ya?ml|toml|ini|cfg|conf|log|sql|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|c|h|cpp|hpp|rs|go|rb|java|kt|swift|html|css|scss|vue|svelte|xml|csv|env|gitignore|dockerfile|makefile)$/i.test(ext) || st.size <= MAX_TEXT_BYTES) {
          if (st.size > MAX_TEXT_BYTES) { files.push({ name, path: p, size: st.size, ref: true }); continue; }
          const t = fs.readFileSync(p, 'utf8'); totalBytes += t.length;
          if (totalBytes > MAX_TOTAL_BYTES) { files.push({ name, path: p, size: st.size, ref: true }); continue; }
          files.push({ name, text: t.slice(0, 40000) });
        } else {
          // PDFs, archives, binaries: hand the agent the path; its Read tool takes it from there.
          files.push({ name, path: p, size: st.size, ref: true });
        }
      } catch (err) { files.push({ name, error: String(err.message || err) }); }
    }
    return { files };
  });

  handle('clipboard:write', async ({ text }) => {
    clipboard.writeText(String(text == null ? '' : text));
    return {};
  });

  // Allowlist for external URL opening. A compromised renderer must not
  // open arbitrary URLs in the system browser. The default allows https/http.
  const ALLOWED_EXTERNAL_RE = /^https?:\/\//;
  handle('shell:openExternal', async ({ url }) => {
    if (typeof url === 'string' && ALLOWED_EXTERNAL_RE.test(url)) await shell.openExternal(url);
    return {};
  });

  // Reveal a tool-result spill file in the file manager. The path arrives from
  // tool output, so it is not trusted: only files under the engine's own
  // tool-results directory may be opened, and only if they actually exist.
  handle('shell:reveal', async ({ path: p }) => {
    const file = String(p || '');
    const spillRoot = path.join(os.homedir(), '.claude', 'tool-results');
    const real = path.resolve(file);
    const underRoot = real === spillRoot || real.startsWith(spillRoot + path.sep);
    if (!underRoot) throw new Error('refusing to open a path outside ' + spillRoot);
    if (!fs.existsSync(real)) throw new Error('that file no longer exists');
    shell.showItemInFolder(real);
    return {};
  });

  // Share a file the agent wrote: show it in the file manager, or save a copy
  // wherever the user picks. Only files this chat's agent wrote are allowed.
  handle('file:share', owned('chats', async ({ id, path: p, action }, e) => {
    const real = chats.shareable(id, p);
    if (!real) throw new Error('that file was not written in this chat, or no longer exists');
    if (action === 'reveal') { shell.showItemInFolder(real); return { ok: true }; }
    if (action === 'save') {
      const r = await dialog.showSaveDialog(senderWin(e), { defaultPath: path.basename(real) });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      await fs.promises.copyFile(real, r.filePath);
      return { ok: true, savedTo: r.filePath };
    }
    throw new Error('unknown action');
  }));

  // ----- settings -----
  handle('settings:get', async () => ({
    settings: { ...store.settings, loginEnv: { PATH: (await loginEnvReady()).PATH || '' } },
    claude: claudeInfo,
    leanPresets: Object.entries(LEAN_PRESETS).map(([id, p]) => ({ id, label: p.label, tools: p.tools })),
    leanAllTools: LEAN_ALL_TOOLS.slice(),
  }));
  handle('settings:set', async ({ settings }) => {
    const incoming = { ...settings };
    // Resolve the lean-tools preset id into an actual tool list, so chats.js
    // only ever sees names. #41
    if ('leanToolsPreset' in incoming) {
      const preset = LEAN_PRESETS[incoming.leanToolsPreset];
      incoming.leanTools = preset ? preset.tools.slice() : null;
      delete incoming.leanToolsPreset;
    }
    // The output-filter budget is a promise about what the model may read:
    // 500…100000. The renderer clamps what the user types, but the main
    // process is where the number is used, so it normalises it before it is
    // persisted — a hand-edited config.json or any other writer cannot store
    // an unbounded budget. #F1
    if ('outputFilterMaxChars' in incoming) {
      incoming.outputFilterMaxChars = clampMaxChars(incoming.outputFilterMaxChars);
    }
    if ('webFetchDomains' in incoming) incoming.webFetchDomains = normalizeDomains(incoming.webFetchDomains);
    if ('connectorModes' in incoming) incoming.connectorModes = connectorauto.normalizeModes(incoming.connectorModes);
    if ('connectorPick' in incoming && !['auto', 'off', 'always'].includes(incoming.connectorPick)) incoming.connectorPick = 'auto';
    delete incoming.connectorUsage;   // written by the app as connectors are used, never by the renderer
    if ('streamIdleSeconds' in incoming) {
      incoming.streamIdleSeconds = clampIdleSeconds(incoming.streamIdleSeconds);
    }
    store.settings = { ...store.settings, ...incoming };
    // loginEnv is derived, never persisted.
    delete store.settings.loginEnv;
    store.save();
    claudeInfo = await detectClaude();
    if (store.settings.closeToTray) createTray();
    return { settings: store.settings, claude: claudeInfo };
  });
}

// ---------- lifecycle ---------------------------------------------------------
// Single-instance guard. The proxy binds an ephemeral port now, so a second
// launch would not have fought over it — but a second *process* would have
// meant a second proxy, a second config and a second tray icon. One process,
// many windows: the second launch opens a window in the running app instead
// of starting a rival one. #feat-multi-window
const gotLock = app.requestSingleInstanceLock();
// Global shortcut to bring the app front when it is hidden in the tray.
// Opt-in: only register when the user has close-to-tray on, mirroring the
// tray behaviour (without a tray, minimize-to-windowlist is the OS default).
if (store.settings && store.settings.closeToTray) {
  app.setUserTasks([
    {
      label: 'Bring Claude Code Enhanced to front',
      toolTip: 'Show the window (same as clicking the tray icon)',
      program: process.execPath,
      args: ['.'],
      options: { args: [] },
    },
  ]);
}
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // A second launch opens a second window in the running app. #feat-multi-window
    createWindow();
    // ...and if it carried a cce:// link, route it into the running app. #item-24
    const link = (argv || []).find((a) => /^cce:\/\//i.test(String(a)));
    if (link) routeDeepLink(link);
  });

  // macOS delivers links to the running instance through open-url instead of argv.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    routeDeepLink(url);
  });

  app.whenReady().then(async () => {
    if (process.env.CCE_SMOKE) debugLog('CCE_SMOKE: app ready');
    // cce:// links (item 24). Registration needs the packaged app; in dev the
    // catch keeps startup clean and links simply arrive through argv.
    try { app.setAsDefaultProtocolClient('cce'); } catch { /* not packaged */ }
    const bootLink = (process.argv || []).find((a) => /^cce:\/\//i.test(String(a)));
    if (bootLink) routeDeepLink(bootLink);
    loginEnvReady();   // probe the login shell in the background, never on the main thread
    // Bind an ephemeral port: a fixed one collides with any other listener and
    // leaks provider API keys to whoever grabs it.
    store.init();
    // Secrets live in auth.json; pull any that predate the split out of config.
    auth.init(app.getPath('userData'));
    modelsdev.init(app.getPath('userData'));
    const migrated = auth.migrateFromConfig(store.providers, () => store.save());
    if (migrated) debugLog('[auth] migrated', migrated, 'credential(s) out of config.json');
    providers.useAuth(auth);
    providers.ensureDefaults(store);
    if (providers.migrateUrls(store)) debugLog('[providers] repaired a stale preset base URL');
    if (providers.migrateModels(store)) debugLog('[providers] applied requested model pins');
    refreshSecretCache();
    if (process.env.CCE_SMOKE) debugLog('CCE_SMOKE: store ready');

    const proxy = await startProxy(async (uid) => {
      const inst = store.providers.find(x => x.uid === uid);
      if (!inst || !inst.baseUrl) return null;
      // Long chats outlive short-lived OAuth tokens: refresh (single-flight) per request.
      await ensureFreshAuth(inst);
      const s = secretFor(uid);
      return {
        baseUrl: inst.baseUrl,
        apiKey: s.apiKey || s.authToken || '',
        protocol: inst.protocol || 'openai',
        keyHeader: inst.keyHeader || 'bearer',
        headers: inst.headers || {},
        // Some gateways fingerprint the client; name the app in the UA.
        appVersion: app.getVersion(),
        // Stand-ins for a model name this provider does not serve.
        model: inst.model || '',
        smallFastModel: inst.smallFastModel || '',
        fallbackModel: inst.fallbackModel || (providers.entryFor(inst) || {}).fallbackModel || store.settings.fallbackModel || '',
      };
    }, { token: proxyToken, port: Number(process.env.CCE_PROXY_PORT || 0) });
    proxyPort = proxy.port;
    if (process.env.CCE_SMOKE) debugLog('CCE_SMOKE: store ready');
    // Register IPC before the CLI probe: detectClaude() shells out to
    // `claude --version` (up to 15s), and the renderer calls handlers as soon
    // as it loads. Handlers that need claudeInfo already read the mutable
    // module-level variable, so registering first is safe.
    registerIpc();
    createWindow();
    if (store.settings.closeToTray) createTray();
    wirePowerResume();
    // Global shortcut: bring the app to front when hidden in the tray.
    // Ctrl+Shift+C is mnemonic for "Claude". Only when close-to-tray is on.
    if (store.settings.closeToTray) {
      const { globalShortcut } = require('electron');
      globalShortcut.register('CommandOrControl+Shift+C', () => {
        const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
        if (wins.length) {
          const front = wins[wins.length - 1];
          if (front.isMinimized()) front.restore();
          front.focus();
          front.show();
        }
      });
    }
    detectClaude().then((info) => {
      claudeInfo = info;
      if (process.env.CCE_SMOKE) debugLog('CCE_SMOKE: claude detected ->', JSON.stringify(claudeInfo));
      if (win && !win.isDestroyed()) win.webContents.send('claude:detected', claudeInfo);
    });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((err) => {
    console.error('[cce] startup failed:', (err && err.stack) || err);
  });
}

/**
 * Sleep breaks things quietly: MCP health checks go stale, the claude CLI
 * probe ages out, and a resumed stream may have been cut by the network
 * stack. Tell every window the machine came back so they re-run the checks
 * that are now lies. powerMonitor is only legal after app ready. #fix-resume
 */
function wirePowerResume() {
  try {
    const { powerMonitor } = require('electron');
    const resume = () => {
      lastClaudeProbe = 0;   // allow an immediate re-probe after wake
      // Sleep is when claude self-updates: re-run the probe now instead of
      // waiting for a focus event that may already have happened.
      detectClaude().then((info) => {
        claudeInfo = info;
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('claude:detected', info);
        }
      }).catch(() => { /* probe failed; the focus probe tries again */ });
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:resumed');
      }
    };
    powerMonitor.on('resume', resume);
    powerMonitor.on('unlock-screen', resume);
  } catch { /* powerMonitor unavailable (tests / headless) */ }
}

app.on('window-all-closed', () => { if (!store.settings.closeToTray) app.quit(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  sessions.killAll();
  chats.killAll();
  setTimeout(() => {
    for (const s of sessions.list()) {
      if (s.pid != null) try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 5000).unref();
});

// ---------- exports ---------------------------------------------------------
// The main process is the app's entry point, but it is also the only place
// that knows which window owns what — so the state is exported for the tests
// that pin the routing rules. #feat-multi-window
module.exports = { windowRegistry, chats, sessions, store, createWindow };
