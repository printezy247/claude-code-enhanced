// Per-chat git worktrees — helper contract only (git and fs are faked). #feat-worktree
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const worktrees = require('../src/main/worktrees.js');

const memFs = (existing = []) => ({
  calls: 0,
  files: {},
  dirs: new Set(existing),
  mkdirSync() { this.calls++; },
  existsSync(p) { return p in this.files || this.dirs.has(p); },
  readFileSync(p) { return this.files[p] || ''; },
  appendFileSync(p, s) { this.files[p] = (this.files[p] || '') + s; },
});
const fakeGit = (top, calls = []) => (args) => {
  calls.push(args);
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return top + '\n';
  if (args[0] === 'rev-parse' && args[1] === '--git-path') return '.git/info/exclude\n';
  return '';
};

describe('worktrees.add (#feat-worktree)', () => {
  it('creates the worktree under .claude/worktrees on a cce/<stamp> branch', () => {
    const calls = [];
    const fs = memFs();
    const r = worktrees.add('/repo/project', { run: fakeGit('/repo/project', calls), fs, stamp: '20261019050000' });
    expect(r.error).toBeUndefined();
    expect(r.branch).toBe('cce/20261019050000');
    expect(r.path).toBe(path.join('/repo/project', '.claude', 'worktrees', 'cce-20261019050000'));
    expect(fs.calls).toBeGreaterThanOrEqual(1);
    const add = calls.find(c => c[0] === 'worktree');
    expect(add).toEqual(['worktree', 'add', r.path, '-b', r.branch]);
  });

  it('keeps the worktrees folder out of the repo\'s git status, once', () => {
    const fs = memFs();
    worktrees.add('/repo', { run: fakeGit('/repo'), fs, stamp: 'a' });
    worktrees.add('/repo', { run: fakeGit('/repo'), fs, stamp: 'b' });
    expect(fs.files[path.join('/repo', '.git/info/exclude')]).toBe('/.claude/worktrees/\n');
  });

  it('two chats started in the same second get different branches', () => {
    const a = worktrees.add('/repo', { run: fakeGit('/repo'), fs: memFs() });
    const b = worktrees.add('/repo', { run: fakeGit('/repo'), fs: memFs() });
    expect(a.branch).not.toBe(b.branch);
  });

  it('a chat started in a subfolder runs in the same subfolder of the worktree', () => {
    const wt = path.join('/repo', '.claude', 'worktrees', 'cce-s');
    const r = worktrees.add('/repo/app/web', { run: fakeGit('/repo'), fs: memFs([path.join(wt, 'app/web')]), stamp: 's' });
    expect(r.path).toBe(path.join(wt, 'app/web'));
    expect(r.root).toBe(wt);
  });

  it('remove() drops the worktree and its branch', () => {
    const calls = [];
    worktrees.remove({ root: '/repo/.claude/worktrees/cce-x', top: '/repo', branch: 'cce/x' }, { run: (a) => { calls.push(a); return ''; } });
    expect(calls).toEqual([
      ['worktree', 'remove', '--force', '/repo/.claude/worktrees/cce-x'],
      ['branch', '-D', 'cce/x'],
    ]);
  });

  it('reports not-a-repo when rev-parse fails', () => {
    const run = (args) => { if (args[0] === 'rev-parse') throw new Error('fatal: not a git repository'); return ''; };
    expect(worktrees.add('/tmp/random', { run, fs: memFs() }).error).toMatch(/not a git repository/);
  });

  it('surfaces git worktree add failures with the git message', () => {
    const run = (args) => {
      if (args[0] === 'rev-parse') return '/repo\n';
      const e = new Error('boom'); e.stderr = Buffer.from('fatal: already registered');
      throw e;
    };
    const r = worktrees.add('/repo', { run, fs: memFs() });
    expect(r.error).toMatch(/worktree add failed/);
    expect(r.error).toMatch(/already registered/);
  });

  it('needs a folder', () => {
    expect(worktrees.add('', { run: () => '', fs: memFs() }).error).toBe('no folder');
  });
});
