// The git surface the desktop app shows in its side panel: the working-tree
// diff, the diff stats, the recent commits and one commit's patch.
//
// The status is cached for a few seconds — a panel that polls git on every
// render spawns a process per frame. The cache is dropped on demand, and
// whenever a file in the working tree changes.
// #p8-git-surface
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUS_TTL_MS = 4000;
const MAX_DIFF_BYTES = 512 * 1024;

const statusCache = new Map();   // cwd -> { at, value }

/** Run git in one directory. Never throws: the result says what happened. */
function git(cwd, args, { timeout = 8000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

/** Truncate a patch at a byte budget, saying so instead of cutting mid-line. */
function clamp(text, maxBytes = MAX_DIFF_BYTES) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  let out = s.slice(0, maxBytes);
  const cut = out.lastIndexOf('\n');
  if (cut > maxBytes * 0.5) out = out.slice(0, cut);
  return { text: out + '\n… truncated …\n', truncated: true };
}

/** The working-tree status: branch, ahead/behind, changed files. */
async function status(cwd) {
  const dir = String(cwd || '').replace(/^~(?=\/|$)/, os.homedir());
  const cached = statusCache.get(dir);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const [branch, porcelain, ahead] = await Promise.all([
    git(dir, ['branch', '--show-current']),
    git(dir, ['status', '--porcelain=v1', '--branch']),
    git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
  ]);
  const files = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelain.stdout.split('\n')) {
    if (!line.trim() || line.startsWith('##')) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '??') untracked++;
    else {
      if (code[0] !== ' ') staged++;
      if (code[1] !== ' ') unstaged++;
    }
    files.push({ code, file });
  }
  const counts = ahead.stdout.trim().split(/\s+/).filter(Boolean);
  const value = {
    ok: true,
    branch: branch.stdout.trim(),
    ahead: Number(counts[0] || 0),
    behind: Number(counts[1] || 0),
    staged, unstaged, untracked,
    files: files.slice(0, 200),
    fileCount: files.length,
  };
  statusCache.set(dir, { at: Date.now(), value });
  return value;
}

/** Drop the cached status for one directory (or all of them). */
function invalidate(cwd) {
  if (!cwd) {
    statusCache.clear();
    return { ok: true, cleared: 'all' };
  }
  const dir = String(cwd).replace(/^~(?=\/|$)/, os.homedir());
  statusCache.delete(dir);
  return { ok: true, cleared: dir };
}

/**
 * The working-tree patch.
 * @param {object} o
 * @param {boolean} o.staged only the staged changes
 * @param {string[]} o.paths only these files
 */
async function diff(cwd, { staged = false, paths = [], context = 3, maxBytes = MAX_DIFF_BYTES } = {}) {
  const dir = String(cwd || '').replace(/^~(?=\/|$)/, os.homedir());
  const args = ['diff', '--no-color', '--unified=' + String(context)];
  if (staged) args.push('--cached');
  if (Array.isArray(paths) && paths.length) {
    args.push('--');
    for (const p of paths.slice(0, 50)) args.push(String(p));
  }
  const res = await git(dir, args);
  const body = clamp(res.stdout, maxBytes);
  return { ok: res.ok, patch: body.text, truncated: body.truncated, error: res.error };
}

/** The same diff as numbers: files changed, insertions, deletions. */
async function diffStats(cwd, { staged = false, paths = [] } = {}) {
  const dir = String(cwd || '').replace(/^~(?=\/|$)/, os.homedir());
  const args = ['diff', '--numstat'];
  if (staged) args.push('--cached');
  if (Array.isArray(paths) && paths.length) {
    args.push('--');
    for (const p of paths.slice(0, 50)) args.push(String(p));
  }
  const res = await git(dir, args);
  const files = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, file] = line.split('\t');
    const a = Number(add);
    const d = Number(del);
    if (Number.isFinite(a)) insertions += a;
    if (Number.isFinite(d)) deletions += d;
    files.push({ file: file || '', insertions: Number.isFinite(a) ? a : 0, deletions: Number.isFinite(d) ? d : 0, binary: add === '-' });
  }
  return { ok: res.ok, files, insertions, deletions, error: res.error };
}

/** The recent commits, newest first. */
async function commits(cwd, { limit = 20 } = {}) {
  const dir = String(cwd || '').replace(/^~(?=\/|$)/, os.homedir());
  const res = await git(dir, [
    'log', '--no-color', '--date=iso-strict', '--pretty=format:%H%x1f%an%x1f%aI%x1f%s',
    '-' + String(Math.min(Math.max(Number(limit) || 20, 1), 100)),
  ]);
  const list = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sha, author, date, ...subject] = line.split('\x1f');
    if (!sha) continue;
    list.push({ sha, author, date, subject: subject.join('\x1f') });
  }
  return { ok: res.ok, commits: list, error: res.error };
}

/** One commit's patch. */
async function commitDiff(cwd, { sha, maxBytes = MAX_DIFF_BYTES } = {}) {
  const dir = String(cwd || '').replace(/^~(?=\/|$)/, os.homedir());
  const id = String(sha || '').trim();
  // A sha is hex: anything else would be an argument injection into git.
  if (!/^[0-9a-f]{7,40}$/i.test(id)) {
    return { ok: false, patch: '', error: 'not a commit id', truncated: false };
  }
  const res = await git(dir, ['show', '--no-color', '--patch', '--format=fuller', id]);
  const body = clamp(res.stdout, maxBytes);
  return { ok: res.ok, patch: body.text, truncated: body.truncated, error: res.error };
}

/** True when the directory is inside a git work tree. */
function isRepo(cwd) {
  try {
    return fs.existsSync(path.join(String(cwd || ''), '.git'));
  } catch {
    return false;
  }
}

module.exports = {
  git, clamp, status, invalidate, diff, diffStats, commits, commitDiff, isRepo,
  STATUS_TTL_MS, MAX_DIFF_BYTES,
};
