// Follow-ups from the code review of the Ctrl+K / side-panel commit:
//  - Ctrl+K and Ctrl+E must not be taken from the side-panel shell, the diff
//    editor, other views or dialogs
//  - leaving the Overview for the Terminal must cancel an Overview render that
//    is still waiting on git
//  - a task-list change redraws only the Tasks card (no git / engine calls)
//  - the panel renders from chat.todos, not from the drawer's markup
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let gate;          // when set, git:info waits on it
let h;
const open = () => { let go; const p = new Promise((r) => { go = r; }); p.go = go; return p; };

beforeEach(async () => {
  gate = null;
  h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      'git:info': async () => { if (gate) await gate; return { ok: true, repo: 'me/proj', branch: 'main', dirty: 0, files: [] }; },
      'chat:context': { ok: true, usage: { totalTokens: 5000, maxTokens: 100000, percentage: 5 } },
      'chat:mcp': { ok: true, servers: [] },
    },
  });
  await flush(4);
});

const doc = () => h.window.document;
const keydown = (target, key) => target.dispatchEvent(
  new h.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
const paletteOpen = () => !!doc().querySelector('.palette-back');
const calls = (channel) => h.calls.filter((c) => c.channel === channel).length;

describe('Ctrl+K / Ctrl+E only act on the chat itself', () => {
  it('leave the side-panel shell alone', () => {
    const shell = doc().createElement('div');
    shell.className = 'xterm';
    doc().querySelector('#split-body').appendChild(shell);
    const ev = keydown(shell, 'k');
    expect(ev).toBe(true);                 // not preventDefault-ed: the shell keeps it
    expect(paletteOpen()).toBe(false);
    keydown(shell, 'e');
    expect(doc().querySelector('.chat-pane').classList.contains('composer-expanded')).toBe(false);
  });

  it('leave the diff editor alone', () => {
    const ed = doc().createElement('div');
    ed.className = 'monaco-editor';
    doc().querySelector('.chat-msgs').appendChild(ed);
    keydown(ed, 'k');
    expect(paletteOpen()).toBe(false);
  });

  it('open from another view too (Ctrl+K works everywhere)', () => {
    h.window.state.view = 'settings';
    keydown(doc().body, 'k');
    expect(paletteOpen()).toBe(true);
    keydown(doc().body, 'k');   // toggles it closed again
    h.window.state.view = 'conversations';
  });

  it('do nothing from an input in a dialog', () => {
    const modal = doc().createElement('div');
    modal.className = 'modal';
    const input = doc().createElement('input');
    modal.appendChild(input);
    doc().body.appendChild(modal);
    keydown(input, 'k');
    expect(paletteOpen()).toBe(false);
  });

  it('still work from the composer, and Ctrl+K closes the palette from its own input', () => {
    keydown(doc().querySelector('.chat-input'), 'k');
    expect(paletteOpen()).toBe(true);
    keydown(doc().querySelector('.palette-back input'), 'k');
    expect(paletteOpen()).toBe(false);
  });
});

describe('a fenced example inside a fenced block stays in one block', () => {
  const { marked } = require('marked');
  const reply = [
    '```markdown',
    '## Phase 3',
    '- [ ] **3.2** Mode input:',
    '  ```pine',
    '  string mode = input.string("Intraday")',
    '  ```',
    '- [ ] **3.3** Dynamic data',
    '```',
    '',
    'Phase 4 is outside the block.',
  ].join('\n');

  it('without the fix the block closes early (the reported bug)', () => {
    const html = marked.parse(reply);
    expect(html).toContain('<li><input disabled="" type="checkbox"> <strong>3.3</strong> Dynamic data</li>');   // loose list, outside <pre>
  });

  it('lengthens the outer fence so everything stays inside <pre>', () => {
    const fixed = h.window.Chat.fixNestedFences(reply);
    expect(fixed.split('\n')[0]).toBe('````markdown');
    const html = marked.parse(fixed);
    expect(html.match(/<pre>/g).length).toBe(1);
    expect(html).toMatch(/<pre>[\s\S]*Dynamic data[\s\S]*<\/pre>/);
    expect(html).toMatch(/<\/pre>\s*<p>Phase 4 is outside the block/);
  });

  it('leaves ordinary blocks, unclosed (streaming) blocks and plain text alone', () => {
    const f = h.window.Chat.fixNestedFences;
    const simple = 'a\n```js\nx\n```\nb';
    expect(f(simple)).toBe(simple);
    const open = '```markdown\nhello\n```pine\nx';
    expect(f(open)).toBe(open);
    expect(f('no fences')).toBe('no fences');
    expect(f('')).toBe('');
  });
});

describe('context meter', () => {
  it('a slow older poll cannot overwrite a newer answer', async () => {
    const chat = h.window.Chat.chats.get('c1');
    const answers = [];
    const slow = open();
    let n = 0;
    h.window.ccx.invoke = async (ch) => {
      if (ch !== 'chat:context') return { ok: true };
      const mine = ++n;
      if (mine === 1) await slow;   // first call answers last
      return { ok: true, usage: { totalTokens: mine === 1 ? 90000 : 10000, maxTokens: 100000, percentage: mine === 1 ? 90 : 10 } };
    };
    h.window.Chat.pollContext(chat); h.window.Chat.pollContext(chat);
    await flush(4);
    slow.go();
    await flush(4);
    answers.push(doc().querySelector('.ctx-pct').textContent);
    expect(answers[0]).toBe('10%');
  });
});

describe('side panel renders', () => {
  it('an Overview still waiting on git does not land on the Terminal tab', async () => {
    gate = open();
    h.window.toggleSplit(true);
    await flush(2);
    doc().querySelector('#split-kind').value = 'terminal';
    h.window.renderSplit();
    gate.go();
    await flush(6);
    expect(doc().querySelector('#split-body [data-card]')).toBeNull();
  });

  it('a task-list change redraws only the Tasks card: no git or engine calls', async () => {
    h.window.toggleSplit(true);
    await flush(6);
    const before = { git: calls('git:info'), ctx: calls('chat:context'), mcp: calls('chat:mcp') };
    const sessionCard = doc().querySelector('[data-card="environment"]');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Do it', status: 'in_progress', activeForm: 'Doing it' }] } }] } } });
    await new Promise((r) => setTimeout(r, 250));
    expect(doc().querySelector('[data-card="tasks"] .task-now').textContent).toBe('Doing it');
    expect(calls('git:info')).toBe(before.git);
    expect(calls('chat:context')).toBe(before.ctx);
    expect(calls('chat:mcp')).toBe(before.mcp);
    expect(doc().querySelector('[data-card="environment"]')).toBe(sessionCard);   // untouched
  });

  it('the chat window has no to-do drawer; the list shows only in the Tasks card', async () => {
    expect(doc().querySelector('.chat-todos')).toBeNull();
    h.window.toggleSplit(true);
    await flush(6);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Solo', status: 'pending' }] } }] } } });
    await new Promise((r) => setTimeout(r, 250));
    expect(doc().querySelector('.chat-msgs .todo-item, .chat-pane .chat-todos')).toBeNull();
    expect(doc().querySelector('[data-card="tasks"] .task-text').textContent).toBe('Solo');
  });

  it('shows the todos from chat.todos', async () => {
    h.window.toggleSplit(true);
    await flush(6);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [
        { content: 'One', status: 'completed' }, { content: 'Two', status: 'pending' }] } }] } } });
    await new Promise((r) => setTimeout(r, 250));
    const chat = h.window.Chat.chats.get('c1');
    expect(chat.todos.map((t) => t.status)).toEqual(['completed', 'pending']);
    expect(doc().querySelector('[data-card="tasks"] .tc-badge').textContent).toBe('1/2');
  });

  it('an emptied list clears chat.todos and the panel', async () => {
    h.window.toggleSplit(true);
    await flush(6);
    const ev = (todos) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't' + Math.random(), name: 'TodoWrite', input: { todos } }] } } });
    ev([{ content: 'One', status: 'pending' }]);
    await new Promise((r) => setTimeout(r, 250));
    ev([]);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.window.Chat.chats.get('c1').todos).toEqual([]);
    expect(doc().querySelector('[data-card="tasks"] .task-list')).toBeNull();
  });
});
