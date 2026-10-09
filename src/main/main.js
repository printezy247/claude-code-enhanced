// Claude Code Enhanced — main process.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

app.setName('claude-code-enhanced');
if (process.env.CCE_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox');

// Surface async failures with a real stack instead of an anonymous warning.
process.on('unhandledRejection', (reason) => {
  console.error('[cce] unhandled rejection:', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[cce] uncaught exception:', (err && err.stack) || err);
});
if (process.env.CCE_NO_SANDBOX) app.commandLine.appendSwitch('no-sandbox');

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
const { sanitizeModel, warmOllamaModel, pickLocalDefault, ollamaModelCtx } = require('./localmodels');
const SessionManager = require('./sessions');
const { startProxy } = require('./proxy');
// Per-launch secret the translator proxy requires on every request. The proxy
// attaches real provider API keys, so without it any local process could spend
// them. See issue #8.
const proxyToken = require('crypto').randomBytes(24).toString('hex');
let proxyPort = null;
const ChatManager = require('./chats');

const store = new Store();
const auth = new AuthStore();
const sessions = new SessionManager();
// The manager needs the proxy token so proxied chats authenticate.
const chats = new ChatManager({ proxyToken });
providers.useAuth(auth);
let win = null;
let tray = null;
let claudeInfo = { found: false, path: '', version: '' };

// Resolved secrets per provider uid, so the proxy (which resolves synchronously
// per request) never has to touch disk or hit the network mid-turn.
const secretCache = new Map(); // uid -> { apiKey, authToken }
function refreshSecretCache() {
  secretCache.clear();
  for (const p of store.providers) {
    const r = auth.resolve(p.uid);
    secretCache.set(p.uid, { apiKey: r.apiKey || '', authToken: r.authToken || '' });
  }
}
function secretFor(uid) { return secretCache.get(uid) || {}; }

// OAuth flows in flight, keyed by a short session id handed to the renderer.
const oauthSessions = new Map();
let oauthSeq = 0;

/**
 * Refresh an OAuth provider's token if it is expired (or about to). Copilot
 * short-lived tokens are re-minted from the long-lived GitHub token.
 */
async function ensureFreshAuth(inst) {
  if (!inst) return;
  const rec = auth.get(inst.uid);
  if (!rec || rec.type !== 'oauth') return;
  const soon = rec.expires && rec.expires - Date.now() < 120_000;
  if (!soon) return;
  const entry = providers.entryFor(inst) || {};
  const cfg = entry.oauth || {};
  try {
    let tokens;
    if (cfg.exchange === 'copilot' || (rec.meta && rec.meta.copilot)) {
      tokens = await oauth.refreshCopilot(rec.refresh);
    } else if (rec.refresh && cfg.tokenUrl) {
      tokens = await oauth.refreshTokens(cfg, rec.refresh);
    } else {
      return;
    }
    auth.setOAuth(inst.uid, { access: tokens.access, refresh: tokens.refresh || rec.refresh, expires: tokens.expires, meta: { ...rec.meta, ...(tokens.meta || {}) } });
    refreshSecretCache();
  } catch (err) {
    console.error('[auth] refresh failed for ' + inst.name + ':', String((err && err.message) || err));
  }
}

/** Build the tray icon + menu (close-to-tray). #46 */
function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  try {
    tray = new Tray(iconPath);
    tray.setToolTip('Claude Code Enhanced');
    const menu = Menu.buildFromTemplate([
      { label: 'Show', click: () => { if (win && !win.isDestroyed()) win.show(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => { if (win && !win.isDestroyed()) win.show(); });
  } catch (err) {
    console.error('[cce] tray unavailable:', String(err.message || err));
    tray = null;
  }
  return tray;
}

// ---------- claude CLI detection -------------------------------------------
function detectClaude() {
  return new Promise((resolve) => {
    const candidates = [
      process.env.CCE_CLAUDE_PATH,
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      '/snap/bin/claude',
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
function loginEnv() {
  if (loginEnvCache) return loginEnvCache;
  const shell = process.env.SHELL || '/bin/bash';
  try {
    const out = execFileSync(shell, ['-ilc', 'env'], {
      timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const env = {};
    for (const line of String(out).split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    loginEnvCache = env;
  } catch { loginEnvCache = {}; }
  return loginEnvCache;
}
/** Re-probe the login shell (newly installed tools appear). #21 */
function refreshLoginEnv() {
  loginEnvCache = null;
  return loginEnv();
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
  readOnly: { label: 'Read-only (no writes)', tools: ['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'TodoWrite'] },
  lean: { label: 'Lean coding', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'TodoWrite'] },
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
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#14141a',
    title: 'Claude Code Enhanced',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);

  // A markdown link in a chat must not navigate the app away from itself, and a
  // target=_blank link must not open a second window with our preload attached.
  // Both happened before: clicking a link replaced the whole UI and left the
  // user with a blank page. #6
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.protocol === 'file:') return;                 // our own page
    event.preventDefault();
    if (/^https?:$/.test(target.protocol)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Refuse every permission request the renderer could make: the app needs no
  // camera, mic, geolocation or notifications permission from the page itself.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    .catch((err) => console.error('[cce] page load failed:', String(err)));
  win.on('closed', () => { win = null; });
  // Close-to-tray: the engine processes keep running, so closing the window
  // should not kill a 40-minute turn. Opt-in in Settings. #46
  win.on('close', (e) => {
    if (!store.settings.closeToTray || app.isQuitting) return;
    e.preventDefault();
    win.hide();
    if (tray && !tray.isDestroyed()) tray.displayBalloon({
      title: 'Claude Code Enhanced',
      content: 'Still running in the tray — click the tray icon to reopen.',
    });
  });

  if (process.env.CCE_SMOKE) {
    win.webContents.on('did-fail-load', (_e, code, desc) =>
      console.log('CCE_SMOKE: did-fail-load', code, desc));
    win.webContents.on('render-process-gone', (_e, details) =>
      console.log('CCE_SMOKE: render-process-gone', JSON.stringify(details)));
    win.webContents.on('console-message', (_e, level, msg, line, source) =>
      console.log(`CCE_SMOKE: renderer[${level}] ${source}:${line} ${msg}`));
    win.webContents.once('did-finish-load', () => {
      console.log('CCE_SMOKE: page loaded');
      win.webContents.executeJavaScript('window.__CCE_SMOKE = true').catch(() => {});
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        win.webContents.executeJavaScript(
          '(async () => { const out = { monaco: !!(window.monaco && window.monaco.editor), diff: "n/a" };'
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
          + ' return JSON.stringify(out); })()'
        ).then(r => console.log('CCE_SMOKE: probe ' + r))
          .catch(e => console.log('CCE_SMOKE: probe failed ' + e));
      }, 4000);
      const shoot = async (file) => {
        try {
          if (!win || win.isDestroyed()) return;
          const img = await win.webContents.capturePage();
          fs.writeFileSync(file, img.toPNG());
          console.log('CCE_SMOKE: shot', file);
        } catch (e) { console.error('CCE_SMOKE: capture failed:', e); }
      };
      const out = process.env.CCE_SMOKE_OUT || '/tmp/cce-smoke.png';
      if (process.env.CCE_SMOKE_CHATTEST) {
        // Turn matrix: local / anthropic-protocol / openai-proxy providers each
        // send one real prompt; capture the pane's errors and reply.
        setTimeout(async () => {
          const probe = await win.webContents.executeJavaScript(
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
          console.log('CCE_SMOKE: chattest ' + probe);
        }, 3000);
      }
      if (process.env.CCE_SMOKE_PROXY) {
        // Regression probe for the translator-proxy chat path: create a chat
        // with the first openai-protocol provider (spawn only — no message is
        // sent, so no provider API calls happen). Caught the v0.7.0
        // "env is not defined" ReferenceError that the default-provider smoke
        // run could never reach.
        setTimeout(() => {
          win.webContents.executeJavaScript(
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
          ).then(r => console.log('CCE_SMOKE: proxy-create ' + r))
            .catch(e => console.log('CCE_SMOKE: proxy-create failed ' + e));
        }, 6000);
      }
      if (process.env.CCE_SMOKE_TESTALL) {
        // Test every configured provider with its real credential and list models.
        setTimeout(async () => {
          const probe = await win.webContents.executeJavaScript(
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
          console.log('CCE_SMOKE: testall ' + probe);
        }, 3000);
      }
      if (process.env.CCE_SMOKE_PROVIDERS) {
        // Regression probe for the provider settings surface: catalog, auth
        // status, local scan, and the Connect/detail modals rendering.
        setTimeout(async () => {
          const probe = await win.webContents.executeJavaScript(
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
          console.log('CCE_SMOKE: providers ' + probe);
        }, 3000);
      }
      if (process.env.CCE_SMOKE_DIALOG) {
        // Regression probe for the Add-provider dialog: switches presets and
        // reports whether template fields populate and key-only layout holds.
        setTimeout(() => {
          win.webContents.executeJavaScript(
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
          ).then(r => console.log('CCE_SMOKE: dialog ' + r))
            .catch(e => console.log('CCE_SMOKE: dialog failed ' + e));
        }, 4500);
      }
      if (process.env.CCE_SMOKE_SEND) {
        // Round-trip test: send a tiny message through the chat engine.
        setTimeout(() => {
          console.log('CCE_SMOKE: sending test message to', chats.lastCreatedId);
          const r = chats.send(chats.lastCreatedId, 'Reply with exactly: OK');
          console.log('CCE_SMOKE: send ->', JSON.stringify(r));
          setTimeout(() => shoot(out + '.early.png'), 5000);
          setTimeout(async () => { await shoot(out); app.quit(); }, 60000);
        }, Number(process.env.CCE_SMOKE_SEND_DELAY || 12000));
      } else {
        setTimeout(async () => { await shoot(out); app.quit(); }, Number(process.env.CCE_SMOKE_DELAY || 6000));
      }
    });
  }
}

// ---------- ipc --------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, payload) => {
    try { return { ok: true, ...(await fn(payload || {})) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
}

function registerIpc() {
  handle('app:info', async () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    claude: claudeInfo,
    home: os.homedir(),
  }));

  // Release ping (#47): compares the packaged version with the GitHub release.
  // 404 = repo has no releases yet (expected before the first push).
  handle('update:check', async () => {
    const current = app.getVersion();
    const res = await fetch('https://api.github.com/repos/printezy247/claude-code-enhanced/releases/latest', {
      headers: { 'user-agent': 'claude-code-enhanced' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return { current, latest: null, note: 'no releases published yet' };
    if (!res.ok) return { current, latest: null, note: 'release feed returned ' + res.status };
    const j = await res.json();
    return { current, latest: String(j.tag_name || '').replace(/^v/, ''), url: j.html_url || '' };
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
  handle('provider:failover', async ({ id }) => {
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
    chats.close(id);
    await new Promise(r => setTimeout(r, 50));
    const created = await chats.create({
      cwd: chat.cwd,
      providerInstance: next,
      settings: { ...store.settings, ...(next.leanTools ? { leanTools: next.leanTools } : {}) },
      model: next.model || chat.model,
      permissionMode: chat.permissionMode,
      resume,
      claudePath: (store.settings.claudePath || '').trim() || undefined,
      anthropicBaseUrl: usesProxy(next) ? proxyBaseUrl(next) : undefined,
    });
    return { ok: true, from: current, to: next.uid, newId: created.id, provider: providers.publicInstance(next) };
  });

  handle('providers:save', async ({ instance }) => {
    if (!instance || !instance.name) throw new Error('provider name required');
    const sanitizeModelField = (m) => String(m || '').split(',')[0].trim();
    instance.model = sanitizeModelField(instance.model);
    instance.smallFastModel = sanitizeModelField(instance.smallFastModel);
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
  const listModelsLive = async ({ uid, baseUrl: directBase, apiKey: directKey, protocol: directProtocol }) => {
    const p = store.providers.find(x => x.uid === uid);
    const base = directBase || (p && p.baseUrl);
    const s = uid ? secretFor(uid) : {};
    const key = directKey || s.apiKey || s.authToken || '';
    const protocol = directProtocol || (p && p.protocol) || 'openai';
    if (!base) return { models: [] };
    if (protocol !== 'anthropic') {
      try {
        const prov = { baseUrl: base, apiKey: key, protocol, keyHeader: (p && p.keyHeader) || 'bearer', headers: (p && p.headers) || {} };
        const res = await adapters.listModels(prov);
        const j = await res.json();
        const raw = j.data || j.models || [];
        const models = raw.map(m => ({ id: m.id || m.name, ctx: m.context_length || m.inputTokenLimit || null }))
          .filter(m => m.id).map(m => ({ ...m, id: String(m.id).replace(/^models\//, '') }))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (models.length) return { models, curated: p ? (p.models || []) : [] };
        // bedrock-runtime implements no GET /models (always empty/404): fall
        // back to the models.dev catalog so the picker still has real ids.
        if (bedrock.isBedrockUrl(base)) {
          const cat = modelsdev.modelsFor('amazon-bedrock').map(m => ({
            id: m.id, name: m.name, ctx: (m.limit && m.limit.context) || null,
            cost: m.cost, tool_call: m.tool_call, catalog: true,
          })).sort((a, b) => a.id.localeCompare(b.id));
          if (cat.length) return { models: cat, curated: p ? (p.models || []) : [], source: 'models.dev (no live listing on Bedrock)' };
        }
        return { models, curated: p ? (p.models || []) : [] };
      } catch (err) {
        if (bedrock.isBedrockUrl(base)) {
          const cat = modelsdev.modelsFor('amazon-bedrock').map(m => ({
            id: m.id, name: m.name, ctx: (m.limit && m.limit.context) || null,
            cost: m.cost, tool_call: m.tool_call, catalog: true,
          })).sort((a, b) => a.id.localeCompare(b.id));
          if (cat.length) return { models: cat, curated: p ? (p.models || []) : [], source: 'models.dev (no live listing on Bedrock)' };
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
      return { models };
    } catch (err) {
      // Fallback: Ollama tags + per-model context probe (so unusable ones get filtered)
      try {
        const res2 = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(6000) });
        const j2 = await res2.json();
        const names = [...new Set((j2.models || []).map(m => m.name || m.model).filter(Boolean))].sort();
        const probed = await Promise.all(names.slice(0, 40).map(async (n) => ({
          id: n, ctx: await ollamaModelCtx(base, n),
        })));
        return { models: probed };
      } catch (err2) {
        return { models: [], error: String((err2 && err2.message) || err2) };
      }
    }
  };
  // Declared models (saved list + preset recommendations) are always offered,
  // so a failed or empty live listing never hides what the user configured.
  handle('provider:listModels', async (args) => {
    const r = (await listModelsLive(args)) || {};
    const p = store.providers.find(x => x.uid === args.uid);
    const entry = p ? providers.entryFor(p) : null;
    const declared = p ? [...(p.models || []), ...(entry && entry.recommendedModels || [])] : [];
    const have = new Set((r.models || []).map(m => m.id));
    const extra = [...new Set(declared)].filter(id => id && !have.has(id)).map(id => ({ id, ctx: null, declared: true }));
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
      return { ok: true, status: res.status, modelCount: count, detail: key ? 'key accepted' : 'no key (local runtime?)' };
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

  handle('connectors:add', async ({ presetId, scope, header }) => {
    const preset = connectors.PRESETS.find(p => p.id === presetId);
    if (!preset) throw new Error('unknown preset');
    const res = await connectors.add(claudePath(), { preset, scope, header });
    return res;
  });

  handle('connectors:addCustom', async ({ name, url, header, scope }) => {
    const res = await connectors.addCustom(claudePath(), { name, url, header, scope });
    return res;
  });

  handle('connectors:remove', async ({ name }) => {
    const res = await connectors.remove(claudePath(), { name });
    return res;
  });

  // ----- sessions -----
  handle('session:create', async ({ cwd, type = 'claude', providerUid, continueLast = false, yolo = false, cols = 110, rows = 28, initText = '' }) => {
    const dir = (cwd || store.settings.defaultCwd || os.homedir()).replace(/^~(?=\/|$)/, os.homedir());
    if (!fs.existsSync(dir)) throw new Error(`directory not found: ${dir}`);

    let command, args = [];
    if (type === 'shell') {
      command = process.env.SHELL || 'bash';
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
    if (initText) {
      setTimeout(() => sessions.write(created.id, initText), 1500);
    }
    return { ...created, provider: provider ? providers.publicInstance(provider) : null };
  });

  handle('session:list', async () => ({ sessions: sessions.list() }));
  ipcMain.on('session:write', (_e, { id, data }) => sessions.write(id, data));
  handle('session:resize', async ({ id, cols, rows }) => { sessions.resize(id, cols, rows); return {}; });
  handle('session:kill', async ({ id }) => { sessions.kill(id); return {}; });

  sessions.on('data', (id, data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data });
  });
  sessions.on('exit', (id, exitCode) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, exitCode });
  });

  // ----- chats (Agent SDK) -----
  chats.on('event', (id, evt) => {
    if (process.env.CCE_SMOKE && evt && (evt.kind === 'error' || evt.kind === 'status')) {
      console.log('CCE_SMOKE: chat-' + evt.kind, id, evt.kind === 'error' ? String(evt.error).slice(0, 200) : 'busy=' + evt.busy);
    }
    // Desktop notification for permission prompts — the card is easy to miss
    // behind a terminal window, and an unanswered one silently times out.
    if (evt && evt.kind === 'permission') {
      notify('Claude needs permission: ' + (evt.toolName || 'tool'),
        'Open Claude Code Enhanced to answer (auto-denies in 6 minutes).');
    }
    // Finished turns, but only when the window is in the background: a
    // notification for work the user is already watching is noise. #36
    if (evt && evt.kind === 'status' && evt.busy === false && store.settings.notifyOnDone !== false) {
      const focused = win && !win.isDestroyed() && win.isFocused();
      if (!focused && !finished.has(id)) {
        finished.add(id);
        notify('Claude finished', 'A turn in ' + path.basename(chats.chats.get(id)?.cwd || 'a session') + ' is ready.');
      }
    }
    if (evt && evt.kind === 'status' && evt.busy === true) finished.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('chat:event', { id, ...evt });
  });
  // Chats already busy when the window loses focus must not notify on finish.
  const finished = new Set();

  function notify(title, body) {
    if (process.env.CCE_QUIET_NOTIFY) return;
    try {
      const n = new Notification({ title, body });
      n.on('click', () => { if (win && !win.isDestroyed()) win.show(); });
      n.show();
    } catch { /* notifications unavailable */ }
  }

  // Local-model pre-warm helpers live in ./localmodels (tested by scripts/check.js).
  handle('chat:create', async ({ cwd, providerUid, model, permissionMode, yolo, resume, fork, resumeAt }) => {
    const provider = store.providers.find(p => p.uid === providerUid)
      || store.providers.find(p => p.uid === store.settings.defaultProviderUid) || null;
    if (provider) await ensureFreshAuth(provider);
    const useProxy = usesProxy(provider);
    // Local Ollama providers: pre-warm the model at a context size that fits the
    // claude engine's base prompt (Ollama's default 4-16K ctx 400s instantly).
    let effModel = sanitizeModel(model || (provider && provider.model) || '');
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
      const warm = await warmOllamaModel(provider.baseUrl, effModel, Number(store.settings.localNumCtx || 131072), { forceCtx: forcedCtxFor(store.settings, effModel), local: isLocalBase(provider.baseUrl) });
      if (!warm.ok) return { ok: false, error: warm.error };
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
    // Report back the model actually in force (auto-picked or typo-corrected)
    // so the renderer's dropdown doesn't keep showing 'provider default'.
    return { ...created, model: model || '' };
  });
  handle('chat:last', async ({ cwd }) => ({ sessionId: chats.lastChatFor(cwd) }));
  handle('chat:send', async ({ id, text, blocks }) => chats.send(id, text, blocks));
  handle('chat:interrupt', async ({ id }) => { await chats.interrupt(id); return {}; });
  handle('chat:set-model', async ({ id, model }) => {
    // Mid-chat model switches need the same local pre-warm as chat creation:
    // without it, Ollama serves the model at its default (tiny) context.
    const chat = chats.chats.get(id);
    const prov = chat && chat.providerInstance;
    if (prov) await ensureFreshAuth(prov);
    const eff = sanitizeModel(model || (prov && prov.model) || '');
    model = sanitizeModel(model);
    // Warm on any local base or direct (non-proxied) provider — proxied local
    // chats need it just as much, since the proxy cannot carry num_ctx.
    const needsWarm = !!(prov && prov.baseUrl) && (isLocalBase(prov.baseUrl) || !usesProxy(prov));
    if (needsWarm && eff) {
      const warm = await warmOllamaModel(prov.baseUrl, eff, Number(store.settings.localNumCtx || 131072), { forceCtx: forcedCtxFor(store.settings, eff), local: isLocalBase(prov.baseUrl) });
      if (!warm.ok) return { blocked: true, modelCtx: warm.native, error: warm.error };
      if (warm.corrected) model = warm.corrected;   // dropdown/custom entry fixed to a real tag
    }
    const r = await chats.setModel(id, model);
    return { ...(r && typeof r === 'object' ? r : null), model };
  });
  handle('chat:set-mode', async ({ id, mode }) => chats.setMode(id, mode));
  // Per-chat reasoning effort and thinking budget. The settings existed in
  // chats.create but had no runtime control and no UI at all. #38
  handle('chat:effort', async ({ id, effort, thinking }) => {
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
  });
  // Model list straight from the engine (display names, context sizes) instead
  // of the hard-coded opus/sonnet/haiku options. #39
  handle('chat:supported-models', async ({ id }) => {
    const c = chats.chats.get(id);
    if (!c) return { models: [] };
    try { return { models: await c.q.supportedModels() }; }
    catch (err) { return { models: [], error: String(err.message || err) }; }
  });
  handle('chat:permission-answer', async ({ id, requestId, decision, answers, message }) => chats.answer(id, requestId, decision, answers, message));
  handle('chat:close', async ({ id }) => { chats.close(id); return {}; });
  handle('chat:skills', async ({ cwd }) => ({ skills: chats.scanSkills(cwd) }));
  handle('chat:commands', async ({ id }) => ({ commands: await chats.commands(id) }));
  // Desktop-parity controls
  handle('chat:context', async ({ id }) => ({ usage: await chats.context(id) }));
  handle('chat:checkpoints', async ({ id }) => ({ checkpoints: chats.checkpoints(id) }));
  handle('chat:rewind', async ({ id, uuid, dryRun }) => await chats.rewind(id, uuid, { dryRun: !!dryRun }));
  handle('chat:mcp', async ({ id, op, name, enabled }) => {
    if (op === 'status') return { servers: await chats.mcpStatus(id) };
    if (op === 'toggle') return { server: await chats.mcpToggle(id, name, enabled) };
    if (op === 'reconnect') return { server: await chats.mcpReconnect(id, name) };
    throw new Error('unknown mcp op: ' + op);
  });
  handle('chat:agents', async ({ id }) => ({ agents: await chats.agents(id) }));
  handle('chat:flags', async ({ id, patch }) => ({ applied: await chats.applyFlags(id, patch) }));
  handle('chat:stopTask', async ({ id, taskId }) => await chats.stopTask(id, taskId));
  // Runtime tools skills rely on (bun/uv run skill scripts, git imports skills).
  handle('tools:check', async () => await tools.check());

  // Re-read the login-shell environment so tools installed while the app is
  // running become visible to new sessions. #21
  handle('env:refresh', async () => {
    const env = refreshLoginEnv();
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
      execFileSync('git', ['clone', '--depth', '1', u, path.join(tmp, 'repo')], { timeout: 60_000, stdio: 'pipe' });
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
      const warm = await warmOllamaModel(base, model, numCtx || Number(store.settings.localNumCtx || 131072), { forceCtx: forcedCtxFor(store.settings, model) });
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


  handle('chat:history', async ({ cwd }) => ({ sessions: chats.history(cwd) }));
  // Replay a stored session transcript so resumed chats show their past conversation.
  handle('chat:transcript', async ({ cwd, sessionId }) => chats.transcript(cwd, sessionId));
  handle('chat:delete', async ({ cwd, sessionId }) => chats.deleteSession(cwd, sessionId));
  handle('chat:deleteFolder', async ({ cwd }) => chats.deleteFolder(cwd));
  handle('chat:fork', async ({ id }) => chats.forkParams(id));

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
      const content = read(primary) ?? read(alt);
      project = { path: content === null ? primary : primary, altPath: alt, content, exists: content !== null };
    }
    return { global: { path: globalPath, content: read(globalPath) }, project };
  });
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
  handle('file:read', async ({ path: p, maxBytes }) => {
    if (!p) throw new Error('path required');
    const home = process.env.HOME || os.homedir();
    const real = path.resolve(String(p).replace(/^~(?=\/|$)/, home));
    const limit = Math.min(Number(maxBytes) > 0 ? Number(maxBytes) : 200000, 2000000);
    const st = fs.statSync(real);
    if (st.size > limit) return { path: real, tooLarge: true, size: st.size, content: '' };
    return { path: real, tooLarge: false, size: st.size, content: fs.readFileSync(real, 'utf8') };
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
  handle('git:info', async ({ cwd }) => {
    const dir = (cwd || '').replace(/^~(?=\/|$)/, os.homedir());
    const run = (args) => new Promise((resolve) => {
      execFile('git', args, { cwd: dir, timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
    });
    const [remote, branch, dirty] = await Promise.all([
      run(['remote', 'get-url', 'origin']),
      run(['branch', '--show-current']),
      run(['status', '--porcelain']),
    ]);
    let repo = null;
    const m = remote && remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (m) repo = m[1];
    const dirtyCount = dirty ? dirty.split('\n').filter(Boolean).length : 0;
    return { remote, branch, repo, dirty: dirtyCount };
  });

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

  // desktop-style history index: every session on disk, flat + recency-sorted
  handle('chats:index', async () => ({ sessions: chats.index() }));

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
      let inTok = 0, outTok = 0, msgs = 0, cost = 0;
      for (const line of text.split('\n')) {
        if (line.includes('"type":"assistant"')) {
          try {
            const j = JSON.parse(line);
            const u = (j.message && j.message.usage) || {};
            inTok += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            outTok += u.output_tokens || 0;
            msgs++;
          } catch { /* partial line */ }
        } else if (line.includes('total_cost_usd')) {
          const m = line.match(/"total_cost_usd":\s*([\d.eE+-]+)/);
          if (m) cost += Number(m[1]) || 0;
        }
      }
      if (!msgs) continue;
      const day = new Date(f.mtime).toISOString().slice(0, 10);
      const d = days.get(day) || { day, cost: 0, sessions: 0, turns: 0, tokens: 0 };
      d.cost += cost; d.sessions += 1; d.turns += msgs; d.tokens += inTok + outTok;
      days.set(day, d);
      total += cost;
      counted++;
    }
    const list = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 45);
    return { days: list, total, sessions: counted };
  });


  // ----- dialogs / shell -----
  handle('dialog:pickDir', async ({ defaultPath }) => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: defaultPath || store.settings.defaultCwd || os.homedir(),
    });
    return { canceled: res.canceled, path: res.canceled ? null : res.filePaths[0] };
  });

  // Attach files to a chat turn. Images come back as base64 blocks, text files
  // as inline content; the size caps match the renderer's own limits. #32
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_TEXT_BYTES = 400 * 1024;
  const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
  handle('dialog:pickFiles', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      defaultPath: store.settings.defaultCwd || os.homedir(),
    });
    if (res.canceled) return { files: [] };
    const files = [];
    for (const p of res.filePaths.slice(0, 10)) {
      const name = path.basename(p);
      try {
        const st = fs.statSync(p);
        const ext = path.extname(p).toLowerCase();
        const mediaType = MIME_BY_EXT[ext] || '';
        if (IMAGE_TYPES.test(mediaType)) {
          if (st.size > MAX_IMAGE_BYTES) { files.push({ name, error: 'image larger than 4 MB' }); continue; }
          files.push({ name, mediaType, base64: fs.readFileSync(p).toString('base64') });
        } else if (/\.(md|txt|json|ya?ml|toml|ini|cfg|conf|log|sql|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|c|h|cpp|hpp|rs|go|rb|java|kt|swift|html|css|scss|vue|svelte|xml|csv|env|gitignore|dockerfile|makefile)$/i.test(ext) || st.size <= MAX_TEXT_BYTES) {
          if (st.size > MAX_TEXT_BYTES) { files.push({ name, error: 'file larger than 400 kB' }); continue; }
          files.push({ name, text: fs.readFileSync(p, 'utf8').slice(0, 40000) });
        } else {
          files.push({ name, error: 'unsupported file type' });
        }
      } catch (err) { files.push({ name, error: String(err.message || err) }); }
    }
    return { files };
  });

  handle('shell:openExternal', async ({ url }) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
    return {};
  });

  // ----- settings -----
  handle('settings:get', async () => ({
    settings: { ...store.settings, loginEnv: { PATH: loginEnv().PATH || '' } },
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
// Single-instance guard. Without it a second launch binds no proxy (fixed port
// taken) and the user gets a window where every OpenAI-protocol chat silently
// fails. See issue #22.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.env.CCE_SMOKE) console.log('CCE_SMOKE: app ready');
    // Bind an ephemeral port: a fixed one collides with any other listener and
    // leaks provider API keys to whoever grabs it.
    store.init();
    // Secrets live in auth.json; pull any that predate the split out of config.
    auth.init(app.getPath('userData'));
    modelsdev.init(app.getPath('userData'));
    const migrated = auth.migrateFromConfig(store.providers, () => store.save());
    if (migrated) console.log('[auth] migrated', migrated, 'secret(s) out of config.json');
    providers.useAuth(auth);
    providers.ensureDefaults(store);
    if (providers.migrateUrls(store)) console.log('[providers] repaired a stale preset base URL');
    if (providers.migrateModels(store)) console.log('[providers] applied requested model pins');
    refreshSecretCache();
    if (process.env.CCE_SMOKE) console.log('CCE_SMOKE: store ready');

    const proxy = await startProxy((uid) => {
      const inst = store.providers.find(x => x.uid === uid);
      if (!inst || !inst.baseUrl) return null;
      const s = secretFor(uid);
      return {
        baseUrl: inst.baseUrl,
        apiKey: s.apiKey || s.authToken || '',
        protocol: inst.protocol || 'openai',
        keyHeader: inst.keyHeader || 'bearer',
        headers: inst.headers || {},
      };
    }, { token: proxyToken, port: Number(process.env.CCE_PROXY_PORT || 0) });
    proxyPort = proxy.port;
    if (process.env.CCE_SMOKE) console.log('CCE_SMOKE: store ready');
    // Register IPC before the CLI probe: detectClaude() shells out to
    // `claude --version` (up to 15s), and the renderer calls handlers as soon
    // as it loads. Handlers that need claudeInfo already read the mutable
    // module-level variable, so registering first is safe.
    registerIpc();
    createWindow();
    if (store.settings.closeToTray) createTray();
    detectClaude().then((info) => {
      claudeInfo = info;
      if (process.env.CCE_SMOKE) console.log('CCE_SMOKE: claude detected ->', JSON.stringify(claudeInfo));
      if (win && !win.isDestroyed()) win.webContents.send('claude:detected', claudeInfo);
    });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch((err) => {
    console.error('[cce] startup failed:', (err && err.stack) || err);
  });
}

app.on('window-all-closed', () => { if (!store.settings.closeToTray) app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; sessions.killAll(); chats.killAll(); });
