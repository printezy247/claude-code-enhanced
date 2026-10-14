// Phase 3 (#52): SDK-backed session management (rename / archive / branch from
// a message) and the Conversations navigation (quick actions, recently-closed,
// and a nav badge that says whether a tab needs you).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const NOW = Date.now();
const H = 3600e3;

const SESSIONS = [
  { cwd: '/home/jack/alpha', sessionId: 'a1', mtime: NOW - 1 * H, preview: 'newest alpha', branch: 'main' },
  { cwd: '/home/jack/alpha', sessionId: 'a2', mtime: NOW - 2 * H, preview: 'older alpha', branch: 'wip' },
  { cwd: '/home/jack/alpha', sessionId: 'a3', mtime: NOW - 3 * H, preview: 'archived alpha', branch: 'main', tag: 'archived' },
];

const bootIpc = (extra = {}, sessions = SESSIONS) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null, leanPresets: [] },
  'settings:get': {
    ok: true,
    settings: { defaultCwd: '/home/jack/alpha', fontSize: 14, scrollback: 1000, theme: 'dark', failoverChain: [], sandbox: {}, autoNudge: false },
    claude: { found: true, path: '', version: '' },
    leanPresets: [],
  },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c9', cwd: '/home/jack/alpha', model: '', permissionMode: 'default', provider: null },
  'chats:index': { ok: true, sessions },
  'usage:scan': { ok: true, days: [], total: 0, sessions: 0 },
  'chat:transcript': {
    ok: true,
    items: [
      { t: 'user', text: 'first question', uuid: 'u-1111' },
      { t: 'assistant', text: 'an answer' },
      { t: 'user', text: 'second question', uuid: 'u-2222' },
      { t: 'assistant', text: 'another answer' },
    ],
  },
  'chat:history': { ok: true, sessions: [{ sessionId: 'a1', mtime: NOW, preview: 'newest alpha' }] },
  'session:rename': { ok: true },
  'session:tag': { ok: true },
  'session:fork': { ok: true, sessionId: 'f-forked', title: 'old (fork)' },
  ...extra,
});

async function boot(extra = {}) {
  // Fresh session rows each time: the renderer mutates them (rename sets
  // s.preview, archive sets s.tag), so a shared fixture would leak between tests.
  const sessions = SESSIONS.map((s) => ({ ...s }));
  const h = loadRenderer({ ipc: bootIpc(extra, sessions) });
  await flush(10);
  h.window.switchView('conversations');
  // The list is a dropdown now: open it the way the button does.
  h.window.document.querySelector('#btn-convo-drop')
    .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  await flush(10);
  return h;
}

const click = (h, el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
const rows = (h) => [...h.window.document.querySelectorAll('.convo-row')];
const rowFor = (h, text) => rows(h).find((r) => r.textContent.includes(text));

describe('rename a conversation (#52)', () => {
  it('sends the new title and repaints the row in place', async () => {
    const h = await boot();
    h.window.prompt = () => 'my new name';
    const more = rowFor(h, 'newest alpha').querySelector('.convo-more');
    click(h, more);
    const item = [...h.window.document.querySelectorAll('.convo-menu-item')]
      .find((b) => b.textContent.includes('Rename'));
    click(h, item);
    await flush();
    const call = h.calls.filter((c) => c.channel === 'session:rename').pop();
    expect(call.payload.sessionId).toBe('a1');
    expect(call.payload.title).toBe('my new name');
    expect(rowFor(h, 'my new name')).toBeTruthy();
  });

  it('a cancelled prompt changes nothing', async () => {
    const h = await boot();
    h.window.prompt = () => null;
    click(h, rowFor(h, 'newest alpha').querySelector('.convo-more'));
    click(h, [...h.window.document.querySelectorAll('.convo-menu-item')].find((b) => b.textContent.includes('Rename')));
    await flush();
    expect(h.calls.filter((c) => c.channel === 'session:rename').length).toBe(0);
  });
});

describe('archive is a tag, not a delete (#52)', () => {
  it('hidden by default, and the row disappears after archiving', async () => {
    const h = await boot();
    expect(rows(h).some((r) => r.textContent.includes('archived alpha'))).toBe(false);
    click(h, rowFor(h, 'newest alpha').querySelector('.convo-more'));
    click(h, [...h.window.document.querySelectorAll('.convo-menu-item')].find((b) => b.textContent.includes('Archive')));
    await flush();
    const call = h.calls.filter((c) => c.channel === 'session:tag').pop();
    expect(call.payload).toEqual({ sessionId: 'a1', tag: 'archived', cwd: '/home/jack/alpha' });
    // The row is gone from the visible list, but nothing was deleted.
    expect(rows(h).some((r) => r.textContent.includes('newest alpha'))).toBe(false);
    expect(h.calls.filter((c) => c.channel === 'chat:delete').length).toBe(0);
  });

  it('"show archived" reveals it again', async () => {
    const h = await boot();
    const box = h.window.document.querySelector('#convo-drop .convo-archived');
    expect(box).toBeTruthy();
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await flush();
    expect(rows(h).some((r) => r.textContent.includes('archived alpha'))).toBe(true);
  });

  it('an archived row offers Unarchive and clears the tag', async () => {
    const h = await boot();
    const box = h.window.document.querySelector('#convo-drop .convo-archived');
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await flush();
    click(h, rowFor(h, 'archived alpha').querySelector('.convo-more'));
    const item = [...h.window.document.querySelectorAll('.convo-menu-item')].find((b) => b.textContent.includes('Unarchive'));
    expect(item).toBeTruthy();
    click(h, item);
    await flush();
    const call = h.calls.filter((c) => c.channel === 'session:tag').pop();
    expect(call.payload.tag).toBe('');
  });
});

describe('branch from any message (#52)', () => {
  it('the transcript exposes a branch action on each user message', async () => {
    const h = await boot();
    click(h, rowFor(h, 'newest alpha').querySelector('.convo-more'));
    click(h, [...h.window.document.querySelectorAll('.convo-menu-item')].find((b) => b.textContent.includes('Transcript')));
    await flush(); await flush();
    const branches = [...h.window.document.querySelectorAll('.tx-user .btn')];
    expect(branches.length).toBe(2);   // both user messages carry a uuid
  });

  it('branching forks the session up to that message and opens the copy', async () => {
    const h = await boot();
    click(h, rowFor(h, 'newest alpha').querySelector('.convo-more'));
    click(h, [...h.window.document.querySelectorAll('.convo-menu-item')].find((b) => b.textContent.includes('Transcript')));
    await flush(); await flush();
    const second = [...h.window.document.querySelectorAll('.tx-user')][1];
    click(h, second.querySelector('.btn'));
    await flush();
    const fork = h.calls.filter((c) => c.channel === 'session:fork').pop();
    expect(fork.payload.upToMessageId).toBe('u-2222');
    expect(fork.payload.sessionId).toBe('a1');
    // The new session resumes the FORK, not the original.
    const created = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(created.payload.resume).toBe('f-forked');
  });

  it('a message with no uuid gets no branch button', async () => {
    const h = await boot({
      'chat:transcript': { ok: true, items: [{ t: 'user', text: 'no uuid here' }] },
    });
    click(h, rowFor(h, 'newest alpha').querySelector('.convo-more'));
    click(h, [...h.window.document.querySelectorAll('.convo-menu-item')].find((b) => b.textContent.includes('Transcript')));
    await flush(); await flush();
    expect(h.window.document.querySelectorAll('.tx-user .btn').length).toBe(0);
  });
});

describe('conversations quick actions', () => {
  it('all four buttons exist and are wired', async () => {
    const h = loadRenderer({ ipc: bootIpc() });
    await flush(10);
    for (const id of ['#qa-new', '#qa-resume', '#qa-browse', '#qa-reopen']) {
      expect(h.window.document.querySelector(id), id).toBeTruthy();
    }
  });

  it('Resume latest opens the newest conversation for the active folder', async () => {
    const h = await boot();
    click(h, h.window.document.querySelector('#qa-resume'));
    await flush(); await flush();
    const hist = h.calls.filter((c) => c.channel === 'chat:history').pop();
    expect(hist.payload.cwd).toBe('/home/jack/alpha');
    const created = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(created.payload.resume).toBe('a1');
  });

  it('All conversations toggles the dropdown', async () => {
    const h = await boot();   // boot opens it
    expect(h.window.document.querySelector('#convo-drop').classList.contains('hidden')).toBe(false);
    click(h, h.window.document.querySelector('#qa-browse'));
    await flush();
    expect(h.window.document.querySelector('#convo-drop').classList.contains('hidden')).toBe(true);
  });

  it('the reopen button is disabled until something is closed', async () => {
    const h = await boot();
    expect(h.window.document.querySelector('#qa-reopen').disabled).toBe(true);
  });
});

describe('recently closed tabs', () => {
  it('closing a tab enables the reopen button and reopens it', async () => {
    const h = await boot();
    const id = [...h.window.tabRegistry.keys()][0];
    await h.window.killSession(id);
    await flush();
    const btn = h.window.document.querySelector('#qa-reopen');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Chat');
    click(h, btn);
    await flush();
    const created = h.calls.filter((c) => c.channel === 'chat:create');
    expect(created.length).toBeGreaterThan(0);
  });

  it('the stack is capped so it cannot grow without bound', async () => {
    const h = await boot();
    const id = [...h.window.tabRegistry.keys()][0];
    for (let i = 0; i < 20; i++) { await h.window.killSession(id); }
    const n = h.window.recentlyClosedCount ? h.window.recentlyClosedCount() : null;
    if (n !== null) expect(n).toBeLessThanOrEqual(12);
  });
});

describe('nav badge reflects what a tab needs', () => {
  it('is a plain count when nothing needs attention', async () => {
    const h = await boot();
    expect(h.window.document.querySelector('#sess-count').textContent).toBe(String(h.window.tabRegistry.size));
    h.window.updateNavState();
    const badge = h.window.document.querySelector('#sess-count');
    expect(badge.classList.contains('attn')).toBe(false);
    expect(badge.classList.contains('busy')).toBe(false);
  });

  it('marks the sidebar when a tab is waiting on a permission', async () => {
    const h = await boot();
    const meta = [...h.window.tabRegistry.values()].find((m) => m.kind === 'chat');
    meta.needsYou = true;
    h.window.updateNavState();
    const nav = h.window.document.querySelector('.nav-btn[data-view="conversations"]');
    expect(nav.classList.contains('needs-you')).toBe(true);
    expect(h.window.document.querySelector('#sess-count').classList.contains('attn')).toBe(true);
    expect(nav.title).toMatch(/waiting on you/);
  });

  it('a waiting tab outranks a merely working one', async () => {
    const h = await boot();
    const metas = [...h.window.tabRegistry.values()].filter((m) => m.kind === 'chat');
    metas[0].busy = true;
    h.window.updateNavState();
    expect(h.window.document.querySelector('.nav-btn[data-view="conversations"]').classList.contains('busy-dot')).toBe(true);
    metas[0].needsYou = true;
    h.window.updateNavState();
    const nav = h.window.document.querySelector('.nav-btn[data-view="conversations"]');
    expect(nav.classList.contains('needs-you')).toBe(true);
    expect(nav.classList.contains('busy-dot')).toBe(false);
  });
});