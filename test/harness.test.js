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
    expect(window.document.querySelectorAll('.nav-btn').length).toBe(6);
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