// Phase 3 navigation: Ctrl+1..9 tabs, Alt+1..6 split tabs, most-recently-used
// Ctrl+Tab order, and the palette prefixes.
import { describe, it, expect } from 'vitest';
import { chordAction, mruCycle, SPLIT_KINDS, paletteMode } from '../src/renderer/app/nav.js';

const key = (k, o = {}) => ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });

describe('chordAction', () => {
  it('Ctrl+N picks the Nth tab, Ctrl+9 the last', () => {
    expect(chordAction(key('1', { ctrlKey: true }), 3)).toEqual({ tab: 0 });
    expect(chordAction(key('3', { ctrlKey: true }), 3)).toEqual({ tab: 2 });
    expect(chordAction(key('9', { ctrlKey: true }), 3)).toEqual({ tab: 2 });
  });
  it('a tab that is not open does nothing', () => {
    expect(chordAction(key('5', { ctrlKey: true }), 3)).toBe(null);
    expect(chordAction(key('1', { ctrlKey: true }), 0)).toBe(null);
  });
  it('Alt+1..6 opens the split tabs in order', () => {
    expect(SPLIT_KINDS).toEqual(['changes', 'files', 'terminal', 'diff', 'review', 'preview', 'artifacts']);
    expect(chordAction(key('1', { altKey: true }), 2)).toEqual({ split: 'changes' });
    expect(chordAction(key('6', { altKey: true }), 2)).toEqual({ split: 'preview' });
    expect(chordAction(key('7', { altKey: true }), 2)).toEqual({ split: 'artifacts' });
    expect(chordAction(key('8', { altKey: true }), 2)).toBe(null);
  });
  it('other combinations are left alone', () => {
    expect(chordAction(key('1'), 3)).toBe(null);
    expect(chordAction(key('1', { ctrlKey: true, shiftKey: true }), 3)).toBe(null);
    expect(chordAction(key('1', { ctrlKey: true, altKey: true }), 3)).toBe(null);
    expect(chordAction(key('a', { ctrlKey: true }), 3)).toBe(null);
  });
});

describe('mruCycle', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const at = { a: 10, b: 40, c: 30, d: 20 };
  it('goes to the most recently used other tab first', () => {
    expect(mruCycle(ids, at, 'a', false)).toBe('b');
  });
  it('goes the other way with shift', () => {
    expect(mruCycle(ids, at, 'a', true)).toBe('d');
  });
  it('a tab never used counts as oldest', () => {
    expect(mruCycle(['a', 'b', 'c'], { a: 5 }, 'a', true)).toBe('c');
  });
  it('one tab, or none, stays put', () => {
    expect(mruCycle(['a'], {}, 'a', false)).toBe('a');
    expect(mruCycle([], {}, 'x', false)).toBe(null);
  });
});

describe('paletteMode', () => {
  it.each([
    ['>deploy', { mode: 'commands', q: 'deploy' }],
    ['@main', { mode: 'files', q: 'main' }],
    ['#fix', { mode: 'chats', q: 'fix' }],
    [':opus', { mode: 'models', q: 'opus' }],
    ['plain', { mode: 'all', q: 'plain' }],
    ['', { mode: 'all', q: '' }],
  ])('%s', (input, out) => expect(paletteMode(input)).toEqual(out));
});

import { createRequire } from 'node:module';
const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

describe('chords in the app', () => {
  it('Alt+5 opens the split pane on Review and Alt+2 on Files', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 0, files: [] },
    } });
    await flush(4);
    const w = h.window;
    const press = (key, o) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o }));
    press('5', { altKey: true });
    expect(w.document.querySelector('#split-kind').value).toBe('review');
    expect(w.document.querySelector('#main').classList.contains('split')).toBe(true);
    press('2', { altKey: true });
    expect(w.document.querySelector('#split-kind').value).toBe('files');
    press('1', { ctrlKey: true });
    expect(w.state.activeId).toBe('c1');
  });
});

import fs from 'node:fs';
const css = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

describe('overview polling guard', () => {
  const mk = () => loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 0, files: [] },
    'chat:context': { ok: true, usage: { totalTokens: 1, maxTokens: 10, percentage: 10 } },
  } });
  const gitCalls = (h) => h.calls.filter((c) => c.channel === 'git:info').length;

  it('asks nothing while another view is open, and catches up on return', async () => {
    const h = mk();
    await flush(4);
    h.window.switchView('usage');
    await flush(2);
    const before = gitCalls(h);
    h.window.renderOverview();
    await flush(4);
    expect(gitCalls(h)).toBe(before);
    h.window.switchView('conversations');
    await flush(6);
    expect(gitCalls(h)).toBeGreaterThan(before);
  });
  it('asks nothing while the Overview is hidden', async () => {
    const h = mk();
    await flush(4);
    h.window.toggleOverview(false);
    await flush(2);
    const before = gitCalls(h);
    h.window.renderOverview();
    await flush(4);
    expect(gitCalls(h)).toBe(before);
    h.window.toggleOverview(true);
    await flush(6);
    expect(gitCalls(h)).toBeGreaterThan(before);
  });
});

describe('flat styles', () => {
  it('Overview cards have no heavy shadow', () => {
    const m = css.match(/#overview-body \.task-card \{[^}]*\}/g).join('\n');
    expect(m).not.toMatch(/box-shadow:\s*0 8px 22px/);
  });
  it('conversation rows skip off-screen work', () => {
    expect(css).toMatch(/\.convo-row[^{]*\{[^}]*content-visibility:\s*auto/);
  });
  it('system notes are compact pills', () => {
    expect(css).toMatch(/\.sys-note\s*\{[^}]*border-radius:\s*999px/);
  });
  it('the request rail shows with the sidebar open too', () => {
    expect(css).not.toMatch(/body\.sb-hidden \.req-rail:not\(\.empty\)/);
    expect(css).toMatch(/\.req-tick\.tick-err/);
  });
});

import { paletteKinds } from '../src/renderer/app/nav.js';
describe('paletteKinds', () => {
  it('maps each prefix to the entries it lists', () => {
    expect(paletteKinds('commands')).toContain('command');
    expect(paletteKinds('chats')).toEqual(['session', 'open']);
    expect(paletteKinds('models')).toEqual(['model']);
    expect(paletteKinds('all')).toBe(null);
    expect(paletteKinds('files')).toBe(null);
  });
});

describe('palette from any view', () => {
  it('Ctrl+K opens it on the Usage view, and # lists only conversations', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'chats:index': { ok: true, sessions: [{ sessionId: 's1', cwd: '/w', preview: 'fix the login', mtime: 1 }] },
    } });
    await flush(4);
    const w = h.window;
    w.switchView('usage');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush(4);
    const input = w.document.querySelector('.palette input');
    expect(input).toBeTruthy();
    input.value = '#';
    input.dispatchEvent(new w.Event('input'));
    const kinds = [...w.document.querySelectorAll('.palette-item .pi-kind')].map((k) => k.textContent);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === 'session' || k === 'open')).toBe(true);
  });
});

describe('composer', () => {
  it('has a short placeholder', () => {
    const src = fs.readFileSync(new URL('../src/renderer/chat/session.js', import.meta.url), 'utf8');
    expect(src).toContain('placeholder="Message… (@ files · / commands)"');
  });
});
