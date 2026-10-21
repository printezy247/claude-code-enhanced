// Auto-memory proposals: the model suggests lasting facts after a chat, Jack
// approves each one, and only then does it reach MEMORY.md.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const am = require('../src/main/automemory.js');

let home;
const cwd = '/home/jack/Documents/Default Project/claude-code-enhanced';
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'cce-am-'));
  process.env.HOME = home;
});

const item = (over = {}) => ({ name: 'keep-version', type: 'feedback', description: 'Do not bump the version', body: 'Stay on 0.9.33.\n\n**Why:** asked.\n\n**How to apply:** leave package.json.', ...over });

describe('memory folder', () => {
  it('is keyed like the engine keys projects: every non-alphanumeric becomes a dash', () => {
    expect(am.memDir(cwd)).toBe(path.join(home, '.claude', 'projects', '-home-jack-Documents-Default-Project-claude-code-enhanced', 'memory'));
  });
});

describe('parseProposals', () => {
  it('reads a bare JSON array', () => {
    const r = am.parseProposals(JSON.stringify([item()]));
    expect(r).toHaveLength(1);
    expect(r[0].slug).toBe('keep-version');
  });
  it('finds the array inside prose and a code fence', () => {
    const r = am.parseProposals('Here you go:\n```json\n' + JSON.stringify([item()]) + '\n```\nDone.');
    expect(r).toHaveLength(1);
  });
  it('returns [] for nothing, junk, or an empty array', () => {
    expect(am.parseProposals('')).toEqual([]);
    expect(am.parseProposals('no json here')).toEqual([]);
    expect(am.parseProposals('[]')).toEqual([]);
    expect(am.parseProposals('[{"name":1}]')).toEqual([]);
  });
  it('keeps at most 3, cleans the slug, falls back to type project', () => {
    const many = [1, 2, 3, 4].map((n) => item({ name: '../Evil Name ' + n, type: 'nonsense' }));
    const r = am.parseProposals(JSON.stringify(many));
    expect(r).toHaveLength(3);
    expect(r[0].slug).toMatch(/^[a-z0-9-]+$/);
    expect(r[0].slug).not.toContain('..');
    expect(r[0].type).toBe('project');
  });
});

describe('pending → accept / reject', () => {
  it('stores proposals out of sight of the engine, then accept writes the note and the index line', () => {
    expect(am.addPending(cwd, am.parseProposals(JSON.stringify([item()])))).toBe(1);
    expect(am.listPending(cwd).map((p) => p.slug)).toEqual(['keep-version']);
    expect(existsSync(path.join(am.memDir(cwd), 'keep-version.md'))).toBe(false);   // nothing written yet

    const r = am.resolve(cwd, 'keep-version', true);
    expect(r.saved).toBe(true);
    const note = readFileSync(path.join(am.memDir(cwd), 'keep-version.md'), 'utf8');
    expect(note).toContain('name: keep-version');
    expect(note).toContain('type: feedback');
    expect(note).toContain('Stay on 0.9.33.');
    const index = readFileSync(path.join(am.memDir(cwd), 'MEMORY.md'), 'utf8');
    expect(index).toContain('(keep-version.md)');
    expect(index).toContain('Do not bump the version');
    expect(am.listPending(cwd)).toEqual([]);
  });

  it('reject drops it and writes nothing', () => {
    am.addPending(cwd, am.parseProposals(JSON.stringify([item()])));
    expect(am.resolve(cwd, 'keep-version', false).saved).toBe(false);
    expect(am.listPending(cwd)).toEqual([]);
    expect(existsSync(path.join(am.memDir(cwd), 'keep-version.md'))).toBe(false);
  });

  it('does not duplicate a note that already exists, nor re-queue it', () => {
    am.addPending(cwd, am.parseProposals(JSON.stringify([item()])));
    am.resolve(cwd, 'keep-version', true);
    expect(am.addPending(cwd, am.parseProposals(JSON.stringify([item()])))).toBe(0);   // already saved
    expect(readFileSync(path.join(am.memDir(cwd), 'MEMORY.md'), 'utf8').match(/keep-version\.md/g)).toHaveLength(1);
  });

  it('appends to an existing index without touching its lines', () => {
    const dir = am.memDir(cwd);
    require('node:fs').mkdirSync(dir, { recursive: true });
    require('node:fs').writeFileSync(path.join(dir, 'MEMORY.md'), '- [Old](old.md) — kept\n');
    am.addPending(cwd, am.parseProposals(JSON.stringify([item()])));
    am.resolve(cwd, 'keep-version', true);
    const index = readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    expect(index.startsWith('- [Old](old.md) — kept\n')).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.md')).sort()).toEqual(['MEMORY.md', 'keep-version.md']);
  });
});
