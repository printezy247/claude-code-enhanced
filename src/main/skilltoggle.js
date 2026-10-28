'use strict';
// Skill / agent enable-disable state for CCE. #C4
// Persisted per machine in ~/.claude/cce-disabled.json.
// Main-process consumers can require this module to filter the synced skill
// list and agent list that a session actually uses.
//
// The module is also the skills manager: it reads the skills that are on the
// disk (the user's ~/.claude/skills and the project's .claude/skills), reads
// a single SKILL.md, and flips one skill on or off in the same store the
// toggle already used.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJson, readJsonSafe } = require('./atomic');

function homeDir() { return process.env.HOME || os.homedir(); }
function storePath() { return path.join(homeDir(), '.claude', 'cce-disabled.json'); }

function readStore() {
  const j = readJsonSafe(storePath());
  if (!j || typeof j !== 'object') return { skills: [], agents: [], snapshot: [] };
  return {
    skills: Array.isArray(j.skills) ? j.skills : [],
    agents: Array.isArray(j.agents) ? j.agents : [],
    // Last skills:sync snapshot (item 18) — which names were on disk then.
    snapshot: Array.isArray(j.snapshot) ? j.snapshot : [],
  };
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    atomicWriteJson(storePath(), data);
  } catch { /* non-fatal */ }
}

function disabledSkills() { return new Set(readStore().skills.map(String)); }
function disabledAgents() { return new Set(readStore().agents.map(String)); }

function setSkill(name, disabled) {
  const s = readStore();
  const set = new Set(s.skills.map(String));
  if (disabled) set.add(String(name)); else set.delete(String(name));
  s.skills = [...set];
  writeStore(s);
}

function setAgent(name, disabled) {
  const s = readStore();
  const set = new Set(s.agents.map(String));
  if (disabled) set.add(String(name)); else set.delete(String(name));
  s.agents = [...set];
  writeStore(s);
}

function isSkillEnabled(name) { return !disabledSkills().has(String(name)); }
function isAgentEnabled(name) { return !disabledAgents().has(String(name)); }

function filterSkills(list) {
  const disabled = disabledSkills();
  return (Array.isArray(list) ? list : []).filter((s) => {
    const name = (s && (s.name || s)) || '';
    return !disabled.has(String(name));
  });
}

function filterAgents(list) {
  const disabled = disabledAgents();
  return (Array.isArray(list) ? list : []).filter((a) => {
    const name = (a && (a.name || a)) || '';
    return !disabled.has(String(name));
  });
}

function filterSyncedEntries(entries) {
  const disabled = disabledSkills();
  const out = {};
  const src = entries instanceof Map ? [...entries.entries()] : Object.entries(entries || {});
  for (const [name, dir] of src) {
    if (!disabled.has(String(name))) out[name] = dir;
  }
  return out;
}

// ---------- the skills manager ------------------------------------------------
//
// A skill is a directory that holds a SKILL.md whose YAML frontmatter names
// it:
//   ---
//   name: docx
//   description: "Create and edit Word documents."
//   ---
//   # Docx
//   …
// The engine reads the user's ~/.claude/skills and the project's
// .claude/skills; a project skill wins over a user skill of the same name.

/** Where skills are looked for: project first, then user, then an extra dir. */
function skillRoots(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const roots = [];
  const project = path.join(cwd, '.claude', 'skills');
  const user = path.join(homeDir(), '.claude', 'skills');
  roots.push({ dir: project, source: 'project' });
  if (user !== project) roots.push({ dir: user, source: 'user' });
  if (opts.skillsDir) roots.push({ dir: path.resolve(String(opts.skillsDir)), source: opts.source || 'custom' });
  return roots;
}

/** Every directory under `root` that holds a SKILL.md, two levels deep. */
function findSkillDirs(root, maxDepth = 2) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, 'SKILL.md'))) { found.push(full); continue; }
      if (depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/** Strip the quotes YAML puts around a scalar. */
function unquote(value) {
  const s = String(value == null ? '' : value).trim();
  if (s.length > 1 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/**
 * The small part of YAML a SKILL.md frontmatter uses: scalars, lists and
 * block scalars. Anything fancier is not what a skill header needs.
 */
function parseFrontmatterBlock(block) {
  const out = {};
  const lines = String(block || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (/^[|>][-+]?$/.test(value)) {
      const parts = [];
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || /^\s+\S/.test(lines[j]))) {
        parts.push(lines[j].replace(/^\s+/, ''));
        j++;
      }
      value = value[0] === '>' ? parts.join(' ').trim() : parts.join('\n');
      i = j - 1;
    } else if (value === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(unquote(lines[j].replace(/^\s*-\s+/, '')));
        j++;
      }
      if (items.length) { out[key] = items; i = j - 1; continue; }
      value = '';
    } else if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map(s => unquote(s)).filter(Boolean);
      continue;
    }
    out[key] = unquote(value);
  }
  return out;
}

/** Split a SKILL.md into its frontmatter and its body. */
function splitFrontmatter(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!m) return { frontmatter: {}, body: t };
  return { frontmatter: parseFrontmatterBlock(m[1]), body: t.slice(m[0].length) };
}

/**
 * Read one skill.
 * @param {string} p the skill directory or its SKILL.md
 * @returns {{name: string, description: string, frontmatter: object, body: string, path: string}}
 */
function readSkill(p) {
  const target = String(p || '');
  let file = target;
  try {
    if (fs.statSync(target).isDirectory()) file = path.join(target, 'SKILL.md');
  } catch { /* the caller gets an empty skill */ }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* unreadable skill */ }
  const { frontmatter, body } = splitFrontmatter(text);
  const name = String(frontmatter.name || path.basename(path.dirname(file)) || '').trim();
  return {
    name,
    description: String(frontmatter.description || '').trim(),
    frontmatter,
    body,
    path: file,
  };
}

/**
 * Every skill on the disk.
 * @param {{skillsDir?: string, cwd?: string}} [opts]
 * @returns {Array<{name: string, path: string, description: string, source: string}>}
 */
function listSkills(opts = {}) {
  const seen = new Set();
  const out = [];
  for (const root of skillRoots(opts)) {
    for (const dir of findSkillDirs(root.dir)) {
      const skill = readSkill(dir);
      if (!skill.name) continue;
      if (seen.has(skill.name)) continue;   // a project skill wins over a user skill
      seen.add(skill.name);
      out.push({ name: skill.name, path: dir, description: skill.description, source: root.source });
    }
  }
  return out;
}

/**
 * Turn a skill on or off. The state lives in the same store the toggle used,
 * so a skill that is off here is off for the whole machine.
 * @param {string} name
 * @param {boolean} enabled
 * @returns {{name: string, enabled: boolean, disabled: boolean}}
 */
function setSkillEnabled(name, enabled, opts = {}) {
  const key = String(name == null ? '' : name);
  const s = readStore();
  const set = new Set(s.skills.map(String));
  if (enabled) set.delete(key); else set.add(key);
  s.skills = [...set];
  writeStore(s);
  const on = !set.has(key);
  return { name: key, enabled: on, disabled: !on };
}

/**
 * The skills on the disk with their current state merged in.
 * @param {{skillsDir?: string, cwd?: string}} [opts]
 * @returns {Array<{name: string, path: string, description: string, source: string, enabled: boolean}>}
 */
function scanSkills(opts = {}) {
  const disabled = disabledSkills();
  return listSkills(opts).map(s => ({ ...s, enabled: !disabled.has(String(s.name)) }));
}

// Skills sync (item 18): diff what is on disk against the snapshot of the
// last sync, and drop toggles for skills that no longer exist (a deleted
// skill must not linger in cce-disabled.json forever). Pure — the handler
// does the reading and writing around it.
function syncState({ onDisk = [], snapshot = [], disabled = [] } = {}) {
  const disk = [...new Set(onDisk.map(String))].sort();
  const prev = new Set(snapshot.map(String));
  const dis = new Set(disabled.map(String));
  const onDiskSet = new Set(disk);
  const added = disk.filter((n) => !prev.has(n));
  const removed = [...prev].filter((n) => !onDiskSet.has(n)).sort();
  const pruned = [...dis].filter((n) => !onDiskSet.has(n)).sort();
  const disabledAfter = [...dis].filter((n) => onDiskSet.has(n)).sort();
  return { added, removed, pruned, disabledAfter, snapshot: disk };
}

module.exports = {
  storePath,
  readStore,
  writeStore,
  disabledSkills,
  disabledAgents,
  setSkill,
  setAgent,
  isSkillEnabled,
  isAgentEnabled,
  filterSkills,
  filterAgents,
  filterSyncedEntries,
  // the skills manager
  listSkills,
  readSkill,
  setSkillEnabled,
  scanSkills,
  syncState,
  skillRoots,
  findSkillDirs,
  splitFrontmatter,
};
