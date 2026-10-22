'use strict';
// Skill / agent enable-disable state for CCE. #C4
// Persisted per machine in ~/.claude/cce-disabled.json.
// Main-process consumers can require this module to filter the synced skill
// list and agent list that a session actually uses.
const fs = require('fs');
const path = require('path');
const os = require('os');

function homeDir() { return process.env.HOME || os.homedir(); }
function storePath() { return path.join(homeDir(), '.claude', 'cce-disabled.json'); }

function readStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const j = JSON.parse(raw);
    return {
      skills: Array.isArray(j && j.skills) ? j.skills : [],
      agents: Array.isArray(j && j.agents) ? j.agents : [],
    };
  } catch { return { skills: [], agents: [] }; }
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
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

module.exports = {
  storePath,
  readStore,
  writeStore,
  disabledSkills,
  disabledAgents,
  setSkill,
  setAgent,
  setSkillDisabled: setSkill,
  setAgentDisabled: setAgent,
  isSkillEnabled,
  isAgentEnabled,
  filterSkills,
  filterAgents,
  filterSyncedEntries,
};
