'use strict';
// Preview text for a slash command: the first lines of its SKILL.md or
// command .md. The command name only picks a file inside a fixed set of
// folders, so a name can never point at an arbitrary path.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_BYTES = 64 * 1024;
const MAX_LINES = 30;
const MAX_VISITS = 4000;

function splitFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { head: {}, body: String(text) };
  const head = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) head[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { head, body: String(text).slice(m[0].length) };
}

function readCapped(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
    return buf.slice(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** Every ":" part must be a plain name: no "..", no hidden names, nothing empty. */
function safeParts(name) {
  return String(name).split(':').every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.'));
}

/** The real path must stay under the folder it was found in (a symlink cannot lead out). */
function inside(root, file) {
  try {
    const r = fs.realpathSync(root);
    const f = fs.realpathSync(file);
    return f === r || f.startsWith(r + path.sep);
  } catch { return false; }
}

/** Plain folders: <root>/commands/<a>/<b>.md and <root>/skills/<name>/SKILL.md. */
function candidatesIn(root, cmd) {
  const rel = cmd.split(':').join(path.sep);
  return [path.join(root, 'commands', rel + '.md'), path.join(root, 'skills', cmd, 'SKILL.md')];
}

/** Plugin folders hold the same layout one or more levels down; walk them with a visit cap. */
function findInPlugins(pluginsRoot, plugin, cmd) {
  let visits = 0;
  const stack = [{ dir: pluginsRoot, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 6 || visits++ > MAX_VISITS) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const hasLayout = entries.some((e) => e.isDirectory() && (e.name === 'commands' || e.name === 'skills'));
    if (hasLayout && (!plugin || dir.split(path.sep).includes(plugin))) {
      for (const f of candidatesIn(dir, cmd)) if (isFile(f)) return f;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.git')) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return '';
}

function resolveCommandFile(name, cwd, home = os.homedir()) {
  if (!NAME_RE.test(String(name || ''))) return '';
  const roots = [];
  if (cwd) roots.push(path.join(cwd, '.claude'));
  roots.push(path.join(home, '.claude'));
  const colon = name.indexOf(':');
  const plugin = colon > 0 ? name.slice(0, colon) : '';
  const cmd = colon > 0 ? name.slice(colon + 1) : name;
  if (!safeParts(name)) return '';
  for (const r of roots) for (const f of candidatesIn(r, name)) if (isFile(f) && inside(r, f)) return f;
  const pluginsRoot = path.join(home, '.claude', 'plugins');
  const found = findInPlugins(pluginsRoot, plugin, cmd);
  return found && inside(pluginsRoot, found) ? found : '';
}

/**
 * @returns {{found:boolean, name:string, path?:string, description?:string, argumentHint?:string, preview?:string, cut?:boolean}}
 */
function commandDetail({ name, cwd, home } = {}) {
  const file = resolveCommandFile(name, cwd, home);
  if (!file) return { found: false, name: String(name || '') };
  let text = '';
  try { text = readCapped(file); } catch { return { found: false, name: String(name) }; }
  const { head, body } = splitFrontmatter(text);
  const lines = body.replace(/^\s+/, '').split('\n');
  return {
    found: true,
    name,
    path: file,
    description: head.description || '',
    argumentHint: head['argument-hint'] || '',
    preview: lines.slice(0, MAX_LINES).join('\n'),
    cut: lines.length > MAX_LINES,
  };
}

module.exports = { commandDetail, resolveCommandFile, splitFrontmatter, NAME_RE };
