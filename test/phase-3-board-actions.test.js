// Phase 3 (UI 21): quick actions on live chat rows in the Board.
import { describe, it, expect } from 'vitest';
import { boardActions } from '../src/renderer/app/boardactions.js';

describe('boardActions', () => {
  it('always offers Jump', () => {
    expect(boardActions({}).map((a) => a.id)).toEqual(['jump']);
  });
  it('offers Stop only while busy', () => {
    expect(boardActions({ busy: true }).map((a) => a.id)).toContain('stop');
    expect(boardActions({ busy: false }).map((a) => a.id)).not.toContain('stop');
  });
  it('offers Compact from 65% context', () => {
    expect(boardActions({ ctxUsage: { percentage: 64 } }).map((a) => a.id)).not.toContain('compact');
    expect(boardActions({ ctxUsage: { percentage: 65 } }).map((a) => a.id)).toContain('compact');
  });
  it('offers Allow and Deny when a permission waits', () => {
    const ids = boardActions({ permCount: 1 }).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['allow', 'deny']));
    expect(boardActions({ permCount: 0 }).map((a) => a.id)).not.toContain('allow');
  });
  it('puts the permission answer first', () => {
    expect(boardActions({ permCount: 2, busy: true })[0].id).toBe('allow');
  });
});

import { createRequire } from 'node:module';
const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

describe('Board rows', () => {
  it('show the actions for a live chat', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'chats:board': { ok: true, rows: [{ id: 'c1', cwd: '/work/proj', busy: true, needsYou: 0, model: 'm' }] },
      'jobs:list': { ok: true, jobs: [] }, 'runs:interrupted': { ok: true, runs: [] },
      'engines:list': { ok: true, engines: [] },
    } });
    await flush(4);
    h.window.Chat.chats.get('c1').busy = true;
    h.window.switchView('board');
    await flush(8);
    const ids = [...h.window.document.querySelectorAll('#board-chats [data-action]')].map((b) => b.dataset.action);
    expect(ids).toEqual(expect.arrayContaining(['jump', 'stop']));
  });
});

describe('Overview Changes rows', () => {
  it('click opens Review on that file, shift adds @file, alt reveals', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 2, files: ['a.js', 'b.js'] },
      'git:diff-stats': { ok: true, files: [{ file: 'a.js', add: 1, del: 0 }, { file: 'b.js', add: 2, del: 1 }], insertions: 3, deletions: 1 },
      'git:diff': { ok: true, patch: '@@ patch @@' },
      'shell:reveal': { ok: true },
    } });
    await flush(4);
    const w = h.window;
    w.renderOverview();
    await flush(6);
    const rows = () => [...w.document.querySelectorAll('#overview-body [data-card="changes"] .task-row')];
    const row = rows().find((r) => r.textContent === 'b.js');
    row.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(6);
    expect(w.document.querySelector('#split-kind').value).toBe('review');
    expect(h.calls.filter((c) => c.channel === 'git:diff').pop().payload.paths).toEqual(['b.js']);
    const chat = w.Chat.chats.get('c1');
    rows().find((r) => r.textContent === 'a.js').dispatchEvent(new w.MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(chat.composer.value).toContain('@a.js');
    rows().find((r) => r.textContent === 'a.js').dispatchEvent(new w.MouseEvent('click', { bubbles: true, altKey: true }));
    expect(h.calls.some((c) => c.channel === 'shell:reveal')).toBe(true);
  });
});
