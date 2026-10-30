// 4.5, as a card instead of popout windows: the Overview lists the other open
// chats with what they are doing, so you can see and jump without a 2nd window.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { sessionRows, MAX_ROWS } from '../src/renderer/app/sessionscard.js';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const m = (over) => ({ kind: 'chat', busy: false, needsYou: false, cwd: '/work/proj', ...over });

describe('sessionRows', () => {
  it('only chats, needs-you first, then working, then most recently used', () => {
    const rows = sessionRows([
      ['a', m({})], ['b', m({ busy: true })], ['c', m({ needsYou: true })], ['d', m({})], ['t', { kind: 'pty' }],
    ], 'a', { a: 5, d: 9 });
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(rows.find((r) => r.id === 'c').status).toBe('needs you');
    expect(rows.find((r) => r.id === 'b').status).toBe('working');
    expect(rows.find((r) => r.id === 'a').active).toBe(true);
  });
  it('title falls back to the folder name', () => {
    expect(sessionRows([['a', m({ cwd: '/home/x/my-app' })]], 'z', {})[0].title).toBe('my-app');
    expect(sessionRows([['a', m({ title: 'Fix login' })]], 'z', {})[0].title).toBe('Fix login');
  });
  it('caps the list and reports how many were left out', () => {
    const many = Array.from({ length: MAX_ROWS + 3 }, (_, i) => ['id' + i, m({})]);
    const out = sessionRows(many, 'id0', {});
    expect(out.length).toBe(MAX_ROWS);
    expect(out.more).toBe(3);
  });
});

describe('sessions card in the Overview', () => {
  let h;
  beforeEach(async () => {
    h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      'git:info': { ok: true, repo: 'me/p', branch: 'main', dirty: 0, files: [] },
      'chat:context': { ok: true, usage: { totalTokens: 1, maxTokens: 100, percentage: 1 } },
      'chat:mcp': { ok: true, servers: [] },
    } });
    await flush(4);
  });
  const doc = () => h.window.document;

  it('is hidden with one chat, shown with two, and redraws when a chat needs you', async () => {
    h.window.toggleSplit(true);
    await flush(6);
    expect(doc().querySelector('[data-card="sessions"]')).toBeNull();
    h.window.__tabs.set('c2', { kind: 'chat', busy: true, needsYou: false, cwd: '/work/other', title: 'Other chat' });
    h.window.refreshSessionsCard();
    await new Promise((r) => setTimeout(r, 300));
    const card = doc().querySelector('[data-card="sessions"]');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Other chat');
    expect(card.textContent).toContain('working');
    h.window.__tabs.get('c2').needsYou = true;
    h.window.refreshSessionsCard();
    await new Promise((r) => setTimeout(r, 300));
    expect(doc().querySelector('[data-card="sessions"]').textContent).toContain('needs you');
  });
  it('a row is a real button and clicking it switches chat', async () => {
    h.window.toggleSplit(true);
    await flush(6);
    h.window.__tabs.set('c2', { kind: 'chat', busy: false, needsYou: false, cwd: '/work/other' });
    h.window.__activate = (id) => { h.window.__went = id; };
    h.window.refreshSessionsCard();
    await new Promise((r) => setTimeout(r, 300));
    const btn = [...doc().querySelectorAll('[data-card="sessions"] button.sess-row')].find((b) => b.dataset.id === 'c2');
    expect(btn).toBeTruthy();
    btn.click();
    expect(h.window.__went).toBe('c2');
  });
});
