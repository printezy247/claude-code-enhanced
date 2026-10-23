// 0.9.43: Overview is separate and always open; other side-panel tabs can be
// hidden; the "build now" button is gone; a loop notice and file-share buttons exist.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h;
let calls;
beforeEach(async () => {
  h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 0, files: [] },
      'chat:context': { ok: true, usage: { totalTokens: 5000, maxTokens: 100000, percentage: 5 } },
      'file:share': { ok: true },
      'dialog:pickFiles': { ok: true, files: [{ name: 'my doc.pdf', path: '/home/x/my doc.pdf', size: 9, ref: true }, { name: 'big.zip', path: '/home/x/big.zip', size: 9e6, ref: true }] },
    },
  });
  calls = h.calls;
  await flush(4);
});
const doc = () => h.window.document;
const click = (el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
const ev = (e) => h.window.Chat.handleEvent(Object.assign({ id: 'c1' }, e));

describe('side panel', () => {
  it('docks the Overview on the right, outside the tool panel and its tabs', () => {
    expect(doc().querySelector('#overviewpane #overview-body')).toBeTruthy();
    expect(doc().querySelector('#splitpane .split-overview')).toBe(null);
    expect(doc().querySelector('.split-tab[data-kind="tasks"]')).toBe(null);
    expect(doc().querySelector('#overviewpane').classList.contains('hidden')).toBe(false);
    // Nothing in the tool panel can close or hide the Overview.
    expect(doc().querySelector('#overviewpane #btn-split-close')).toBe(null);
    expect(doc().querySelector('#overviewpane #btn-split-tabs')).toBe(null);
  });
  it('fills the Overview without opening the tool panel, which starts closed', async () => {
    await flush(4);
    expect(doc().body.classList.contains('split-open')).toBe(false);
    expect(doc().querySelectorAll('#overview-body .task-card').length).toBeGreaterThan(0);
    expect(doc().querySelector('#overview-body').textContent).toContain('/work/proj');
  });
  it('hides and restores tool tabs from the chooser', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    click(doc().querySelector('#btn-split-tabs'));
    const rows = [...doc().querySelectorAll('#split-tabs-menu input')];
    expect(rows.length).toBe(5);
    rows[1].checked = false;   // Files
    rows[1].dispatchEvent(new h.window.Event('change', { bubbles: true }));
    expect(doc().querySelector('.split-tab[data-kind="files"]').classList.contains('hidden')).toBe(true);
    rows[1].checked = true;
    rows[1].dispatchEvent(new h.window.Event('change', { bubbles: true }));
    expect(doc().querySelector('.split-tab[data-kind="files"]').classList.contains('hidden')).toBe(false);
  });
  it('moves to another tab when the open one is hidden, and closes the panel when none is left', async () => {
    h.window.toggleSplit(true);
    await flush(4);
    const kind = doc().querySelector('#split-kind');
    kind.value = 'files';
    kind.dispatchEvent(new h.window.Event('change'));
    click(doc().querySelector('#btn-split-tabs'));
    const rows = [...doc().querySelectorAll('#split-tabs-menu input')];
    rows[1].checked = false;   // hide the open Files tab
    rows[1].dispatchEvent(new h.window.Event('change', { bubbles: true }));
    expect(kind.value).not.toBe('files');
    for (const r of rows) { r.checked = false; r.dispatchEvent(new h.window.Event('change', { bubbles: true })); }
    expect(doc().body.classList.contains('split-open')).toBe(false);
    expect(doc().querySelectorAll('#overview-body .task-card').length).toBeGreaterThan(0);   // Overview stays
  });
  it('overview cards cannot be collapsed', async () => {
    await flush(4);
    const cards = doc().querySelectorAll('#overview-body .task-card');
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.querySelector('button.task-card-head')).toBe(null);
  });
});

describe('chat header', () => {
  it('has no build now button', () => {
    expect(doc().querySelector('.chat-build-now')).toBe(null);
  });
});

describe('loop guard notice', () => {
  it('tells the user why the turn stopped', async () => {
    ev({ kind: 'loop-guard', reason: 'the same Bash call 3 times' });
    await flush();
    expect(doc().body.textContent).toContain('repeating itself');
  });
});

describe('file sharing', () => {
  it('adds share buttons under a finished Write card and calls file:share', async () => {
    ev({ kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/work/proj/out.txt', content: 'hi' } }] } } });
    ev({ kind: 'message', msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } } });
    await flush();
    const bar = doc().querySelector('.file-share');
    expect(bar).toBeTruthy();
    const save = [...bar.querySelectorAll('button')].find((b) => /Save a copy/.test(b.textContent));
    click(save);
    await flush();
    const call = calls.find((c) => c.channel === 'file:share');
    expect(call.payload).toMatchObject({ id: 'c1', path: '/work/proj/out.txt', action: 'save' });
  });
});

describe('attaching files', () => {
  it('attaches PDFs and other files by path instead of refusing them', async () => {
    const chat = h.window.Chat.chats.get('c1');
    click(chat.attachBtn);
    await flush();
    expect(chat.composer.value).toContain('@"/home/x/my doc.pdf"');
    expect(chat.composer.value).toContain('@/home/x/big.zip');
  });
});

describe('pane slash commands', () => {
  it('/files opens the Files tab', async () => {
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = '/files';
    chat.send();
    await flush(4);
    expect(doc().querySelector('#split-kind').value).toBe('files');
  });
  it('/status shows the chat state without sending to the engine', async () => {
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = '/status';
    chat.send();
    await flush();
    expect(calls.find((c) => c.channel === 'chat:send')).toBeUndefined();
  });
});
