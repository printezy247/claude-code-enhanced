// Worktree isolation, checked with real git: tracked files (lockfiles) are
// separate copies per chat, untracked dependency and build folders are not
// shared, the main checkout's `git status` stays clean, and branch names do not
// collide when chats start together. #feat-worktree
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const worktrees = require('../src/main/worktrees.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-wt-'));
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* tmp */ } });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString().trim();

function repo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'app', 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lock":1}\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');
  fs.writeFileSync(path.join(dir, 'app', 'src', 'a.js'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('worktree isolation (real git)', () => {
  it('a lockfile edited in one worktree changes neither the main checkout nor another worktree', () => {
    const dir = repo('lock');
    const a = worktrees.add(dir);
    const b = worktrees.add(dir);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    fs.writeFileSync(path.join(a.path, 'package-lock.json'), '{"lock":2}\n');
    expect(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).toBe('{"lock":1}\n');
    expect(fs.readFileSync(path.join(b.path, 'package-lock.json'), 'utf8')).toBe('{"lock":1}\n');
    expect(fs.statSync(path.join(a.path, 'package-lock.json')).ino).not.toBe(fs.statSync(path.join(dir, 'package-lock.json')).ino);
  });

  it('dependency and build folders are not shared, and the project is told what to reinstall', () => {
    const dir = repo('deps');
    fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'x');
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'out.js'), 'built');
    const wt = worktrees.add(dir);
    expect(fs.existsSync(path.join(wt.root, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(wt.root, 'dist'))).toBe(false);
    expect(wt.needsInstall).toEqual(['node_modules']);
    // an install in the worktree stays in the worktree
    fs.mkdirSync(path.join(wt.root, 'node_modules', 'other'), { recursive: true });
    expect(fs.existsSync(path.join(dir, 'node_modules', 'other'))).toBe(false);
    // and a project without dependency folders gets no hint
    expect(worktrees.add(repo('plain')).needsInstall).toEqual([]);
  });

  it('the main checkout stays clean while worktrees live inside it', () => {
    const dir = repo('clean');
    const wt = worktrees.add(dir);
    fs.writeFileSync(path.join(wt.path, 'new.txt'), 'x');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('chats started together get different branches and folders', () => {
    const dir = repo('many');
    const list = Array.from({ length: 6 }, () => worktrees.add(dir));
    expect(list.every((w) => !w.error)).toBe(true);
    expect(new Set(list.map((w) => w.branch)).size).toBe(6);
    expect(new Set(list.map((w) => w.root)).size).toBe(6);
  });

  it('a chat started in a subfolder works in the same subfolder of its worktree', () => {
    const dir = repo('sub');
    const wt = worktrees.add(path.join(dir, 'app', 'src'));
    expect(wt.path).toBe(path.join(wt.root, 'app', 'src'));
    expect(fs.readFileSync(path.join(wt.path, 'a.js'), 'utf8')).toBe('a\n');
  });

  it('remove() takes the worktree and its branch away', () => {
    const dir = repo('rm');
    const wt = worktrees.add(dir);
    worktrees.remove(wt);
    expect(fs.existsSync(wt.root)).toBe(false);
    expect(git(dir, 'branch', '--list', wt.branch)).toBe('');
  });
});
