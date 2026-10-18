// Per-chat git worktrees. Parallel agents sharing one working tree overwrite
// each other's uncommitted edits; a worktree per chat keeps them isolated,
// like the desktop app's scratch workspaces. #feat-worktree
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Create a new worktree of the repo containing `dir`.
 * @param {string} dir
 * @param {{run?: Function, stamp?: string}} [deps] injectable for tests
 * @returns {{path: string, branch: string} | {error: string}}
 */
function add(dir, deps = {}) {
  const run = deps.run || ((args, opts) =>
    execFileSync('git', args, { timeout: 30000, stdio: 'pipe', ...opts }).toString());
  const fss = deps.fs || fs;
  if (!dir) return { error: 'no folder' };
  let top = '';
  try {
    top = String(run(['rev-parse', '--show-toplevel'], { cwd: dir })).trim();
  } catch {
    return { error: 'not a git repository: ' + dir };
  }
  if (!top) return { error: 'not a git repository: ' + dir };
  const stamp = deps.stamp || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const branch = 'cce/' + stamp;
  const p = path.join(top, '.claude', 'worktrees', 'cce-' + stamp);
  try {
    fss.mkdirSync(path.dirname(p), { recursive: true });
    run(['worktree', 'add', p, '-b', branch], { cwd: top });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 200);
    return { error: 'git worktree add failed: ' + detail };
  }
  return { path: p, branch };
}

module.exports = { add };
