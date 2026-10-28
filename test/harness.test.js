// Baseline: the renderer bundle must boot, and the main process must register
// its IPC surface without an app instance. Fails loudly if a future refactor
// breaks script loading or the electron stub wiring.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

/** A boot-shaped ipc stub: enough for app.js's welcome path. */
const bootIpc = () => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
});

describe('renderer harness', () => {
  it('loads app.js + chat.js and renders the nav shell', async () => {
    const { window } = loadRenderer({ ipc: bootIpc() });
    await flush();
    // Conversations, Board, Usage, Providers, Connectors, Settings. Sessions
    // and History were folded into Conversations.
    expect(window.document.querySelectorAll('.nav-btn').length).toBe(6);
    const labels = [...window.document.querySelectorAll('.nav-btn')]
      .map(b => b.querySelector('span:nth-child(2)').textContent);
    expect(labels).toEqual(['Conversations', 'Board', 'Usage', 'Providers', 'Connectors', 'Settings']);
    expect(window.document.querySelector('#view-chats')).toBeNull();
    expect(window.document.querySelector('#view-conversations')).toBeTruthy();
    expect(typeof window.switchView).toBe('function');
    expect(typeof window.Chat.createSession).toBe('function');
    window.close();
  });

  it('exposes a recording ccx bridge', async () => {
    const { window, calls } = loadRenderer({ ipc: bootIpc() });
    await flush();
    const channels = calls.map(c => c.channel);
    expect(channels).toContain('app:info');
    expect(channels).toContain('providers:all');
    window.close();
  });
});

describe('main process IPC surface', () => {
  it('registers the IPC channels the renderer calls', async () => {
    const stub = require('electron');
    stub.__reset();
    process.env.CCE_PROXY_PORT = '0';
    require('../src/main/main.js');
    await flush(8);
    const { handlers } = stub.__state;
    for (const ch of ['app:info', 'providers:all', 'chat:create', 'settings:get', 'dialog:pickDir']) {
      expect(handlers.has(ch), 'missing handler ' + ch).toBe(true);
    }
  });

  it('wraps handler failures as { ok: false, error }', async () => {
    const stub = require('electron');
    const { handlers } = stub.__state;
    const res = await handlers.get('providers:save')({ instance: null });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
describe('env refresh and custom lean tools (#21, #12)', () => {
  it('env:refresh re-reads the login shell', async () => {
    const stub = require('electron');
    const { handlers } = stub.__state;
    const res = await handlers.get('env:refresh')({});
    expect(res.ok).toBe(true);
    expect(typeof res.PATH).toBe('string');
    expect(res.PATH.length).toBeGreaterThan(0);
  });

  it('providers:save accepts a custom tool checklist, validated', async () => {
    const stub = require('electron');
    const { handlers } = stub.__state;
    // NOTE: main-process handlers are registered Electron-style as
    // (_event, payload) — the payload is the SECOND argument.
    const saved = await handlers.get('providers:save')(null, {
      instance: {
        name: 'CustomLean-' + Date.now(),
        baseUrl: 'http://localhost:11434',
        leanToolsPreset: 'custom',
        leanToolsCustom: ['Read', 'Grep', 'BogusTool', 'Bash'],
      },
    });
    expect(saved.ok).toBe(true);
    const all = await handlers.get('providers:all')(null, {});
    const inst = all.instances.find(p => p.uid === saved.uid);
    expect(inst.leanTools).toEqual(['Read', 'Grep', 'Bash']);
    // Cleanup so later runs see a stable provider list.
    await handlers.get('providers:delete')(null, { uid: saved.uid });
  });
});

describe('tool-result spill reveal is confined (#50)', () => {
  const os = require('os');
  const spillDir = os.homedir() + '/.claude/tool-results';
  const call = async (payload) => {
    const stub = require('electron');
    // main handlers are Electron-style: (_event, payload)
    return await stub.__state.handlers.get('shell:reveal')(null, payload);
  };

  it('refuses a path outside the engine tool-results directory', async () => {
    const r = await call({ path: '/etc/passwd' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refusing/);
  });

  it('refuses a traversal that escapes the spill root', async () => {
    const r = await call({ path: spillDir + '/../../../../etc/shadow' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refusing/);
  });

  it('refuses a missing file rather than throwing', async () => {
    const r = await call({ path: spillDir + '/definitely-not-here.txt' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no longer exists/);
  });

  it('refuses an empty path', async () => {
    const r = await call({ path: '' });
    expect(r.ok).toBe(false);
  });
});

describe('task frames reach the renderer on the task channel (#48)', () => {
  it('routes background_tasks_changed alongside the task_* edges', () => {
    const { TASK_SUBTYPES } = require('../src/main/chats.js');
    // The level signal must be routed too, or a dropped task_notification
    // leaves a card spinning forever.
    for (const s of ['task_started', 'task_updated', 'task_progress', 'task_notification', 'background_tasks_changed']) {
      expect(TASK_SUBTYPES).toContain(s);
    }
    // It must NOT be a wildcard: unrelated system frames stay on other channels.
    expect(TASK_SUBTYPES).not.toContain('init');
    expect(TASK_SUBTYPES).not.toContain('hook_started');
  });
});

describe('session management through the SDK (#52)', () => {
  const SID = '1a571551-242b-4a3c-b175-6aa0b93b1573';
  const stub = () => require('electron').__state.handlers;

  it('renames a session and passes the folder through', async () => {
    const calls = [];
    // The handler resolves the SDK through ChatManager, so exercise it there.
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: { renameSession: async (id, title, opts) => calls.push({ id, title, opts }) } });
    const { renameSession } = await mgr.sdk();
    await renameSession(SID, 'a name', { dir: '/tmp/x' });
    expect(calls[0]).toEqual({ id: SID, title: 'a name', opts: { dir: '/tmp/x' } });
  });

  it('rejects a session id that is not a uuid (path traversal guard)', async () => {
    // The guard the handlers use before touching the SDK.
    const isSessionIdLike = (id) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(id || ''));
    expect(isSessionIdLike(SID)).toBe(true);
    for (const bad of ['../../etc/passwd', 'not-a-uuid', '', null, SID + '/../x']) {
      expect(isSessionIdLike(bad), bad).toBe(false);
    }
  });

  it('the four handlers are registered', async () => {
    const h = stub();
    for (const ch of ['session:rename', 'session:tag', 'session:fork', 'session:subagents']) {
      expect(typeof h.get(ch), ch).toBe('function');
    }
  });

  it('a missing SDK capability is a clear error, not a crash', async () => {
    // With no renameSession exported the handler must say so plainly.
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: {} });
    const mod = await mgr.sdk();
    expect(typeof mod.renameSession).toBe('undefined');
    // And transcriptItems keeps uuids so the UI has something to branch from.
    const items = ChatManager.transcriptItems([
      { type: 'user', uuid: 'u-1', message: { content: [{ type: 'text', text: 'q' }] } },
    ]);
    expect(items[0].uuid).toBe('u-1');
  });

  it('tags can be set and cleared', async () => {
    const seen = [];
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: { tagSession: async (id, tag) => seen.push(tag) } });
    const { tagSession } = await mgr.sdk();
    await tagSession(SID, 'archived');
    await tagSession(SID, null);
    expect(seen).toEqual(['archived', null]);
  });
});
