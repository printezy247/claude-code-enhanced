// @vitest-environment jsdom
// Artifact history: versions of one title, a line diff between them, export to a file.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { versionsOf, lineDiff, exportName } from '../src/renderer/app/artifacthistory.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');
const id = (c) => c.repeat(64);

describe('versionsOf', () => {
  const items = [
    { id: id('a'), title: 'Plan', kind: 'markdown', at: 3 },
    { id: id('b'), title: 'Plan', kind: 'markdown', at: 1 },
    { id: id('c'), title: 'Plan', kind: 'code', at: 2 },
    { id: id('d'), title: 'Other', kind: 'markdown', at: 4 },
  ];
  it('lists same title and kind, newest first', () => {
    expect(versionsOf(items, items[0]).map((v) => v.id[0])).toEqual(['a', 'b']);
  });
});

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
      { t: 'same', s: 'a' }, { t: 'del', s: 'b' }, { t: 'same', s: 'c' }, { t: 'add', s: 'd' },
    ]);
  });
  it('gives up on huge texts instead of freezing', () => {
    const big = Array.from({ length: 2000 }, (_, i) => 'l' + i).join('\n');
    expect(lineDiff(big, big + '\nx')).toBeNull();
  });
});

describe('exportName', () => {
  it('is a safe file name with the right extension', () => {
    expect(exportName({ title: 'My plan / v2', kind: 'markdown' })).toBe('My_plan_v2.md');
    expect(exportName({ title: '', kind: 'code' })).toBe('artifact.txt');
  });
});

describe('Artifacts tab', () => {
  const open = async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'artifact:list': { ok: true, artifacts: [
        { id: id('a'), title: 'Plan', kind: 'markdown', at: 2000, bytes: 9, preview: '' },
        { id: id('b'), title: 'Plan', kind: 'markdown', at: 1000, bytes: 9, preview: '' },
      ] },
      'artifact:get': (p) => ({ ok: true, id: p.id, title: 'Plan', kind: 'markdown', content: p.id[0] === 'a' ? 'one\ntwo NEW' : 'one\ntwo' }),
      'artifact:export': { ok: true, path: '/tmp/Plan.md' },
    } });
    await flush(4);
    return h;
  };
  it('shows the other versions and a diff against this one', async () => {
    const h = await open();
    const w = h.window;
    w.openSplitTab('artifacts');
    await flush(4);
    const row = w.document.querySelector('.artifact-row');
    row.click();
    await flush(4);
    const sel = w.document.querySelector('.artifact-versions');
    expect(sel).toBeTruthy();
    expect(sel.options.length).toBe(2);
    sel.value = id('b');
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await flush(4);
    const diff = w.document.querySelector('.artifact-diff');
    expect(diff.querySelector('.d-add').textContent).toContain('two NEW');
    expect(diff.querySelector('.d-del').textContent).toContain('two');
  });
  it('exports the shown version to a file', async () => {
    const h = await open();
    const w = h.window;
    w.openSplitTab('artifacts');
    await flush(4);
    w.document.querySelector('.artifact-row').click();
    await flush(4);
    w.document.querySelector('.artifact-export').click();
    await flush(4);
    const call = h.calls.filter((c) => c.channel === 'artifact:export').pop();
    expect(call.payload).toMatchObject({ id: id('a') });
  });
});
