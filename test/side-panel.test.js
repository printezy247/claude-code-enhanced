// The right-hand tasks panel showed the home folder, "start a chat to see usage"
// and no todos while a chat was open: chat tabs never told the app which tab was
// active, and newer engines track work with TaskCreate/TaskUpdate, not TodoWrite.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h;
beforeEach(async () => {
  h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 1, files: ['a.js'] },
      'chat:context': { ok: true, usage: { totalTokens: 5000, maxTokens: 100000, percentage: 5 } },
    },
  });
  await flush(4);
});

const send = (msg) => h.window.Chat.handleEvent(Object.assign({ id: 'c1', kind: 'message' }, msg));
const panel = () => h.window.document.querySelector('#split-body').textContent;
const toolUse = (id, name, input) => send({ msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } } });
const toolResult = (id, text) => send({ msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } } });

describe('tasks side panel', () => {
  it('follows the open chat, not the home folder', async () => {
    expect(h.window.state.activeId).toBe('c1');
    h.window.toggleSplit(true);
    await flush(4);
    expect(panel()).toContain('/work/proj');
    expect(panel()).not.toContain('/home/test');
    expect(panel()).toContain('⎇ main');
    expect(panel()).toContain('5,000 / 100,000 tokens');
  });

  it('lists tasks the engine makes with TaskCreate and TaskUpdate', async () => {
    toolUse('t1', 'TaskCreate', { subject: 'Typecheck the tree', description: 'x' });
    toolResult('t1', 'Task #1 created successfully: Typecheck the tree');
    toolUse('t2', 'TaskCreate', { subject: 'Run the tests', description: 'y' });
    toolResult('t2', 'Task #2 created successfully: Run the tests');
    toolUse('t3', 'TaskUpdate', { taskId: '1', status: 'completed' });
    toolResult('t3', 'Updated task #1 status');
    await flush();
    const drawer = h.window.document.querySelector('.chat-todos');
    expect(drawer.querySelector('h4').textContent).toBe('todos 1/2');
    h.window.toggleSplit(true);
    await flush(4);
    expect(panel()).toContain('Tasks 1/2');
    expect(panel()).toContain('✓ Typecheck the tree');
    expect(panel()).toContain('○ Run the tests');
  });

  it('drops a deleted task', async () => {
    toolUse('t1', 'TaskCreate', { subject: 'Temp', description: '' });
    toolResult('t1', 'Task #1 created successfully: Temp');
    toolUse('t2', 'TaskUpdate', { taskId: '1', status: 'deleted' });
    toolResult('t2', 'Updated task #1 deleted');
    await flush();
    expect(h.window.document.querySelector('.chat-todos').classList.contains('hidden')).toBe(true);
  });
});
