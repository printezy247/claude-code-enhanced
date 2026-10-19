// The right-hand rail must read like the desktop app's session column:
// Environment, Context (with a category breakdown), Connectors, Tasks.
// Before, only the context card rendered — the git call answered without
// `ok`, so the environment and changes cards were dropped.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h;
const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/work/proj', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
  'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 2, files: ['a.js', 'b.js'] },
  'chat:context': { ok: true, usage: {
    totalTokens: 5000, maxTokens: 100000, percentage: 5,
    categories: [
      { name: 'Messages', tokens: 3000, color: '#ff9a3c', kind: 'used' },
      { name: 'Free', tokens: 95000, color: '#333', kind: 'free' },
    ],
  } },
  'chat:mcp': { ok: true, servers: [
    { name: 'github', status: 'connected', tools: [{ name: 'create_issue' }, { name: 'list_repos' }] },
  ] },
  ...extra,
});

beforeEach(async () => {
  h = loadRenderer({ ipc: ipc() });
  await flush(4);
});

const panel = () => h.window.document.querySelector('#split-body').textContent;

describe('right-hand session rail', () => {
  it('shows environment, context, connectors and tasks', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const text = panel();
    expect(text).toContain('/work/proj');
    expect(text).toContain('main');                 // git branch, not just the folder
    expect(text).toContain('5,000 / 100,000');      // context window
    expect(text).toContain('Messages');              // context category breakdown
    expect(text).toContain('github');                // connector
    expect(text).toContain('2 tools');               // the connector's tool count
  });

  it('lists the changed files of the working tree', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    expect(panel()).toContain('a.js');
    expect(panel()).toContain('b.js');
  });

  it('gives the terminal pane a real PTY session', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const kind = h.window.document.querySelector('#split-kind');
    kind.value = 'terminal';
    h.window.renderSplit();
    await flush(4);
    const call = h.calls.find(c => c.channel === 'session:create');
    expect(call).toBeTruthy();
    expect(call.payload.type).toBe('shell');
  });

  it('refreshes the rail on a timer while it is open', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const before = h.calls.filter(c => c.channel === 'git:info').length;
    await new Promise(r => setTimeout(r, 6300));
    await flush(4);
    expect(h.calls.filter(c => c.channel === 'git:info').length).toBeGreaterThan(before);
    h.window.toggleSplit(false);
  });
});
