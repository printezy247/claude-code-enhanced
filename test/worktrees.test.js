// Per-chat git worktrees — helper contract only (git and fs are faked). #feat-worktree
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const worktrees = require('../src/main/worktrees.js');

const memFs = () => ({ calls: 0, mkdirSync(p, o) { this.calls++; } });

describe('worktrees.add (#feat-worktree)', () => {
  it('creates the worktree under .claude/worktrees on a cce/<stamp> branch', () => {
    const calls = [];
    const fs = memFs();
    const run = (args) => { calls.push(args); return args[0] === 'rev-parse' ? '/repo/project\n' : ''; };
    const r = worktrees.add('/repo/project', { run, fs, stamp: '20261019050000' });
    expect(r.error).toBeUndefined();
    expect(r.branch).toBe('cce/20261019050000');
    expect(r.path).toBe(path.join('/repo/project', '.claude', 'worktrees', 'cce-20261019050000'));
    expect(fs.calls).toBe(1);
    const add = calls.find(c => c[0] === 'worktree');
    expect(add).toEqual(['worktree', 'add', r.path, '-b', r.branch]);
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
