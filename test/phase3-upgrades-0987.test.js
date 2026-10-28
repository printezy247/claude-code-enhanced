// Phase 3 of the 26-item upgrade plan (items 11-14):
//   11. Engine tabs — Codex / Gemini CLI / OpenCode as first-class PTY tabs
//   12. Per-agent model overrides (which model each subagent runs)
//   13. Mobile/web remote with QR pairing (loopback by default)
//   14. SSH hosts — remember hosts, open a real ssh terminal tab
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const engines = require('../src/main/engines.js');
const webremote = require('../src/main/webremote.js');
const sshhosts = require('../src/main/sshhosts.js');
const sdkoptions = require('../src/main/sdkoptions.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let booted = null;
async function bootMain() {
  if (booted) return booted;
  const stub = require('electron');
  stub.__reset();
  require('../src/main/main.js');
  await sleep(250);
  booted = stub;
  return stub;
}

// ---------- 11. engines ------------------------------------------------------

describe('engine registry (item 11)', () => {
  it('knows codex, gemini and opencode with install hints', () => {
    const ids = engines.REGISTRY.map((e) => e.id);
    expect(ids).toEqual(['codex', 'gemini', 'opencode']);
    for (const e of engines.REGISTRY) {
      expect(e.bin, e.id).toBeTruthy();
      expect(e.label, e.id).toBeTruthy();
      expect(e.hint, e.id).toMatch(/install/i);
    }
  });

  it('detects an engine binary on PATH and reports its version', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-engines-'));
    try {
      fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\necho codex 1.2.3\n', { mode: 0o755 });
      const found = await engines.detect({ PATH: dir });
      const codex = found.find((e) => e.id === 'codex');
      expect(codex.found).toBe(true);
      expect(codex.path).toBe(path.join(dir, 'codex'));
      expect(codex.version).toContain('1.2.3');
      const gemini = found.find((e) => e.id === 'gemini');
      expect(gemini.found).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('commandFor resolves a found engine and explains a missing one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-engines-'));
    try {
      fs.writeFileSync(path.join(dir, 'gemini'), '#!/bin/sh\ntrue\n', { mode: 0o755 });
      const ok = await engines.commandFor('gemini', { PATH: dir });
      expect(ok.command).toBe(path.join(dir, 'gemini'));
      expect(ok.args).toEqual([]);
      const missing = await engines.commandFor('codex', { PATH: dir });
      expect(missing.error).toMatch(/not found/);
      expect(missing.error).toMatch(/install/i);
      const bogus = await engines.commandFor('not-an-engine', { PATH: dir });
      expect(bogus.error).toMatch(/unknown engine/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session:create refuses an unknown or missing engine before spawning', async () => {
    const stub = await bootMain();
    const h = stub.__state.handlers;
    const unknown = await h.get('session:create')(null, { cwd: os.tmpdir(), type: 'not-an-engine' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/unknown session type/);
    // ssh without a known host must not spawn either.
    const noHost = await h.get('session:create')(null, { cwd: os.tmpdir(), type: 'ssh' });
    expect(noHost.ok).toBe(false);
    expect(noHost.error).toMatch(/ssh host/i);
  });
});

// ---------- 12. per-agent models ---------------------------------------------

describe('per-agent model overrides (item 12)', () => {
  it('applyAgentModelOverrides sets model only for named agents', () => {
    const agents = {
      explorer: { description: 'reads code', prompt: 'explore' },
      reviewer: { description: 'reviews', prompt: 'review' },
    };
    const out = sdkoptions.applyAgentModelOverrides(agents, { reviewer: 'claude-haiku-5-5' });
    expect(out.explorer.model).toBeUndefined();
    expect(out.reviewer.model).toBe('claude-haiku-5-5');
    // input is not mutated
    expect(agents.reviewer.model).toBeUndefined();
    // blank / unknown names are ignored
    const out2 = sdkoptions.applyAgentModelOverrides(agents, { nobody: 'x', reviewer: '  ' });
    expect(out2.nobody).toBeUndefined();
    expect(out2.reviewer.model).toBeUndefined();
  });

  it('agents:models lists disk agents and the saved overrides', async () => {
    const stub = await bootMain();
    const h = stub.__state.handlers;
    const r = await h.get('agents:models')(null, {});
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.agents)).toBe(true);
    expect(r.overrides && typeof r.overrides).toBe('object');
  });

  it('agents:set-model stores and clears an override', async () => {
    const stub = await bootMain();
    const h = stub.__state.handlers;
    const name = 'phase3-test-agent-' + Date.now();
    const set = await h.get('agents:set-model')(null, { name, model: 'claude-haiku-5-5' });
    expect(set.ok).toBe(true);
    expect(set.overrides[name]).toBe('claude-haiku-5-5');
    const clear = await h.get('agents:set-model')(null, { name, model: '' });
    expect(clear.ok).toBe(true);
    expect(clear.overrides[name]).toBeUndefined();
    const bad = await h.get('agents:set-model')(null, { name: '../evil', model: 'x' });
    expect(bad.ok).toBe(false);
  });
});

// ---------- 13. web remote + QR -----------------------------------------------

describe('web remote with pairing token (item 13)', () => {
  function makeRemote() {
    const calls = { sent: [], answered: [] };
    const remote = webremote.createWebRemote({
      boardRows: () => [{ id: 'c1', cwd: '/tmp/a', busy: true, needsYou: 0 }],
      pendingPerms: () => [{ requestId: 'r1', chatId: 'c1', toolName: 'Bash' }],
      send: async (id, text) => { calls.sent.push({ id, text }); return { ok: true }; },
      answer: (requestId, decision) => { calls.answered.push({ requestId, decision }); return { ok: true }; },
    });
    return { remote, calls };
  }

  it('serves the pairing page and requires the token on the API', async () => {
    const { remote } = makeRemote();
    try {
      const status = await remote.start({ host: '127.0.0.1', port: 0 });
      expect(status.running).toBe(true);
      expect(status.url).toContain('/?t=' + status.token);
      const page = await fetch('http://127.0.0.1:' + status.port + '/');
      expect(page.status).toBe(200);
      expect(await page.text()).toMatch(/Claude Code Enhanced/i);
      const noTok = await fetch('http://127.0.0.1:' + status.port + '/api/state');
      expect(noTok.status).toBe(401);
      const badTok = await fetch('http://127.0.0.1:' + status.port + '/api/state?t=nope');
      expect(badTok.status).toBe(401);
      const ok = await fetch('http://127.0.0.1:' + status.port + '/api/state?t=' + status.token);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body.chats[0].id).toBe('c1');
      expect(body.perms[0].requestId).toBe('r1');
    } finally { remote.stop(); }
    const after = await fetch('http://127.0.0.1:' + (remote.status().port || 1) + '/').catch(() => 'down');
    expect(after).toBe('down');
  });

  it('POST /api/send and /api/answer reach the host callbacks', async () => {
    const { remote, calls } = makeRemote();
    try {
      const status = await remote.start({ host: '127.0.0.1', port: 0 });
      const base = 'http://127.0.0.1:' + status.port;
      const send = await fetch(base + '/api/send?t=' + status.token, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'c1', text: 'hello' }),
      });
      expect(send.status).toBe(200);
      const ans = await fetch(base + '/api/answer?t=' + status.token, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'r1', decision: 'allow' }),
      });
      expect(ans.status).toBe(200);
      expect(calls.sent).toEqual([{ id: 'c1', text: 'hello' }]);
      expect(calls.answered).toEqual([{ requestId: 'r1', decision: 'allow' }]);
      // A bad decision string is refused, not forwarded.
      const bad = await fetch(base + '/api/answer?t=' + status.token, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'r1', decision: 'sudo' }),
      });
      expect(bad.status).toBe(400);
      expect(calls.answered.length).toBe(1);
    } finally { remote.stop(); }
  });

  it('the webremote IPC surface starts, reports and stops', async () => {
    const stub = await bootMain();
    const h = stub.__state.handlers;
    const st = await h.get('webremote:status')(null, {});
    expect(st.ok).toBe(true);
    expect(st.running).toBe(false);
    const start = await h.get('webremote:start')(null, {});
    expect(start.ok).toBe(true);
    expect(start.running).toBe(true);
    expect(start.url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/\?t=[0-9a-f]+$/);
    // QR is an SVG (the qrcode package) so the settings page can inline it.
    expect(start.qr).toContain('<svg');
    const stop = await h.get('webremote:stop')(null, {});
    expect(stop.ok).toBe(true);
    expect(stop.running).toBe(false);
  });
});

// ---------- 14. ssh hosts ------------------------------------------------------

describe('ssh hosts (item 14)', () => {
  it('normalizes a host record and refuses metacharacters', () => {
    const rec = sshhosts.normalize({
      label: 'box', host: 'dev.example.com', user: 'jack', port: '2222', identity: '',
    });
    expect(rec.host).toBe('dev.example.com');
    expect(rec.user).toBe('jack');
    expect(rec.port).toBe(2222);
    for (const bad of [
      { host: 'a; rm -rf /' },
      { host: '$(evil)' },
      { host: '' },
      { user: 'a b' },
      { user: '-oProxyCommand=x' },
      { port: '99999' },
      { port: 'x' },
    ]) {
      expect(() => sshhosts.normalize({ label: 'x', host: 'h', ...bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it('builds an ssh argv with no shell involved', () => {
    expect(sshhosts.sshArgs({ host: 'h', user: 'u', port: 2222, identity: '/k/id' }))
      .toEqual(['-o', 'ServerAliveInterval=30', '-p', '2222', '-i', '/k/id', 'u@h']);
    expect(sshhosts.sshArgs({ host: '10.0.0.5' }))
      .toEqual(['-o', 'ServerAliveInterval=30', '10.0.0.5']);
  });

  it('sshhosts:list/save/delete round-trip through the store', async () => {
    const stub = await bootMain();
    const h = stub.__state.handlers;
    const label = 'phase3-host-' + Date.now();
    const saved = await h.get('sshhosts:save')(null, { host: { label, host: 'dev.example.com', user: 'jack', port: 22 } });
    expect(saved.ok).toBe(true);
    const list = await h.get('sshhosts:list')(null, {});
    expect(list.hosts.some((x) => x.label === label)).toBe(true);
    const id = saved.host.id;
    const gone = await h.get('sshhosts:delete')(null, { id });
    expect(gone.ok).toBe(true);
    const list2 = await h.get('sshhosts:list')(null, {});
    expect(list2.hosts.some((x) => x.id === id)).toBe(false);
    const bad = await h.get('sshhosts:save')(null, { host: { label: 'x', host: 'a;b' } });
    expect(bad.ok).toBe(false);
  });
});

// ---------- renderer + preload wiring ------------------------------------------

describe('phase 3 renderer and preload wiring', () => {
  it('preload allowlists the new channels', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    for (const ch of ['engines:list', 'webremote:status', 'webremote:start', 'webremote:stop',
      'sshhosts:list', 'sshhosts:save', 'sshhosts:delete', 'agents:models', 'agents:set-model']) {
      expect(src, 'preload missing ' + ch).toContain("'" + ch + "'");
    }
  });

  it('board renders the engine strip and opens engine tabs', () => {
    const board = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app', 'board.js'), 'utf8');
    expect(board).toMatch(/engines:list/);
    expect(board).toMatch(/type:\s*e\.id/);
    expect(board).toMatch(/board-engines/);
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    expect(html).toMatch(/id="board-engines"/);
  });

  it('settings has cards for engines, ssh hosts, agent models and mobile access', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app', 'settings.js'), 'utf8');
    expect(s).toMatch(/engines:list/);
    expect(s).toMatch(/sshhosts:save/);
    expect(s).toMatch(/sshhosts:delete/);
    expect(s).toMatch(/agents:models/);
    expect(s).toMatch(/agents:set-model/);
    expect(s).toMatch(/webremote:start/);
    expect(s).toMatch(/webremote:stop/);
    expect(s).toMatch(/Mobile access/i);
    expect(s).toMatch(/SSH hosts/i);
    expect(s).toMatch(/Agent models/i);
  });
});
