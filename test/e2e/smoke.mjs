'use strict';
// Dependency-free E2E smoke harness for CCE. Drives the real Electron app
// through the Chrome DevTools Protocol (Node's built-in WebSocket, no deps):
//   1. boot            2. create a chat    3. switch provider
//   4. send a message  5. open a terminal  6. spawn each installed engine
// Exits 0 on success, 1 on any failure.
// Headless: `xvfb-run -a node test/e2e/smoke.mjs`
//
// Three things this harness must get right, all learned the hard way:
//
// 1. The provider switch comes BEFORE the message on purpose. chat:set-provider
//    refuses to run while a turn is in flight, so sending first makes the
//    switch fail for a reason that has nothing to do with the app being broken.
//
// 2. The provider must point at a LIVE upstream. A dead port makes the engine
//    exit the moment the chat starts, and the send then reports "this session
//    has ended" -- which looks like an app bug and is not one. So the harness
//    starts a tiny OpenAI-compatible stub server and points the provider at it.
//
// 3. CCE_SMOKE is deliberately NOT set. The app's own smoke instrumentation
//    creates a Monaco diff editor, captures pages and clicks through the
//    conversation list; that work runs on the renderer's main thread and can
//    keep the renderer from answering CDP commands for tens of seconds. The
//    harness drives the app itself and does not need that instrumentation.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import electronBin from 'electron';

const PORT = Number(process.env.CCE_SMOKE_PORT || 9333);
const TIMEOUT_MS = Number(process.env.CCE_SMOKE_TIMEOUT || 120000);
const STEP_TIMEOUT_MS = Number(process.env.CCE_SMOKE_STEP_TIMEOUT || 60000);
const READY_TIMEOUT_MS = Number(process.env.CCE_SMOKE_READY_TIMEOUT || 60000);
const PAGE_TIMEOUT_MS = Number(process.env.CCE_SMOKE_PAGE_TIMEOUT || 30000);
const REPLY_TIMEOUT_MS = Number(process.env.CCE_SMOKE_REPLY_TIMEOUT || 60000);
const STUB_MODEL = 'smoke-model';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * A minimal OpenAI-compatible upstream: the app's translator proxy turns the
 * engine's Anthropic request into POST <base>/v1/chat/completions, and this
 * answers with one SSE chunk plus [DONE].
 */
function startStub() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models\/?$/.test(req.url || '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: STUB_MODEL, object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep {} */ }
      const model = body.model || STUB_MODEL;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (delta, finish) => JSON.stringify({
        id: 'chatcmpl-smoke',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      res.write('data: ' + chunk({ role: 'assistant', content: 'OK' }, null) + '\n\n');
      res.write('data: ' + chunk({}, 'stop') + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitForPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const arr = await r.json();
      const page = arr.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* the port is not up yet */ }
    await sleep(500);
  }
  return null;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  });
  const openPromise = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error('ws error: ' + (e && e.message)));
  });
  function send(method, params = {}, timeoutMs = STEP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (err) { pending.delete(id); reject(err); return; }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, timeoutMs);
    });
  }
  return { ws, openPromise, send };
}

// The page target appears as soon as the renderer is created -- long before the
// renderer can answer a debugger command. Connecting then and waiting for
// Runtime.enable hangs, so readiness is polled with a cheap evaluate: the first
// one that answers proves the renderer's main thread is free.
async function waitForRenderer(send, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'never evaluated';
  while (Date.now() < deadline) {
    try {
      const r = await send('Runtime.evaluate', {
        expression: '!!window.ccx && document.readyState !== "loading"',
        returnByValue: true,
      }, 5000);
      if (r && r.result && r.result.value === true) return true;
      last = 'renderer not ready: ' + JSON.stringify(r).slice(0, 200);
    } catch (e) { last = e.message; }
    await sleep(500);
  }
  console.error('renderer never became ready: ' + last);
  return false;
}

const expr = (baseUrl) => `(async () => {
  const out = { boot: false, chat: null, provider: null, send: null, reply: null, terminal: null, engines: {}, errors: [] };
  try {
    out.boot = !!window.ccx && document.readyState !== 'loading';
    const cr = await window.ccx.invoke('chat:create', { cwd: '/tmp' });
    out.chat = cr;
    if (!cr || !cr.ok) out.errors.push('chat:create ' + ((cr && cr.error) || 'no result'));
    let chatId = cr && cr.id;
    // A throwaway provider pointed at the harness's own stub upstream: the
    // point is the switch path and a real round trip, not a live vendor.
    try {
      await window.ccx.invoke('providers:save', {
        instance: { name: 'SmokeTest', protocol: 'openai', baseUrl: ${JSON.stringify(baseUrl)}, model: ${JSON.stringify(STUB_MODEL)}, keyHeader: 'bearer' },
      });
    } catch (e) { out.errors.push('providers:save ' + (e && e.message || e)); }
    let smoke = null;
    try {
      const all = await window.ccx.invoke('providers:all');
      smoke = (all && all.instances || []).find(x => x.name === 'SmokeTest');
    } catch (e) { out.errors.push('providers:all ' + (e && e.message || e)); }
    if (chatId && smoke) {
      const pr = await window.ccx.invoke('chat:set-provider', { id: chatId, uid: smoke.uid });
      out.provider = pr;
      if (!pr || !pr.ok) out.errors.push('chat:set-provider ' + ((pr && pr.error) || 'no result'));
      // Switching the provider REPLACES the chat: the old engine is closed and
      // a new chat id is handed back. Sending to the old id would fail with
      // "this session has ended" and tell us nothing about the app.
      else if (pr.id) chatId = pr.id;
    } else {
      out.errors.push('no smoke provider found');
    }
    if (chatId) {
      // The reply arrives as a chat event, so the turn can be proven end to
      // end instead of just "the message was accepted".
      const reply = new Promise((resolve) => {
        const off = window.ccx.onChatEvent((payload) => {
          if (!payload || payload.id !== chatId) return;
          const msg = payload.msg;
          if (!msg) return;
          const content = msg.message && msg.message.content;
          const text = typeof content === 'string' ? content
            : (Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text).join('') : '');
          if (text && text.includes('OK')) { try { off(); } catch { /* ignore */ } resolve(text); }
        });
        setTimeout(() => resolve(null), ${REPLY_TIMEOUT_MS});
      });
      const sr = await window.ccx.invoke('chat:send', { id: chatId, text: 'Reply with exactly: OK' });
      out.send = sr;
      if (!sr || !sr.ok) out.errors.push('chat:send ' + ((sr && sr.error) || 'no result'));
      out.reply = await reply;
      if (!out.reply) out.errors.push('no assistant reply within the timeout');
    }
    const tr = await window.ccx.invoke('session:create', { cwd: '/tmp', type: 'shell' });
    out.terminal = tr;
    if (!tr || !tr.id) out.errors.push('session:create ' + ((tr && tr.error) || 'no id'));
    // External agent engines: spawn whatever is installed and kill it again.
    // An engine that is absent from PATH is skipped, not failed — CI runners
    // install none of them, and the point is that detection and the spawn path
    // agree on whatever machine is running.
    const eng = await window.ccx.invoke('engines:list');
    for (const e of ((eng && eng.engines) || [])) {
      if (!e || !e.found) continue;
      const t = await window.ccx.invoke('session:create', { cwd: '/tmp', type: e.id });
      out.engines[e.id] = !!(t && t.id);
      if (t && t.id) { try { await window.ccx.invoke('session:kill', { id: t.id }); } catch {} }
      else out.errors.push('engine spawn ' + e.id + ': ' + ((t && t.error) || 'no id'));
    }
    if (chatId) { try { await window.ccx.invoke('chat:close', { id: chatId }); } catch {} }
    if (tr && tr.id) { try { await window.ccx.invoke('session:kill', { id: tr.id }); } catch {} }
    return JSON.stringify(out);
  } catch (e) {
    out.errors.push('throw: ' + (e && e.message || e));
    return JSON.stringify(out);
  }
})()`;

async function main() {
  const stub = await startStub();
  const baseUrl = 'http://127.0.0.1:' + stub.port + '/v1';
  const env = { ...process.env, CCE_NO_SANDBOX: '1' };
  // The app takes Electron's single-instance lock, which lives in the
  // user-data dir. Without a private one the harness cannot start whenever an
  // installed CCE is already running: the new process quits at once and the
  // debugging port dies with it. A throwaway dir also keeps the harness from
  // touching the user's real config.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-smoke-'));
  const cleanup = () => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { stub.server.close(); } catch { /* best effort */ }
  };
  const proc = spawn(electronBin, [
    '.',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${PORT}`,
    // Chromium's setuid sandbox needs kernel namespaces this container does
    // not have, and its shared-memory region then fails to map: the renderer
    // dies with "Unable to access(W_OK|X_OK) /dev/shm" and the page never
    // loads, so the CDP target stops answering. Both flags below keep the
    // renderer alive; --no-sandbox is the one that actually matters here.
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.stdout.on('data', d => { /* swallow */ });

  const fail = (why) => {
    console.error('SMOKE FAIL: ' + why);
    console.error(stderr.slice(-2000));
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    cleanup();
    process.exit(1);
  };

  const wsUrl = await waitForPage(PORT, PAGE_TIMEOUT_MS);
  if (!wsUrl) fail('the renderer never appeared on the debugging port');

  const { ws, openPromise, send } = cdp(wsUrl);
  await openPromise;
  if (!await waitForRenderer(send, READY_TIMEOUT_MS)) fail('the renderer never became responsive');

  let result = null;
  try {
    const r = await send('Runtime.evaluate', {
      expression: expr(baseUrl),
      awaitPromise: true,
      returnByValue: true,
    });
    if (r && r.result && r.result.value) result = JSON.parse(r.result.value);
  } catch (e) {
    fail('evaluate error: ' + e.message);
  }

  try { ws.close(); } catch { /* already closed */ }
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  await sleep(1000);
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  cleanup();

  if (!result) fail('no result');
  console.log('SMOKE RESULT:', JSON.stringify(result));

  const ok = result.boot
    && result.chat && result.chat.ok && result.chat.id
    && result.provider && result.provider.ok
    && result.send && result.send.ok
    && result.reply
    && result.terminal && result.terminal.id
    && result.engines && Object.values(result.engines).every(Boolean)
    && (!result.errors || result.errors.length === 0);

  if (!ok) fail('steps not all green');
  console.log('SMOKE PASS');
  process.exit(0);
}

// overall timeout
const timer = setTimeout(() => {
  console.error('SMOKE FAIL: overall timeout');
  process.exit(1);
}, TIMEOUT_MS);
timer.unref();

main().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
