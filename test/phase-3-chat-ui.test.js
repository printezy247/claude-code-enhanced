// Phase 3 (UI 8, 19, 22): empty-chat quick pills, tool-card shortcuts and the
// context ring popover.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

const open = async (extra = {}) => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    'chat:context': { ok: true, usage: { totalTokens: 70000, maxTokens: 100000, percentage: 70, categories: [{ name: 'Messages', tokens: 50000, color: '#fa0' }, { name: 'System', tokens: 20000 }] } },
    ...extra,
  } });
  await flush(4);
  return { h, w: h.window, chat: h.window.Chat.chats.get('c1') };
};
const click = (w, el, o) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, ...o }));

describe('empty chat', () => {
  it('keeps one short line and offers four pills', async () => {
    const { chat } = await open();
    const empty = chat.msgs.querySelector('.chat-empty');
    expect(empty.querySelector('h3')).toBeTruthy();
    expect(empty.querySelector('p').textContent.length).toBeLessThan(60);
    expect([...empty.querySelectorAll('.chat-pill')].map((b) => b.textContent)).toEqual(['Review changes', 'Run tests', 'Explain repo', 'Workflows']);
  });
  it('Run tests sends a test-running prompt', async () => {
    const { h, w, chat } = await open();
    click(w, [...chat.msgs.querySelectorAll('.chat-pill')].find((b) => b.textContent === 'Run tests'));
    await flush(4);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload.text).toMatch(/test/i);
  });
  it('Workflows opens the workflow menu', async () => {
    const { w, chat } = await open();
    click(w, [...chat.msgs.querySelectorAll('.chat-pill')].find((b) => b.textContent === 'Workflows'));
    await flush(2);
    expect(chat.pane.querySelector('.wf-menu')).toBeTruthy();
  });
});

describe('context ring popover', () => {
  it('opens on click, shows usage and categories, and compacts from its button', async () => {
    const { h, w, chat } = await open();
    await flush(6);
    click(w, chat.compactBtn);
    await flush(4);
    const pop = chat.pane.querySelector('.ctx-pop');
    expect(pop).toBeTruthy();
    expect(pop.textContent).toContain('70.0k / 100.0k');
    expect(pop.querySelectorAll('.ctx-pop-bar').length).toBe(2);
    click(w, pop.querySelector('.ctx-pop-compact'));
    await flush(4);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload.text).toBe('/compact');
    expect(chat.pane.querySelector('.ctx-pop')).toBeNull();
  });
  it('Shift+click compacts at once, with no popover', async () => {
    const { h, w, chat } = await open();
    click(w, chat.compactBtn, { shiftKey: true });
    await flush(4);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload.text).toBe('/compact');
    expect(chat.pane.querySelector('.ctx-pop')).toBeNull();
  });
  it('a second click or Escape closes it', async () => {
    const { w, chat } = await open();
    click(w, chat.compactBtn);
    click(w, chat.compactBtn);
    expect(chat.pane.querySelector('.ctx-pop')).toBeNull();
    click(w, chat.compactBtn);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(chat.pane.querySelector('.ctx-pop')).toBeNull();
  });
});

describe('tool card shortcuts', () => {
  const ev = (w, msg) => w.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  it('an Edit card has an open-in-diff button that opens the Review tab on that file', async () => {
    const { w, chat } = await open();
    ev(w, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/proj/a.js', old_string: 'x', new_string: 'y' } }] } });
    const btn = chat.msgs.querySelector('.tool-card.kind-edit .tool-open-diff');
    expect(btn).toBeTruthy();
    click(w, btn);
    expect(w.document.querySelector('#split-kind').value).toBe('review');
    expect(w.__reviewPick).toBe('a.js');
  });
  it('a failed Bash card offers fix-in-chat, which fills the composer', async () => {
    const { w, chat } = await open();
    ev(w, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } });
    expect(chat.msgs.querySelector('.tool-fix')).toBeNull();
    ev(w, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'FAIL', is_error: true }] } });
    const btn = chat.msgs.querySelector('.tool-card .tool-fix');
    expect(btn).toBeTruthy();
    click(w, btn);
    expect(chat.composer.value).toContain('npm test');
  });
});
