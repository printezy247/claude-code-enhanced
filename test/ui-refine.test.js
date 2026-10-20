// 0.9.33: one-line composer with expand, workflows picker, compact in place,
// panel frames with a close button, conversation categories, the right rail,
// the sandbox npm cache, and the request/response fixes from the audit.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const chatsMod = require('../src/main/chats.js');
const proxy = require('../src/main/proxy.js');

const SESSIONS = [
  { cwd: '/home/jack/alpha', sessionId: 'a1', mtime: Date.now() - 3600e3, preview: 'alpha one' },
  { cwd: '/home/jack/alpha', sessionId: 'a2', mtime: Date.now() - 7200e3, preview: 'alpha two', tag: 'archived' },
  { cwd: '/home/jack/beta', sessionId: 'b1', mtime: Date.now() - 600e3, preview: 'beta one' },
];
const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  'chat:send': { ok: true },
  'chats:index': { ok: true, sessions: SESSIONS },
  'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 1, files: ['a.js'] },
  'chat:context': { ok: true, usage: { totalTokens: 70000, maxTokens: 100000, percentage: 70, categories: [] } },
  'chat:mcp': { ok: true, servers: [{ name: 'github', status: 'connected', tools: [{ name: 'create_issue', description: 'Open an issue' }] }] },
  'project:files': { ok: true, files: ['src/a.js', 'src/b.js', 'README.md'] },
  ...extra,
});

let h;
beforeEach(async () => { h = loadRenderer({ ipc: ipc() }); await flush(4); });
const doc = () => h.window.document;
const pane = () => doc().querySelector('.chat-pane');
const click = (n) => n.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
const chat = () => h.window.Chat.chats.get('c1');

describe('composer', () => {
  it('holds attach, text, expand and send in one box', () => {
    const row = pane().querySelector('.chat-input-row');
    for (const sel of ['.chat-attach', '.chat-input', '.chat-expand', '.chat-send']) {
      expect(row.querySelector(sel), sel).toBeTruthy();
    }
    expect(pane().querySelector('.chat-workflows')).toBeNull();   // the chip row is gone
  });

  it('shows expand only once the text is longer than a line, and toggles it', () => {
    const c = chat();
    expect(c.expandBtn.classList.contains('hidden')).toBe(true);
    c.composer.value = 'line one\nline two';
    c.composer.dispatchEvent(new h.window.Event('input'));
    expect(c.expandBtn.classList.contains('hidden')).toBe(false);
    click(c.expandBtn);
    expect(pane().classList.contains('composer-expanded')).toBe(true);
    expect(c.expandBtn.getAttribute('aria-pressed')).toBe('true');
    click(c.expandBtn);
    expect(pane().classList.contains('composer-expanded')).toBe(false);
  });
});

describe('workflows picker', () => {
  it('sits in the footer next to the model picker and opens a grouped menu', () => {
    const foot = pane().querySelector('.chat-footbar');
    const kids = [...foot.children];
    expect(kids.indexOf(foot.querySelector('.chat-wf-btn'))).toBeLessThan(kids.indexOf(foot.querySelector('.chat-model-foot')));
    click(chat().wfBtn);
    const menu = pane().querySelector('.wf-menu');
    expect(menu).toBeTruthy();
    const groups = [...menu.querySelectorAll('.wf-group-name')].map(g => g.textContent);
    expect(groups).toEqual(['Understand', 'Plan', 'Build', 'Verify', 'Ship']);
    expect(menu.querySelectorAll('.wf-item').length).toBeGreaterThanOrEqual(12);
  });

  it('a self-contained workflow runs at once', async () => {
    click(chat().wfBtn);
    click(pane().querySelector('.wf-item[data-wf="security"]'));
    await flush(4);
    const sent = h.calls.filter(c => c.channel === 'chat:send').pop();
    expect(sent.payload.text).toMatch(/Security-review/);
    expect(pane().querySelector('.wf-menu')).toBeNull();
  });
});

describe('compact in place', () => {
  it('sends the engine /compact to the same chat, no new session', async () => {
    click(chat().compactBtn);
    await flush(4);
    const sent = h.calls.filter(c => c.channel === 'chat:send').pop();
    expect(sent.payload).toMatchObject({ id: 'c1', text: '/compact' });
    expect(h.calls.filter(c => c.channel === 'chat:create').length).toBe(1);
  });

  it('/handoff keeps the old brief-then-new-session flow', async () => {
    chat().composer.value = '/handoff';
    chat().send();
    await flush(4);
    const sent = h.calls.filter(c => c.channel === 'chat:send').pop();
    expect(sent.payload.text).toMatch(/handoff brief/);
  });
});

describe('header menu and panels', () => {
  const openMenu = () => { click(pane().querySelector('.hdr-more')); return doc().querySelector('.chat-menu'); };

  it('has sections, a close button and real icons for every item', () => {
    const menu = openMenu();
    expect(menu.querySelectorAll('.chat-menu-sec').length).toBeGreaterThanOrEqual(3);
    for (const it of menu.querySelectorAll('.chat-menu-item')) {
      expect(it.querySelector('.chat-menu-ico svg'), it.textContent).toBeTruthy();
    }
    click(menu.querySelector('.panel-close'));
    expect(doc().querySelector('.chat-menu')).toBeNull();
  });

  it('every panel opened from the menu has a close button, and only one is open', async () => {
    let menu = openMenu();
    click([...menu.querySelectorAll('.chat-menu-item')].find(b => b.textContent.includes('MCP servers')));
    await flush(4);
    const mcp = pane().querySelector('.chat-mcp-panel');
    expect(mcp.querySelector('.panel-close')).toBeTruthy();
    expect(mcp.textContent).toContain('1 connected');
    menu = openMenu();
    click([...menu.querySelectorAll('.chat-menu-item')].find(b => b.textContent.includes('Memory')));
    await flush(4);
    expect(pane().querySelectorAll('.chat-skills-panel').length).toBe(1);
    click(pane().querySelector('.chat-skills-panel .panel-close'));
    expect(pane().querySelector('.chat-skills-panel')).toBeNull();
  });
});

describe('conversation categories', () => {
  const openList = async () => { h.window.toggleConversations(true); await flush(4); };
  const tab = (v) => doc().querySelector(`#convo-drop .convo-tab[data-view="${v}"]`);
  const rows = () => [...doc().querySelectorAll('#convo-drop .convo-row')].map(r => r.querySelector('.convo-preview').textContent);

  it('All hides archived; Archived shows only archived', async () => {
    await openList();
    expect(rows()).not.toContain('alpha two');
    click(tab('archived'));
    expect(rows()).toEqual(['alpha two']);
    expect(tab('archived').querySelector('.ct-n').textContent).toBe('1');
  });

  it('Pin puts a conversation on top and in the Pinned tab', async () => {
    await openList();
    const row = [...doc().querySelectorAll('#convo-drop .convo-row')].find(r => r.textContent.includes('alpha one'));
    click(row.querySelector('.convo-more'));
    click([...doc().querySelectorAll('.convo-menu-item')].find(b => b.textContent.includes('Pin')));
    expect(doc().querySelector('#convo-drop .convo-pinned').textContent).toContain('alpha one');
    click(tab('pinned'));
    expect(rows()).toEqual(['alpha one']);
  });

  it('the row menu is styled with icons, not stock buttons', async () => {
    await openList();
    click(doc().querySelector('#convo-drop .convo-more'));
    const items = doc().querySelectorAll('.convo-menu-item');
    expect(items.length).toBeGreaterThan(5);
    for (const i of items) expect(i.querySelector('.cm-ico svg')).toBeTruthy();
    const css = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
    expect(css).toMatch(/\.convo-menu-item \{/);
  });

  it('can group by date instead of project', async () => {
    await openList();
    const sel = doc().querySelector('#convo-drop .convo-groupby');
    sel.value = 'date';
    sel.dispatchEvent(new h.window.Event('change'));
    const heads = [...doc().querySelectorAll('#convo-drop .convo-sec .cs-name')].map(n => n.textContent);
    expect(heads).toContain('Today');
  });
});

describe('right rail', () => {
  it('uses tabs, collapsible cards and shows the session', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const tabs = doc().querySelectorAll('#splitpane .split-tab');
    expect(tabs.length).toBe(6);
    const sess = doc().querySelector('.task-card[data-card="session"]');
    expect(sess.textContent).toContain('model');
    const head = doc().querySelector('.task-card[data-card="context"] .task-card-head');
    click(head);
    expect(head.closest('.task-card').classList.contains('closed')).toBe(true);
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });

  it('the Files tab filters', async () => {
    h.window.toggleSplit(true);
    click(doc().querySelector('#splitpane .split-tab[data-kind="files"]'));
    await flush(4);
    const f = doc().querySelector('#split-body .rail-filter');
    f.value = 'README';
    f.dispatchEvent(new h.window.Event('input'));
    expect(doc().querySelectorAll('#split-body .file-row').length).toBe(1);
  });
});

describe('sandboxed npm cache', () => {
  it('makes a writable cache folder under the home directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-npm-'));
    const dir = chatsMod.sandboxNpmCache(home);
    expect(dir).toBe(path.join(home, '.cache', 'claude-code-enhanced', 'npm'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});

describe('request / response fixes', () => {
  it('cut-off tool arguments are not passed on as a call', () => {
    expect(proxy.toolArgsComplete('{"file_path":"/a/b')).toBe(false);
    expect(proxy.toolArgsComplete('{"a":1}')).toBe(true);
    expect(proxy.toolArgsComplete('')).toBe(true);
    const out = proxy.aggregateToAnthropic({
      choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 't', function: { name: 'Read', arguments: '{"file_pa' } }] } }],
    }, { model: 'm' });
    expect(out.content.some(b => b.type === 'tool_use')).toBe(false);
    expect(out.stop_reason).toBe('end_turn');   // not tool_use with no tool block
  });

  it('send() on a closed session reports an error instead of hanging busy', () => {
    const m = new chatsMod({ sdk: {} });
    m.chats.set('cx', { push: () => false, sessionId: 's' });
    const r = m.send('cx', 'hello');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ended/);
  });

  it('the result of a queued turn keeps the chat busy', async () => {
    chat().busy = true;
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'result', subtype: 'success', is_error: false, result: 'ok', queued_turn_count: 1 } });
    expect(chat().busy).toBe(true);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'result', subtype: 'success', is_error: false, result: 'ok', queued_turn_count: 0 } });
    expect(chat().busy).toBe(false);
  });

  it('an API error shows the provider text, not just the code', () => {
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', error: 'invalid_request', message: { content: [{ type: 'text', text: 'model not found' }] } } });
    expect(pane().querySelector('.chat-msgs').textContent).toContain('invalid_request: model not found');
  });

  it('a closing remark is not taken for an unfinished step', () => {
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'result', subtype: 'success', is_error: false, result: "All three files are updated. I'll leave the tests as they are." } });
    expect(pane().querySelector('.chat-msgs').textContent).not.toMatch(/nudging/);
  });
});

describe('chat shortcuts work wherever focus is', () => {
  const key = (k) => doc().body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true }));

  it('Ctrl+K opens the palette with focus outside the composer', () => {
    chat().composer.blur();
    key('k');
    expect(doc().querySelector('.palette-back')).toBeTruthy();
    key('k');   // pressing it again closes it
    expect(doc().querySelector('.palette-back')).toBeNull();
  });

  it('Ctrl+E toggles the expanded composer from anywhere in the chat', () => {
    chat().composer.blur();
    key('e');
    expect(pane().classList.contains('composer-expanded')).toBe(true);
    key('e');
    expect(pane().classList.contains('composer-expanded')).toBe(false);
  });
});
