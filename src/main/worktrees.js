// Per-chat git worktrees. Parallel agents sharing one working tree overwrite
// each other's uncommitted edits; a worktree per chat keeps them isolated,
// like the desktop app's scratch workspaces. #feat-worktree
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Folders a project installs into: git does not carry them into a new worktree.
const DEP_DIRS = ['node_modules', '.venv', 'venv'];

const gitRunner = (deps) => deps.run || ((args, opts) =>
  execFileSync('git', args, { timeout: 30000, stdio: 'pipe', ...opts }).toString());

/**
 * Create a new worktree of the repo containing `dir`.
 * @param {string} dir
 * @param {{run?: Function, stamp?: string, fs?: object}} [deps] injectable for tests
 * @returns {{path: string, root: string, branch: string, top: string} | {error: string}}
 */
function add(dir, deps = {}) {
  const run = gitRunner(deps);
  const fss = deps.fs || fs;
  if (!dir) return { error: 'no folder' };
  dir = String(dir).replace(/^~(?=\/|$)/, os.homedir());
  let top = '';
  try {
    top = String(run(['rev-parse', '--show-toplevel'], { cwd: dir })).trim();
  } catch {
    return { error: 'not a git repository: ' + dir };
  }
  if (!top) return { error: 'not a git repository: ' + dir };
  // Seconds alone collided when two worktree chats started in the same second.
  const stamp = deps.stamp || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    + '-' + Math.random().toString(36).slice(2, 6);
  const branch = 'cce/' + stamp;
  const p = path.join(top, '.claude', 'worktrees', 'cce-' + stamp);
  try {
    fss.mkdirSync(path.dirname(p), { recursive: true });
    run(['worktree', 'add', p, '-b', branch], { cwd: top });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 200);
    return { error: 'git worktree add failed: ' + detail };
  }
  // Keep the worktrees folder out of the user's own `git status`.
  try {
    const exclude = String(run(['rev-parse', '--git-path', 'info/exclude'], { cwd: top })).trim();
    const file = path.isAbsolute(exclude) ? exclude : path.join(top, exclude);
    const cur = fss.existsSync(file) ? fss.readFileSync(file, 'utf8') : '';
    if (!/^\/?\.claude\/worktrees\/?$/m.test(cur)) {
      fss.mkdirSync(path.dirname(file), { recursive: true });
      fss.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + '/.claude/worktrees/\n');
    }
  } catch { /* the exclude is a nicety */ }
  // A chat started in repo/sub keeps working in the same subfolder.
  const rel = path.relative(top, dir);
  const sub = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(p, rel) : p;
  // Dependency folders are untracked, so a worktree starts without them. They
  // are not linked in: a shared node_modules would let one chat's install
  // rewrite another's. Say which ones the project has, so the chat can reinstall.
  const needsInstall = DEP_DIRS.filter((d) => fss.existsSync(path.join(top, d)) && !fss.existsSync(path.join(p, d)));
  return { path: fss.existsSync(sub) ? sub : p, root: p, branch, top, needsInstall };
}

/** Undo add() when the chat that wanted the worktree never started. */
function remove(wt, deps = {}) {
  const run = gitRunner(deps);
  if (!wt || !wt.root || !wt.top) return;
  try { run(['worktree', 'remove', '--force', wt.root], { cwd: wt.top }); } catch { /* already gone */ }
  try { run(['branch', '-D', wt.branch], { cwd: wt.top }); } catch { /* already gone */ }
}

module.exports = { add, remove };
