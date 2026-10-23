// Security & data-loss regression tests for the hardening pass:
//  - atomic writes + corrupt-file backups (no more silent wipes of config/auth)
//  - shared SSE reader edge cases (unterminated tail, CRLF, bad frames)
//  - OAuth PKCE callback state validation (CSRF guard) and error escaping
//  - file:read project-root allowlist in the main process
//  - preload IPC channel allowlist + main.js drift check
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';

const { atomicWriteJson, readJsonSafe } = require('../src/main/atomic.js');
const { sseLines, parsedDataEvents } = require('../src/main/sse.js');
const oauth = require('../src/main/oauth.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-sec-test-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leaks are fine in tmp */ } });

describe('atomic JSON persistence', () => {
  it('writes via temp+rename and leaves no partial state', () => {
    const file = path.join(tmp, 'cfg.json');
    atomicWriteJson(file, { hello: 'world' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ hello: 'world' });
    expect(fs.readdirSync(tmp).filter(f => f.includes('.tmp'))).toEqual([]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('readJsonSafe preserves an unparseable file as *.corrupt-<ts>', () => {
    const file = path.join(tmp, 'broken.json');
    fs.writeFileSync(file, '{"providers": [trunca');
    expect(readJsonSafe(file)).toBe(null);
    const backups = fs.readdirSync(tmp).filter(f => f.startsWith('broken.json.corrupt-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(tmp, backups[0]), 'utf8')).toContain('trunca');
  });

  it('readJsonSafe returns undefined for a missing file', () => {
    expect(readJsonSafe(path.join(tmp, 'nope.json'))).toBeUndefined();
  });

  it('Store.init backs up a corrupt config.json instead of silently wiping it', () => {
    const stub = require('electron');
    const dir = stub.app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{"configVersion":2,"providers":[{"uid":"p1","name":"My Provider"','utf8');
    const { Store } = require('../src/main/store.js');
    const store = new Store();
    store.init();
    expect(store.providers).toEqual([]);                        // defaults restored
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('config.json.corrupt-'));
    expect(backups.length).toBe(1);                             // old bytes kept
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toContain('My Provider');
    fs.rmSync(path.join(dir, backups[0]));
  });

  it('AuthStore.init backs up a corrupt auth.json', () => {
    const dir = path.join(tmp, 'authdir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{oops');
    const { AuthStore } = require('../src/main/authstore.js');
    const auth = new AuthStore({ safeStorage: null });
    auth.init(dir);
    expect(auth.listAll(['x'])).toEqual({ x: { present: false } });
    expect(fs.readdirSync(dir).some(f => f.startsWith('auth.json.corrupt-'))).toBe(true);
  });
});

describe('shared SSE reader', () => {
  async function* bodyOf(...strings) { for (const s of strings) yield Buffer.from(s); }

  it('yields every line, strips CR, and still yields an unterminated tail', async () => {
    const out = [];
    for await (const l of sseLines(bodyOf('a\r\nb\r', '\nc\n', 'tail'))) out.push(l);
    expect(out).toEqual(['a', 'b', 'c', 'tail']);
  });

  it('parsedDataEvents skips blanks, event: lines, [DONE] and broken JSON', async () => {
    const body = bodyOf(
      'event: message_start\ndata: {"type":"message_start"}\n\n'
      + 'data: {oops\n'
      + 'data: [DONE]\n'
      + 'data: {"type":"x"}'   // unterminated tail still parsed
    );
    const events = [];
    for await (const ev of parsedDataEvents(body)) events.push(ev);
    expect(events).toEqual([{ type: 'message_start' }, { type: 'x' }]);
  });
});

describe('OAuth PKCE callback', () => {
  const realFetch = globalThis.fetch;
  const cfg = {
    flow: 'pkce',
    authorizeUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:0/callback',   // ephemeral port
  };
  const stateOf = (url) => new URL(url).searchParams.get('state');

  function stubTokenFetch() {
    vi.stubGlobal('fetch', async (url, opts) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) };
    });
  }

  it('rejects a callback whose state does not match (code substitution)', async () => {
    stubTokenFetch();
    const flow = oauth.begin('test', cfg);
    const port = await flow.port;
    const res = await realFetch('http://127.0.0.1:' + port + '/callback?code=attacker-code&state=wrong');
    expect(res.status).toBe(400);
    await expect(flow.wait()).rejects.toThrow(/state mismatch/);
    flow.cancel();
    vi.unstubAllGlobals();
  });

  it('exchanges the code when the state matches', async () => {
    stubTokenFetch();
    const flow = oauth.begin('test', cfg);
    const port = await flow.port;
    const res = await realFetch('http://127.0.0.1:' + port + '/callback?code=good&state=' + encodeURIComponent(stateOf(flow.url)));
    expect(res.status).toBe(200);
    const tokens = await flow.wait();
    expect(tokens.access).toBe('AT');
    flow.cancel();
    vi.unstubAllGlobals();
  });

  it('escapes the error param instead of reflecting raw HTML', async () => {
    const flow = oauth.begin('test', cfg);
    const port = await flow.port;
    const res = await realFetch('http://127.0.0.1:' + port + '/callback?error=' + encodeURIComponent('<img src=x onerror=alert(1)>'));
    const html = await res.text();
    expect(html).not.toContain('<img src');
    expect(html).toContain('&lt;img');
    await expect(flow.wait()).rejects.toThrow(/<img/);
    flow.cancel();
    vi.unstubAllGlobals();
  });

  it('serves 404 outside the callback path', async () => {
    const flow = oauth.begin('test', cfg);
    const port = await flow.port;
    const res = await realFetch('http://127.0.0.1:' + port + '/favicon.ico?code=x');
    expect(res.status).toBe(404);
    flow.cancel();
  });
});

describe('main-process IPC guards', () => {
  it('file:read refuses paths outside any open project root', async () => {
    const stub = require('electron');
    stub.__reset();
    require('../src/main/main.js');
    await new Promise(r => setTimeout(r, 200));   // let registerIpc run
    const { handlers } = stub.__state;
    const read = handlers.get('file:read');
    expect(read, 'file:read handler missing').toBeTruthy();
    for (const p of ['/etc/hostname', (process.env.HOME || '~') + '/.ssh/id_rsa', '~/.aws/credentials']) {
      const r = await read(null, { path: p });
      expect(r.ok, 'must refuse ' + p).toBe(false);
    }
    const missing = await read(null, { path: 'definitely-not-here-42.txt' });
    expect(missing.ok).toBe(false);
  });

  it('memory:read reports the .claude/CLAUDE.md file it actually read', async () => {
    const stub = require('electron');
    require('../src/main/main.js');
    await new Promise(r => setTimeout(r, 200));
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-mem-'));
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'CLAUDE.md'), 'project rules live here');
    try {
      const read = stub.__state.handlers.get('memory:read');
      const r = await read(null, { cwd: tmp });
      expect(r.ok).toBe(true);
      expect(r.project.exists).toBe(true);
      expect(r.project.content).toBe('project rules live here');
      expect(r.project.path).toBe(path.join(tmp, '.claude', 'CLAUDE.md'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('chat:create refuses a cwd that no longer exists', async () => {
    const stub = require('electron');
    require('../src/main/main.js');
    await new Promise(r => setTimeout(r, 200));
    const create = stub.__state.handlers.get('chat:create');
    const r = await create(null, { cwd: '/definitely/not/here-' + Date.now() });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/directory not found/);
  });

  it('preload exposes only channels that main actually handles, and blocks the rest', async () => {
    const stub = require('electron');
    // __invokeChannels is only exposed in dev builds (least-privilege);
    // the drift assertion below therefore runs under CCE_DEV=1.
    const prev = process.env.CCE_DEV;
    process.env.CCE_DEV = '1';
    try {
      require('../src/preload/preload.js');
    } finally {
      if (prev == null) delete process.env.CCE_DEV; else process.env.CCE_DEV = prev;
    }

    const ccx = stub.__state.exposed.get('ccx');
    expect(ccx, 'preload did not expose ccx').toBeTruthy();

    // allowed channel passes through to ipcRenderer.invoke
    const res = await ccx.invoke('app:info', {});
    expect(res.channel).toBe('app:info');
    // arbitrary or forged channels throw before reaching ipcRenderer
    expect(() => ccx.invoke('os:exec', {})).toThrow(/blocked IPC/);
    expect(() => ccx.invoke('constructor', {})).toThrow(/blocked IPC/);
    expect(() => ccx.send('chat:send', {})).toThrow(/blocked IPC/);
    ccx.send('session:write', {});   // the one fire-and-forget channel

    // drift check: every allowlisted channel has a registered handler
    // (__invokeChannels is only exposed in dev builds, gated above)
    for (const ch of ccx.__invokeChannels) {
      expect(stub.__state.handlers.has(ch), 'preload lists ' + ch + ' but main never handles it').toBe(true);
    }
  });

  it('rejects IPC requests from unauthorized origins', async () => {
    const stub = require('electron');
    require('../src/main/main.js');
    await new Promise(r => setTimeout(r, 200));
    const info = stub.__state.handlers.get('app:info');
    const res = await info({ senderFrame: { url: 'https://malicious.example.com/exploit' } }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unauthorized origin/);
  });

  it('rejects foreign file:// origins outside renderer directory', async () => {
    const stub = require('electron');
    require('../src/main/main.js');
    await new Promise(r => setTimeout(r, 200));
    const info = stub.__state.handlers.get('app:info');
    const res = await info({ senderFrame: { url: 'file:///etc/passwd' } }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unauthorized origin/);
  });
});
