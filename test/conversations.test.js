// The Conversations tab: one list for open tabs and stored sessions, grouped
// by folder, with a folder filter, a sort dropdown and per-row actions.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const NOW = Date.now();
const H = 3600e3;
const D = 86400e3;

/** Three folders, mixed ages, plus one row whose preview matches the query. */
const SESSIONS = [
  { cwd: '/home/jack/alpha', folder: '-home-jack-alpha', sessionId: 'a1', mtime: NOW - 1 * H, preview: 'fix the parser bug' },
  { cwd: '/home/jack/alpha', folder: '-home-jack-alpha', sessionId: 'a2', mtime: NOW - 2 * D, preview: 'older alpha work' },
  { cwd: '/home/jack/beta', folder: '-home-jack-beta', sessionId: 'b1', mtime: NOW - 3 * H, preview: 'write integration tests' },
  { cwd: '/home/jack/beta', folder: '-home-jack-beta', sessionId: 'b2', mtime: NOW - 6 * D, preview: 'beta refactor' },
  { cwd: '/tmp', folder: '-tmp', sessionId: 't1', mtime: NOW - 20 * 60e3, preview: 'quick scratch run' },
];

const bootIpc = (sessions = SESSIONS) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null, leanPresets: [] },
  'settings:get': {
    ok: true,
    settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, theme: 'dark', failoverChain: [], sandbox: {} },
    claude: { found: true, path: '', version: '' },
    leanPresets: [],
  },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c9', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  'chats:index': { ok: true, sessions },
  'usage:scan': { ok: true, days: [], total: 0, sessions: 0 },
  'chat:transcript': { ok: true, items: [{ t: 'user', text: 'hello' }, { t: 'assistant', text: 'hi' }] },
  'chat:export': { ok: true, saved: true, path: '/tmp/out.md' },
  'chat:delete': { ok: true, deleted: true },
});

async function boot(sessions = SESSIONS) {
  const h = loadRenderer({ ipc: bootIpc(sessions) });
  await flush(10);
  h.window.switchView('conversations');
  await flush(10);
  return h;
}

const list = (win) => win.document.querySelector('#convo-list');
const rows = (win) => [...win.document.querySelectorAll('.convo-row')];
const groups = (win) => [...win.document.querySelectorAll('.convo-group')];

describe('conversation list structure', () => {
  it('groups by folder, folders newest first', async () => {
    const h = await boot();
    const names = groups(h.window).map(g => g.querySelector('.cs-name').textContent);
    // /tmp (20m) beats /home/jack/alpha (1h) beats /home/jack/beta (3h).
    expect(names).toEqual(['tmp', 'alpha', 'beta']);
    h.window.close();
  });

  it('puts time buckets inside each folder group', async () => {
    const h = await boot();
    const alpha = groups(h.window)[1];
    const buckets = [...alpha.querySelectorAll('.convo-bucket')].map(b => b.textContent);
    expect(buckets).toContain('Today');
    expect(buckets).toContain('Earlier this week');
    // 2 days old is not "Today".
    expect(alpha.querySelectorAll('.convo-row').length).toBe(2);
    h.window.close();
  });

  it('shows one row per session with folder and age', async () => {
    const h = await boot();
    expect(rows(h.window).length).toBe(5);
    const meta = rows(h.window)[0].querySelector('.convo-meta').textContent;
    expect(meta).toContain('tmp');
    expect(meta).toMatch(/just now|\d+m ago/);
    h.window.close();
  });

  it('reports the total in the footer', async () => {
    const h = await boot();
    expect(h.window.document.querySelector('#convo-foot').textContent).toContain('5 conversations');
    h.window.close();
  });
});

describe('filter and sort', () => {
  it('filters to one folder', async () => {
    const h = await boot();
    const sel = h.window.document.querySelector('.convo-filter');
    expect([...sel.options].map(o => o.value)).toContain('/home/jack/beta');
    sel.value = '/home/jack/beta';
    sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    expect(groups(h.window).length).toBe(1);
    expect(rows(h.window).length).toBe(2);
    expect(h.window.document.querySelector('#convo-foot').textContent).toContain('2 of 5');
    h.window.close();
  });

  it('searches preview text across folders', async () => {
    const h = await boot();
    const box = h.window.document.querySelector('.convo-search');
    box.value = 'refactor';
    box.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(rows(h.window).length).toBe(1);
    expect(rows(h.window)[0].textContent).toContain('beta refactor');
    h.window.close();
  });

  it('sorts oldest first', async () => {
    const h = await boot();
    const sel = h.window.document.querySelector('.convo-sort');
    sel.value = 'old';
    sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    // The folder holding the oldest conversation leads.
    expect(groups(h.window)[0].querySelector('.cs-name').textContent).toBe('beta');
    h.window.close();
  });

  it('says so when nothing matches', async () => {
    const h = await boot();
    const box = h.window.document.querySelector('.convo-search');
    box.value = 'zzzz-nothing';
    box.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(list(h.window).textContent).toContain('Nothing matches');
    h.window.close();
  });
});

describe('per-row actions menu', () => {
  it('offers open, fork, transcript, export, new, delete', async () => {
    const h = await boot();
    const more = rows(h.window)[0].querySelector('.convo-more');
    more.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const menu = h.window.document.querySelector('.convo-menu');
    expect(menu).toBeTruthy();
    const labels = [...menu.querySelectorAll('.cm-label')].map(b => b.textContent);
    expect(labels).toEqual(['Open', 'Fork', 'Transcript', 'Export', 'New chat in this folder', 'Delete']);
    h.window.close();
  });

  it('opens the read-only transcript with Resume and Fork', async () => {
    const h = await boot();
    rows(h.window)[0].querySelector('.convo-more')
      .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const transcriptItem = [...h.window.document.querySelectorAll('.convo-menu-item')]
      .find(b => b.querySelector('.cm-label').textContent === 'Transcript');
    transcriptItem.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush(6);
    const modal = h.window.document.querySelector('#modal-root .modal');
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain('hello');
    const buttons = [...modal.querySelectorAll('.btn')].map(b => b.textContent);
    expect(buttons).toContain('Resume');
    expect(buttons).toContain('Fork');
    h.window.close();
  });

  it('deletes only after a confirmation click', async () => {
    const h = await boot();
    const row = rows(h.window)[0];
    const sessionId = SESSIONS.find((s) => s.preview === row.querySelector('.convo-preview').textContent).sessionId;
    row.querySelector('.convo-more').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    const del = [...h.window.document.querySelectorAll('.convo-menu-item')]
      .find(b => b.querySelector('.cm-label').textContent === 'Delete');
    // First click only arms it.
    del.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush(4);
    expect(h.calls.filter(c => c.channel === 'chat:delete').length).toBe(0);
    expect(del.querySelector('.cm-hint').textContent).toBe('sure?');
    // Second click deletes.
    del.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush(6);
    const calls = h.calls.filter(c => c.channel === 'chat:delete');
    expect(calls.length).toBe(1);
    expect(calls[0].payload.sessionId).toBe(sessionId);
    h.window.close();
  });

  it('clicking the row resumes the session live', async () => {
    const h = await boot();
    rows(h.window)[0].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush(6);
    const created = h.calls.filter(c => c.channel === 'chat:create').pop();
    expect(created.payload.resume).toBeTruthy();
    expect(created.payload.cwd).toBe('/tmp');
    h.window.close();
  });
});

describe('nav consolidation', () => {
  it('has no Sessions or History entries', async () => {
    const h = await boot();
    const views = [...h.window.document.querySelectorAll('.nav-btn')].map(b => b.dataset.view);
    expect(views).not.toContain('terminal');
    expect(views).not.toContain('chats');
    h.window.close();
  });

  it('opens the conversation list with the Conversations tab', async () => {
    const h = loadRenderer({ ipc: bootIpc() });
    await flush(10);
    const box = h.window.document.querySelector('#convos');
    box.classList.remove('open');
    h.window.switchView('usage');
    expect(box.classList.contains('open')).toBe(false);
    h.window.switchView('conversations');
    expect(box.classList.contains('open')).toBe(true);
    h.window.close();
  });
});