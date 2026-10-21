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
    expect(text).toContain('5k / 100k');      // context window
    expect(text).toContain('Messages');              // context category breakdown
    expect(text).toContain('github');                // connector
    expect(text).toContain('2 tools');               // the connector's tool count
  });

  it('is exactly four cards like the desktop app; Tasks joins only when a list exists', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const keys = () => [...h.window.document.querySelectorAll('#split-body > [data-card]')].map((c) => c.dataset.card);
    expect(keys()).toEqual(['environment', 'context', 'connectors', 'changes']);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Do it', status: 'pending' }] } }] } } });
    await new Promise((r) => setTimeout(r, 300));
    await flush(4);
    expect(keys()).toEqual(['tasks', 'environment', 'context', 'connectors', 'changes']);
  });

  it('a Background card appears when the model starts a background task, and goes when it ends', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const card = () => h.window.document.querySelector('#split-body [data-card="background"]');
    expect(card()).toBeNull();
    h.window.Chat.handleEvent({ id: 'c1', kind: 'task', msg: { subtype: 'task_started', task_id: 'b1', description: 'npm run dev', is_backgrounded: true } });
    await new Promise((r) => setTimeout(r, 250));
    expect(card().textContent).toContain('npm run dev');
    expect(card().querySelector('.tc-badge').textContent).toBe('1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'task', msg: { subtype: 'task_notification', task_id: 'b1', status: 'completed' } });
    await new Promise((r) => setTimeout(r, 250));
    expect(card()).toBeNull();
  });

  it('context reads like the desktop card: "N% used", compact totals, a row per category with its share', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const ctx = h.window.document.querySelector('[data-card="context"]');
    expect(ctx.textContent).toContain('5% used');
    expect(ctx.textContent).toContain('5k / 100k');
    expect(ctx.querySelector('.ctx-cat').textContent).toContain('Messages');
    expect(ctx.querySelector('.ctx-cat').textContent).toContain('3k');
    expect(ctx.querySelector('.ctx-cat').textContent).toContain('3.0%');
    expect(ctx.querySelector('.ctx-ring')).toBeNull();
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
