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