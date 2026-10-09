// Renderer behaviour in jsdom: permission queue, escaping, link interception,
// tool cards, slash palette.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

/** ipc stub that answers a chat with the given id. */
const ipcFor = (chatRes = {}, extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null, ...chatRes },
  ...extra,
});

let h;
beforeEach(() => {
  h = loadRenderer({ ipc: ipcFor() });
});

describe('html escaping (#7)', () => {
  it('escapes markup in assistant/user text and tool titles', () => {
    const chat = h.window.Chat.chats.get('c1');
    expect(chat).toBeTruthy();
    // Push a message containing markup through the real render path.
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] } },
    });
    const html = chat.msgs.innerHTML;
    expect(html).not.toContain('<img');
  });
});

describe('permission queue (#2, #3)', () => {
  it('keeps both cards when two permission requests arrive', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'Bash',
      input: { command: 'ls' }, suggestions: [], expiresAt: Date.now() + 60000,
    });
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r2', toolName: 'Bash',
      input: { command: 'rm -rf /tmp/x' }, suggestions: [], expiresAt: Date.now() + 60000,
    });
    const pane = h.window.document.querySelector('.chat-pane');
    const cards = pane.querySelectorAll('.perm-card');
    expect(cards.length).toBe(2);
    const rids = [...cards].map(c => c.dataset.rid);
    expect(rids).toContain('r1');
    expect(rids).toContain('r2');
  });

  it('removes only the answered card', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'Bash', input: {}, suggestions: [], expiresAt: Date.now() + 60000,
    });
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r2', toolName: 'Bash', input: {}, suggestions: [], expiresAt: Date.now() + 60000,
    });
    h.window.Chat.handleEvent({ id: 'c1', kind: 'permission-cleared', requestId: 'r1', reason: 'interrupted' });
    const cards = h.window.document.querySelectorAll('.perm-card');
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.rid).toBe('r2');
  });

  it('omits the session rule button when the engine sends no suggestions (#3)', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'Bash', input: {}, suggestions: [],
      expiresAt: Date.now() + 60000,
    });
    const labels = [...h.window.document.querySelectorAll('.perm-card .btn')].map(b => b.textContent);
    expect(labels).toContain('Allow once');
    expect(labels).toContain('Deny');
    expect(labels).not.toContain('Allow for this session');
  });

  it('offers a scoped session rule when suggestions carry ruleContent (#3)', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'Bash', input: { command: 'npm test' },
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'session' }],
      expiresAt: Date.now() + 60000,
    });
    const btn = [...h.window.document.querySelectorAll('.perm-card .btn')]
      .find(b => b.textContent === 'Allow for this session');
    expect(btn).toBeTruthy();
    expect(btn.title).toContain('npm test *');
  });

  it('hides the session rule button when suppressAlwaysAllowRule is set (#3)', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'Bash', input: {},
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: '*' }] }],
      suppressAlwaysAllowRule: true, expiresAt: Date.now() + 60000,
    });
    const labels = [...h.window.document.querySelectorAll('.perm-card .btn')].map(b => b.textContent);
    expect(labels).not.toContain('Allow for this session');
  });

  it('shows the engine prompt sentence and reason (#28)', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'Bash',
      input: { command: 'rm -rf /etc' }, suggestions: [],
      title: 'Claude wants to run a command', decisionReason: 'outside allowed directories',
      expiresAt: Date.now() + 60000,
    });
    const pane = h.window.document.querySelector('.chat-pane');
    expect(pane.textContent).toContain('Claude wants to run a command');
    expect(pane.textContent).toContain('outside allowed directories');
    // The command is shown as a command, not raw JSON.
    expect(pane.querySelector('.perm-command').textContent).toContain('rm -rf /etc');
  });

  it('clears every card on chat close (no leaked timers)', async () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'Bash', input: {}, suggestions: [], expiresAt: Date.now() + 60000,
    });
    await h.window.Chat.closeChat('c1');
    expect(h.window.document.querySelectorAll('.perm-card').length).toBe(0);
  });
});

describe('link interception (#6)', () => {
  it('sends an http link to the shell instead of navigating', () => {
    const a = h.window.document.createElement('a');
    a.href = 'https://example.com/x';
    a.textContent = 'link';
    h.window.document.body.appendChild(a);
    a.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const last = h.calls.filter(c => c.channel === 'shell:openExternal').pop();
    expect(last).toBeTruthy();
    expect(last.payload.url).toBe('https://example.com/x');
    a.remove();
  });

  it('leaves non-http links alone', () => {
    const a = h.window.document.createElement('a');
    a.href = '#anchor';
    a.textContent = 'anchor';
    h.window.document.body.appendChild(a);
    a.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(h.calls.filter(c => c.channel === 'shell:openExternal').length).toBe(0);
    a.remove();
  });
});

describe('message rendering', () => {
  it('renders a text block as a message', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } },
    });
    const pane = h.window.document.querySelector('.chat-pane');
    expect(pane.querySelectorAll('.assistant-msg').length).toBe(1);
    expect(pane.textContent).toContain('hello there');
  });

  it('renders a tool_use block as a card and resolves it on tool_result', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } }] } },
    });
    const pane = h.window.document.querySelector('.chat-pane');
    const card = pane.querySelector('.tool-card');
    expect(card).toBeTruthy();
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'hi\n' }] } },
    });
    expect(card.querySelector('.tool-output').textContent).toContain('hi');
  });
});

describe('chat tab count (#14)', () => {
  it('counts chat tabs in the nav badge', async () => {
    expect(h.window.tabRegistry.size).toBeGreaterThanOrEqual(1);
    expect(h.window.document.querySelector('#sess-count').textContent)
      .toBe(String(h.window.tabRegistry.size));
  });

  it('decrements when a chat tab closes', async () => {
    const before = Number(h.window.document.querySelector('#sess-count').textContent);
    await h.window.Chat.closeChat('c1');
    await flush();
    expect(Number(h.window.document.querySelector('#sess-count').textContent)).toBe(before - 1);
  });
});
describe('early tool results (#4) and registry cap (#8)', () => {
  it('buffers a result that beats its card and applies it on arrival', () => {
    const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
    // Result first: no card exists yet.
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'early1', content: 'file contents here' }] } });
    const chat = h.window.Chat.chats.get('c1');
    expect(chat.pendingResults.has('early1')).toBe(true);
    // Card arrives later and resolves immediately.
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'early1', name: 'Bash', input: { command: 'echo hi' } }] } });
    const card = chat.msgs.querySelector('.tool-card');
    expect(card).toBeTruthy();
    expect(card.querySelector('.tool-output').textContent).toContain('file contents here');
    expect(chat.pendingResults.has('early1')).toBe(false);
  });

  it('caps the tool registry instead of growing forever', () => {
    const chat = h.window.Chat.chats.get('c1');
    const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
    for (let i = 0; i < 350; i++) {
      send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'cap' + i, name: 'Bash', input: { command: 'echo ' + i } }] } });
    }
    expect(chat.tools.size).toBeLessThanOrEqual(300);
    // The newest card still resolves.
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cap349', content: 'hit' }] } });
    expect(chat.msgs.querySelector('.tool-output')).toBeTruthy();
  });
});

describe('depth indicator (#18)', () => {
  it('marks nested subagent calls with their depth', () => {
    const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'explore' } }] } });
    // A Bash call nested inside the Task frame carries the parent id.
    send({
      type: 'assistant', parent_tool_use_id: 'task1',
      message: { content: [{ type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'ls' } }] },
    });
    const chips = [...h.window.document.querySelectorAll('.depth-chip')];
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('depth 1');
    // Top-level cards get no chip.
    expect(h.window.document.querySelectorAll('.tool-card').length).toBeGreaterThanOrEqual(2);
  });
});

describe('resume refusal (#5)', () => {
  it('explains a refused branch with a recovery action', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Resume rejected by --resume-drops-turn: turn has appends' },
    });
    const pane = h.window.document.querySelector('.chat-pane');
    expect(pane.textContent).toContain('Could not branch from that message');
    const retry = [...pane.querySelectorAll('.btn')].find(b => b.textContent.includes('latest message'));
    expect(retry).toBeTruthy();
    retry.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const created = h.calls.filter(c => c.channel === 'chat:create').pop();
    expect(created.payload.fork).toBe(true);
    expect(created.payload.resumeAt).toBeUndefined();
  });
});

describe('user message is drawn once', () => {
  const send = (chat, text) => {
    chat.composer.value = text;
    chat.composer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  const replay = (text, uuid) => h.window.Chat.handleEvent({
    id: 'c1', kind: 'message',
    msg: { type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } },
  });

  it('merges the engine replay into the bubble the composer already showed', () => {
    const chat = h.window.Chat.chats.get('c1');
    send(chat, 'hello');
    expect(chat.msgs.querySelectorAll('.user-msg')).toHaveLength(1);
    replay('hello', 'uuid-1');
    const bubbles = chat.msgs.querySelectorAll('.user-msg');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].dataset.uuid).toBe('uuid-1');   // now carries the rewind anchor
  });

  it('keeps the replayed message in place when something was drawn after it', () => {
    const chat = h.window.Chat.chats.get('c1');
    send(chat, 'hello');
    const note = h.window.document.createElement('div');
    note.className = 'sys-note';
    chat.msgs.appendChild(note);
    replay('hello', 'uuid-2');
    const kids = [...chat.msgs.children].filter(n => n.classList.contains('user-msg') || n.classList.contains('sys-note'));
    expect(kids[0].classList.contains('user-msg')).toBe(true);
    expect(kids[1]).toBe(note);
  });

  it('still shows a replayed message that was never typed here (resumed history)', () => {
    const chat = h.window.Chat.chats.get('c1');
    replay('from an earlier session', 'uuid-3');
    expect(chat.msgs.querySelectorAll('.user-msg')).toHaveLength(1);
  });
});
