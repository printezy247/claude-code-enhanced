// 0.27.0: memory timeline, token costs, #mem-N citations, and private text.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const M = require('../src/shared/memtimeline.js');
const auto = require('../src/main/automemory.js');
const read = (p) => readFileSync(path.join(__dirname, '..', p), 'utf8');

const INDEX = [
  '- [Npm ops](cce-npm-ops.md) — build the deb myself',
  'not an entry',
  '- [Flake](flake.md) — run vitest with the var unset',
  '- [Gone](gone.md)',
].join('\n');
const NOTE = (type, body) => '---\nname: x\ndescription: "d"\nmetadata:\n  type: ' + type + '\n---\n\n' + body + '\n';

describe('timeline parsing', () => {
  it('numbers index lines from 1 and keeps title, file and hook', () => {
    expect(M.parseIndex(INDEX)).toEqual([
      { n: 1, title: 'Npm ops', file: 'cce-npm-ops.md', hook: 'build the deb myself' },
      { n: 2, title: 'Flake', file: 'flake.md', hook: 'run vitest with the var unset' },
      { n: 3, title: 'Gone', file: 'gone.md', hook: '' },
    ]);
  });
  it('reads front matter and body', () => {
    expect(M.parseNote(NOTE('feedback', 'Body text'))).toMatchObject({ type: 'feedback', description: 'd', body: 'Body text' });
    expect(M.parseNote('plain').type).toBe('project');
  });
  it('builds entries with type, token cost and a missing flag', () => {
    const t = M.buildTimeline(INDEX, { 'cce-npm-ops.md': NOTE('feedback', 'abc'), 'flake.md': NOTE('project', 'x'.repeat(400)) });
    expect(t[0]).toMatchObject({ n: 1, type: 'feedback', missing: false });
    expect(t[1].tokens).toBeGreaterThan(100);
    expect(t[2]).toMatchObject({ missing: true, chars: 0 });
  });
  it('filters by type and by every search word', () => {
    const t = M.buildTimeline(INDEX, { 'cce-npm-ops.md': NOTE('feedback', 'deb build'), 'flake.md': NOTE('project', 'vitest env') });
    expect(M.filterEntries(t, { type: 'feedback' }).map((e) => e.n)).toEqual([1]);
    expect(M.filterEntries(t, { q: 'vitest unset' }).map((e) => e.n)).toEqual([2]);
    expect(M.filterEntries(t, { type: 'all', q: '' })).toHaveLength(3);
    expect(M.typeCounts(t)).toMatchObject({ all: 3, feedback: 1, project: 2 });
  });
});

describe('private text', () => {
  it('is wrapped, detected and stripped', () => {
    const w = M.markPrivate('my key is 123');
    expect(w).toBe('<private>my key is 123</private>');
    expect(M.hasPrivate('a ' + w)).toBe(true);
    expect(M.stripPrivate('keep <private>secret</private> this')).toBe('keep  this');
  });
  it('the memory probe is told to skip it and drops proposals that repeat it', () => {
    expect(auto.PROBE_PROMPT).toMatch(/<private>/);
    const reply = JSON.stringify([
      { name: 'ok-note', type: 'project', description: 'fine', body: 'a fact' },
      { name: 'leak', type: 'project', description: 'bad', body: 'the <private>token</private> is x' },
    ]);
    expect(auto.parseProposals(reply).map((p) => p.slug)).toEqual(['ok-note']);
  });
  it('/private sends the text wrapped', () => {
    expect(read('src/renderer/chat/slash.js')).toMatch(/cmd === '\/private'/);
    expect(read('src/renderer/chat/slash.js')).toMatch(/markPrivate\(msg\)/);
  });
});

describe('citations', () => {
  it('finds #mem-N but not inside words or other tags', () => {
    expect(M.findCitations('see #mem-3 and (#mem-12).').map((c) => c.n)).toEqual([3, 12]);
    expect(M.findCitations('abc#mem-4').length).toBe(0);
    expect(M.findCitations('#mem-x')).toEqual([]);
    const c = M.findCitations('x #mem-7')[0];
    expect('x #mem-7'.slice(c.index, c.index + c.length)).toBe('#mem-7');
  });
  it('replies link them through enhanceMarkdown', () => {
    expect(read('src/renderer/chat/markdown.js')).toMatch(/linkMemoryCitations\(container\)/);
    expect(read('src/renderer/chat/panel-memory.js')).toMatch(/export function linkMemoryCitations/);
  });
});

describe('main: reading a real memory folder', () => {
  it('timeline() reads MEMORY.md and the notes it names, and ignores paths that escape', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'cce-mem-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const cwd = '/work/proj';
      const dir = auto.memDir(cwd);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'MEMORY.md'), '- [A](a.md) — first\n- [Evil](../../x.md) — no\n');
      writeFileSync(path.join(dir, 'a.md'), NOTE('user', 'hello'));
      const t = auto.timeline(cwd);
      expect(t.find((e) => e.file === 'a.md')).toMatchObject({ n: 1, type: 'user', body: 'hello', missing: false });
      expect(t.find((e) => e.title === 'Evil').missing).toBe(true);
    } finally { process.env.HOME = prev; }
  });
  it('is exposed over IPC', () => {
    expect(read('src/main/main.js')).toMatch(/handle\('memory:timeline'/);
    expect(read('src/preload/preload.js')).toMatch(/'memory:timeline'/);
  });
});

describe('the panel', () => {
  it('shows what loads at start with token cost, a preview, and a filterable list', () => {
    const src = read('src/renderer/chat/panel-memory.js');
    expect(src).toMatch(/Loaded at session start/);
    expect(src).toMatch(/Preview what Claude sees/);
    expect(src).toMatch(/filterEntries\(entries/);
    expect(src).toMatch(/panel\._focusNote/);
  });
});
