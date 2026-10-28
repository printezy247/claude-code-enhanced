// Chat upgrade, phase 1 (0.9.90): "/" and "@" menus with a preview.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cm = await import('../src/renderer/chat/cmdmatch.js');
const { commandDetail, resolveCommandFile } = require('../src/main/cmddetail.js');

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

describe('fuzzy matching', () => {
  it('ranks prefix above word start above substring above loose', () => {
    const p = cm.fuzzyScore('pla', 'plan').score;
    const w = cm.fuzzyScore('pla', 'ecc:plan').score;
    const s = cm.fuzzyScore('lan', 'plan').score;
    const l = cm.fuzzyScore('pn', 'plan').score;
    expect(p).toBeGreaterThan(w);
    expect(w).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(l);
    expect(l).toBeGreaterThan(0);
  });
  it('matches a description last and rejects the rest', () => {
    expect(cm.fuzzyScore('refactor', 'clean', 'Refactor code').score).toBe(100);
    expect(cm.fuzzyScore('zzz', 'plan', 'x').score).toBe(-1);
  });
  it('gives the matched letters to highlight', () => {
    const { indices } = cm.fuzzyScore('lan', 'plan');
    expect(cm.highlightParts('plan', indices)).toEqual([{ text: 'p', hit: false }, { text: 'lan', hit: true }]);
  });
});

describe('sections and recent', () => {
  const all = [
    { name: 'compact', own: true }, { name: 'review' }, { name: 'ecc:plan' }, { name: 'mcp__x:go' },
  ];
  it('puts recent first with an empty query, then sections in order', () => {
    const rows = cm.rankCommands(all, '', ['review']);
    expect(rows[0]).toMatchObject({ section: 'Recent' });
    expect(rows[0].c.name).toBe('review');
    expect(rows.slice(1).map((r) => r.section)).toEqual(['Built-in', 'Plugins', 'MCP']);
  });
  it('does not cap the list at 24', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: 'cmd' + i }));
    expect(cm.rankCommands(many, '').length).toBe(1000);
  });
  it('keeps the last 20 recents, newest first, no duplicates', () => {
    const st = mem();
    for (let i = 0; i < 25; i++) cm.pushRecent(st, 'k', 'c' + i);
    cm.pushRecent(st, 'k', 'c10');
    const r = cm.loadRecent(st, 'k');
    expect(r.length).toBe(20);
    expect(r[0]).toBe('c10');
    expect(new Set(r).size).toBe(20);
  });
  it('survives corrupt storage', () => {
    const st = mem(); st.setItem('k', '{not json');
    expect(cm.loadRecent(st, 'k')).toEqual([]);
  });
  it('filters and ranks 1000 commands inside a frame budget', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: 'skill-' + i, description: 'does thing ' + i }));
    const t0 = performance.now();
    cm.rankCommands(many, 'sk1');
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('slash anywhere', () => {
  it('finds a token after a space or at the start, not inside a path', () => {
    expect(cm.slashTokenAt('/pl', 3)).toMatchObject({ start: 0, query: 'pl' });
    expect(cm.slashTokenAt('run /re', 7)).toMatchObject({ start: 4, query: 're' });
    expect(cm.slashTokenAt('see src/re', 10)).toBe(null);
  });
  it('replaces only the token', () => {
    const t = cm.slashTokenAt('fix this /re', 12);
    expect(cm.applySlashToken('fix this /re', t, 'review')).toEqual({ value: 'fix this /review ', caret: 17 });
  });
});

describe('windowing and folders', () => {
  it('draws only visible rows plus overscan', () => {
    expect(cm.windowRange(1000, 30, 3000, 300, 2)).toEqual({ first: 98, last: 112 });
    expect(cm.windowRange(5, 30, 0, 300)).toEqual({ first: 0, last: 5 });
  });
  it('lists the direct entries of a folder', () => {
    expect(cm.folderEntries(['src/a.js', 'src/b/c.js', 'src/b/d.js', 'x.js'], 'src')).toEqual(['a.js', 'b/']);
  });
  it('cuts previews at n lines', () => {
    expect(cm.headLines('a\nb\nc', 2)).toEqual({ text: 'a\nb', cut: true });
  });
});

describe('command detail loader', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-cd-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-cdp-'));
  fs.mkdirSync(path.join(proj, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\nargument-hint: <branch>\n---\nline1\nline2\n');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'tidy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\n---\n' + Array.from({ length: 50 }, (_, i) => 'row' + i).join('\n'));
  fs.mkdirSync(path.join(home, '.claude', 'plugins', 'cache', 'acme', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'cache', 'acme', 'commands', 'go.md'), 'plugin body');

  it('reads a project command and strips frontmatter', () => {
    const d = commandDetail({ name: 'ship', cwd: proj, home });
    expect(d).toMatchObject({ found: true, description: 'Ship it', argumentHint: '<branch>' });
    expect(d.preview).toBe('line1\nline2\n');
  });
  it('caps a long skill at 30 lines', () => {
    const d = commandDetail({ name: 'tidy', cwd: proj, home });
    expect(d.preview.split('\n').length).toBe(30);
    expect(d.cut).toBe(true);
  });
  it('finds a plugin command by its prefix', () => {
    expect(commandDetail({ name: 'acme:go', cwd: proj, home })).toMatchObject({ found: true, preview: 'plugin body' });
  });
  it('refuses ".." hidden inside a colon name and symlinks that lead out', () => {
    fs.writeFileSync(path.join(home, 'secret.md'), 'secret');
    for (const n of ['..:..:secret', 'a:..:..:secret', '.hidden', 'a::b']) {
      expect(resolveCommandFile(n, proj, home)).toBe('');
    }
    fs.symlinkSync(path.join(home, 'secret.md'), path.join(proj, '.claude', 'commands', 'leak.md'));
    expect(commandDetail({ name: 'leak', cwd: proj, home }).found).toBe(false);
  });
  it('refuses names that could point outside the allowed folders', () => {
    for (const n of ['../../etc/passwd', '/etc/passwd', 'a/b', 'x\0y', '']) {
      expect(resolveCommandFile(n, proj, home)).toBe('');
    }
    expect(commandDetail({ name: '../../etc/passwd', cwd: proj, home }).found).toBe(false);
  });
});

describe('wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  it('preload allows cmd:detail and main handles it', () => {
    expect(read('src/preload/preload.js')).toContain("'cmd:detail'");
    expect(read('src/main/main.js')).toContain("handle('cmd:detail'");
  });
  it('the preview is drawn with textContent only', () => {
    const src = read('src/renderer/chat/preview.js') + read('src/renderer/chat/slash.js');
    expect(src).not.toMatch(/innerHTML\s*=\s*(?!'')/);
    expect(read('src/renderer/chat/preview.js')).toContain('textContent');
  });
});
