// Claude Code Enhanced — main process.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
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
const sessions = new SessionManager();
const chats = new ChatManager();
let win = null;
let claudeInfo = { found: false, path: '', version: '' };

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
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    .catch((err) => console.error('[cce] page load failed:', String(err)));
  win.on('closed', () => { win = null; });

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
    instances: store.providers.map(providers.publicInstance),
    defaultUid: store.settings.defaultProviderUid,
  }));

  handle('providers:save', async ({ instance }) => {
    if (!instance || !instance.name) throw new Error('provider name required');
    const sanitizeModelField = (m) => String(m || '').split(',')[0].trim();
    instance.model = sanitizeModelField(instance.model);
    instance.smallFastModel = sanitizeModelField(instance.smallFastModel);
    const list = store.providers;
    const existing = list.find(p => p.uid === instance.uid);
    if (existing) {
      // Renderer leaves secret fields blank on edit to mean "unchanged".
      const keepToken = !instance.authToken && instance.keepAuthToken;
      const keepKey = !instance.apiKey && instance.keepApiKey;
      const merged = { ...existing, ...instance };
      if (keepToken) merged.authToken = existing.authToken;
      if (keepKey) merged.apiKey = existing.apiKey;
      Object.assign(existing, merged);
    } else {
      instance.uid = instance.uid || providers.newUid();
      list.push(instance);
    }
    if (!store.settings.defaultProviderUid) store.settings.defaultProviderUid = instance.uid;
    store.save();
    return { uid: instance.uid };
  });

  handle('providers:delete', async ({ uid }) => {
    store.providers = store.providers.filter(p => p.uid !== uid);
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
  handle('provider:listModels', async ({ uid, baseUrl: directBase, apiKey: directKey, protocol: directProtocol }) => {
    let p = store.providers.find(x => x.uid === uid);
    let base = directBase || (p && p.baseUrl);
    let key = directKey || (p && (p.apiKey || p.authToken));
    if (!base) return { models: [] };
    if ((p && p.protocol === 'openai') || directProtocol === 'openai') {
      try {
        const res = await fetch(base.replace(/\/+$/, '') + '/models', {
          headers: { Authorization: 'Bearer ' + key },
          signal: AbortSignal.timeout(15000),
        });
        const j = await res.json();
        const models = (j.data || []).map(m => ({ id: m.id, ctx: m.context_length || null }))
          .filter(m => m.id).sort((a, b) => a.id.localeCompare(b.id));
        return { models, curated: p ? (p.models || []) : [] };
      } catch (err) {
        return { models: [], error: String((err && err.message) || err) };
      }
    }
    const headers = {};
    if (key) headers.Authorization = 'Bearer ' + key;
    if (p && p.apiKey) headers['x-api-key'] = p.apiKey;
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
    const env = { ...process.env, ...providers.envFor(provider, store.settings) };
    // OpenAI-protocol providers only work through the built-in translator; the
    // terminal CLI gets the same ANTHROPIC_BASE_URL override as SDK chats.
    if (provider && provider.protocol === 'openai' && proxyPort) {
      env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + proxyPort + '/px/' + provider.uid;
      env.ANTHROPIC_AUTH_TOKEN = (provider.apiKey || provider.authToken) || 'proxy-key';
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
      try {
        const n = new Notification({
          title: 'Claude needs permission: ' + (evt.toolName || 'tool'),
          body: 'Open Claude Code Enhanced to answer (auto-denies in 6 minutes).',
        });
        n.show();
      } catch { /* notifications unavailable */ }
    }
    if (win && !win.isDestroyed()) win.webContents.send('chat:event', { id, ...evt });
  });

  // Local-model pre-warm helpers live in ./localmodels (tested by scripts/check.js).
  handle('chat:create', async ({ cwd, providerUid, model, permissionMode, yolo, resume, fork }) => {
    const provider = store.providers.find(p => p.uid === providerUid)
      || store.providers.find(p => p.uid === store.settings.defaultProviderUid) || null;
    const useProxy = !!(provider && provider.protocol === 'openai' && proxyPort);
    // Local Ollama providers: pre-warm the model at a context size that fits the
    // claude engine's base prompt (Ollama's default 4-16K ctx 400s instantly).
    let effModel = sanitizeModel(model || (provider && provider.model) || '');
    if (provider && provider.baseUrl && !useProxy && !effModel) {
      const picked = await pickLocalDefault(provider.baseUrl);
      if (picked) { effModel = picked; model = picked; }
    }
    if (provider && provider.baseUrl && effModel && !useProxy) {
      const warm = await warmOllamaModel(provider.baseUrl, effModel, Number(store.settings.localNumCtx || 131072));
      if (!warm.ok) return { ok: false, error: warm.error };
      if (warm.corrected) model = warm.corrected;   // typo/alias fixed against the server's real tags
    }
    const created = await chats.create({
      cwd, providerInstance: provider, settings: store.settings,
      model, permissionMode, yolo, resume, fork,
      anthropicBaseUrl: useProxy ? ('http://127.0.0.1:' + proxyPort + '/px/' + provider.uid) : undefined,
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
    const eff = sanitizeModel(model || (prov && prov.model) || '');
    model = sanitizeModel(model);
    const isNativeOllama = !!(prov && prov.baseUrl) && !(prov && prov.protocol === 'openai');
    if (isNativeOllama && eff) {
      const warm = await warmOllamaModel(prov.baseUrl, eff, Number(store.settings.localNumCtx || 131072));
      if (!warm.ok) return { blocked: true, modelCtx: warm.native, error: warm.error };
      if (warm.corrected) model = warm.corrected;   // dropdown/custom entry fixed to a real tag
    }
    const r = await chats.setModel(id, model);
    return { ...(r && typeof r === 'object' ? r : null), model };
  });
  handle('chat:set-mode', async ({ id, mode }) => chats.setMode(id, mode));
  handle('chat:permission-answer', async ({ id, requestId, decision, answers }) => chats.answer(id, requestId, decision, answers));
  handle('chat:close', async ({ id }) => { chats.close(id); return {}; });
  handle('chat:skills', async ({ cwd }) => ({ skills: chats.scanSkills(cwd) }));
  handle('chat:commands', async ({ id }) => ({ commands: await chats.commands(id) }));
  // Desktop-parity controls
  handle('chat:context', async ({ id }) => ({ usage: await chats.context(id) }));
  handle('chat:checkpoints', async ({ id }) => ({ checkpoints: chats.checkpoints(id) }));
  handle('chat:rewind', async ({ id, uuid }) => await chats.rewind(id, uuid));
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
      for (const dir of found) {
        const name = path.basename(dir);
        if (!/^[\w.-]{1,60}$/.test(name)) continue;
        copyDir(dir, path.join(destRoot, name));
        imported.push(name);
      }
      if (!imported.length) throw new Error('skill folder names were not usable');
      return { imported };
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
      const warm = await warmOllamaModel(base, model, numCtx || Number(store.settings.localNumCtx || 131072));
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

  handle('shell:openExternal', async ({ url }) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
    return {};
  });

  // ----- settings -----
  handle('settings:get', async () => ({ settings: store.settings, claude: claudeInfo }));
  handle('settings:set', async ({ settings }) => {
    store.settings = { ...store.settings, ...settings };
    store.save();
    claudeInfo = await detectClaude();
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
    const proxy = await startProxy((uid) => {
      const inst = store.providers.find(x => x.uid === uid);
      return inst ? { baseUrl: inst.baseUrl, apiKey: inst.apiKey || inst.authToken || '' } : null;
    }, { token: proxyToken, port: Number(process.env.CCE_PROXY_PORT || 0) });
    proxyPort = proxy.port;
    store.init();
    if (process.env.CCE_SMOKE) console.log('CCE_SMOKE: store ready');
    providers.ensureDefaults(store);
    // Register IPC before the CLI probe: detectClaude() shells out to
    // `claude --version` (up to 15s), and the renderer calls handlers as soon
    // as it loads. Handlers that need claudeInfo already read the mutable
    // module-level variable, so registering first is safe.
    registerIpc();
    createWindow();
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

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { sessions.killAll(); chats.killAll(); });
