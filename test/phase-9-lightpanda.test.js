// Lightpanda (headless browser for the model's web tasks): the user installs the
// binary, CCE only looks for it. Off in every chat until switched on for that chat.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const { createLightpanda, SERVER_NAME } = require('../src/main/lightpanda.js');
const ChatManager = require('../src/main/chats.js');

const tmpBin = (exec = true) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-')), 'lightpanda');
  fs.writeFileSync(f, '#!/bin/sh\n');
  fs.chmodSync(f, exec ? 0o755 : 0o644);
  return f;
};

describe('lightpanda module', () => {
  it('status: ready only when the binary exists and can run', () => {
    expect(createLightpanda({ binary: tmpBin() }).status()).toEqual({ ok: true, ready: true });
    expect(createLightpanda({ binary: tmpBin(false) }).status().ready).toBe(false);
    expect(createLightpanda({ binary: '/nope/lightpanda' }).status().ready).toBe(false);
  });
  it('server config is a plain stdio command, nothing on the network', () => {
    const bin = tmpBin();
    expect(createLightpanda({ binary: bin }).serverConfig()).toEqual({ type: 'stdio', command: bin, args: ['mcp'] });
  });
});

describe('per chat switch', () => {
  let setMcpServers, mgr;
  beforeEach(() => {
    setMcpServers = vi.fn(async (s) => ({ added: Object.keys(s), removed: [], errors: {} }));
    const fakeSdk = { query: () => Object.assign((async function* () { await new Promise(() => {}); })(), {
      interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn(), rewindFiles: vi.fn(), getContextUsage: vi.fn(async () => ({})),
      mcpServerStatus: vi.fn(async () => []), toggleMcpServer: vi.fn(), reconnectMcpServer: vi.fn(), setMcpServers,
      supportedAgents: vi.fn(async () => []), supportedCommands: vi.fn(async () => []), applyFlagSettings: vi.fn(), stopTask: vi.fn(),
      supportedModels: vi.fn(async () => []), setMaxThinkingTokens: vi.fn(), reinitialize: vi.fn(),
    }) };
    mgr = new ChatManager({ proxyToken: 'tok', sdk: fakeSdk });
  });
  const start = async () => (await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {}, permissionMode: 'default' })).id;

  it('a new chat has no browser server at all', async () => {
    await start();
    expect(setMcpServers).not.toHaveBeenCalled();
  });
  it('switching on adds it and keeps the connectors already there', async () => {
    const id = await start();
    await mgr.mcpSetPolicy(id, 'github', { type: 'http', url: 'https://x/mcp' }, ['a'], 'always_ask');
    await mgr.setBrowser(id, true, { type: 'stdio', command: '/b/lightpanda', args: ['mcp'] });
    const sent = setMcpServers.mock.calls[1][0];
    expect(Object.keys(sent).sort()).toEqual(['github', SERVER_NAME]);
  });
  it('switching off removes only the browser', async () => {
    const id = await start();
    await mgr.mcpSetPolicy(id, 'github', { type: 'http', url: 'https://x/mcp' }, ['a'], 'always_ask');
    await mgr.setBrowser(id, true, { type: 'stdio', command: '/b/lightpanda', args: ['mcp'] });
    await mgr.setBrowser(id, false);
    expect(Object.keys(setMcpServers.mock.calls[2][0])).toEqual(['github']);
  });
});

describe('menu item', () => {
  let h, status;
  beforeEach(async () => {
    status = { ok: true, ready: true };
    h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      'lightpanda:status': () => status,
      'chat:browser': { ok: true },
    } });
    await flush(4);
  });
  const item = () => [...h.window.document.querySelectorAll('.chat-menu-item')].find((b) => b.textContent.includes('Web browser'));
  const open = async () => { h.window.document.querySelector('.hdr-more').click(); await flush(4); };

  it('is off by default; clicking turns it on for this chat only', async () => {
    const chat = h.window.Chat.chats.get('c1');
    expect(chat.browserOn).toBeFalsy();
    await open();
    item().click();
    await flush(6);
    expect(h.calls.find((c) => c.channel === 'chat:browser').payload).toEqual({ id: 'c1', enabled: true });
    expect(chat.browserOn).toBe(true);
  });
  it('not installed: says how, and changes nothing', async () => {
    status = { ok: true, ready: false };
    await open();
    item().click();
    await flush(6);
    expect(h.calls.find((c) => c.channel === 'chat:browser')).toBeUndefined();
    expect(h.window.Chat.chats.get('c1').browserOn).toBeFalsy();
    expect(h.window.document.body.textContent).toMatch(/lightpanda/i);
  });
});
