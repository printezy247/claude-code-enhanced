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
    expect(h.window.Chat.chats.get('c1').todos.map((t) => t.status)).toEqual(['completed', 'pending']);
    h.window.toggleSplit(true);
    await flush(4);
    const card = h.window.document.querySelector('#split-body [data-card="tasks"]');
    expect(card.querySelector('.tc-badge').textContent).toBe('1/2');
    expect(card.querySelector('li.done .task-text').textContent).toBe('Typecheck the tree');
    expect(card.querySelector('li.todo .task-text').textContent).toBe('Run the tests');
  });

  it('shows the live step and updates the open panel without waiting for a refresh', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    toolUse('t1', 'TodoWrite', { todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
    ] });
    toolResult('t1', 'ok');
    await new Promise((r) => setTimeout(r, 200));   // the coalescing delay
    const card = h.window.document.querySelector('#split-body [data-card="tasks"]');
    expect(card.querySelector('.task-now').textContent).toBe('Fixing the bug');
    expect(card.querySelector('li.active .task-text').textContent).toBe('Fix the bug');
  });

  it('drops a deleted task', async () => {
    toolUse('t1', 'TaskCreate', { subject: 'Temp', description: '' });
    toolResult('t1', 'Task #1 created successfully: Temp');
    toolUse('t2', 'TaskUpdate', { taskId: '1', status: 'deleted' });
    toolResult('t2', 'Updated task #1 deleted');
    await flush();
    expect(h.window.Chat.chats.get('c1').todos).toEqual([]);
  });
});
