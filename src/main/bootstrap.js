// Session bootstrap: the capabilities every CCE chat starts with.
//
// The desktop harness must behave like the Claude Code desktop app on every
// new chat, so the three toolkits the user asked for are detected on disk and
// announced to the engine in the system prompt:
//
//   - caveman (JuliusBrussee/caveman)  -> terse voice, lite level
//   - rtk    (rtk-ai/rtk)              -> compressed shell output
//   - superpowers (obra/superpowers)   -> brainstorming first, then plans/TDD
//
// Nothing is invented: a capability is only announced when its files or
// binary are actually present, so the model is never told to use a tool the
// machine does not have.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/** Read at call time: the home directory can be repointed (tests, sandboxes). */
const homeDir = () => process.env.HOME || os.homedir();
const TTL_MS = 60_000;

let cache = { at: 0, value: null };

/**
 * A directory that holds <name>/SKILL.md, searched with a bounded depth.
 * Dot-directories are skipped: `~/.claude/skills/.trash/…` holds deleted
 * copies, and picking one of those would announce a toolkit that is gone.
 */
function findSkillDir(roots, name, maxDepth = 5) {
  const stack = roots.map((r) => ({ dir: r, depth: 0 }));
  const hits = [];
  while (stack.length) {
    const { dir, depth } = stack.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.name === name) {
        try {
          if (fs.existsSync(path.join(full, 'SKILL.md'))) hits.push(full);
        } catch { /* unreadable */ }
      }
      if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return hits[0] || null;
}

function which(candidates) {
  return new Promise((resolve) => {
    const bin = candidates[0];
    const args = candidates.slice(1);
    execFile('which', [bin, ...args], { timeout: 4000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim().split('\n')[0] || '');
    });
  });
}

/**
 * A Claude Code plugin directory (has .claude-plugin/plugin.json) whose name
 * mentions superpowers. The plugin is what carries the brainstorming skill.
 */
function findSuperpowersPlugin(roots) {
  const stack = roots.map((r) => ({ dir: r, depth: 0 }));
  while (stack.length) {
    const { dir, depth } = stack.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const manifest = path.join(full, '.claude-plugin', 'plugin.json');
      if (fs.existsSync(manifest)) {
        try {
          const meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          if (/superpowers/i.test(String(meta.name || ''))) return full;
        } catch { /* unreadable manifest */ }
      }
      if (depth < 3) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * Detect the bootstrap toolkits.
 * @returns {Promise<{caveman: string|null, superpowers: string|null,
 *   superpowersPlugin: string|null, rtk: string|null}>}
 */
async function detect() {
  const skillRoots = [
    path.join(homeDir(), '.claude', 'skills'),
    path.join(homeDir(), '.claude', 'plugins', 'marketplaces'),
    path.join(homeDir(), '.claude', 'plugins', 'cache'),
    path.join(homeDir(), '.claude', 'plugins', 'data'),
  ];
  const caveman = findSkillDir(skillRoots, 'caveman');
  // superpowers ships a `skills/` tree inside the plugin, so look for the
  // brainstorming skill itself — its presence is the real signal. The plugin
  // cache nests it as <marketplace>/<plugin>/<version>/skills/<name>, so the
  // search has to go deeper than a plain user-skill directory.
  const superpowers = findSkillDir(skillRoots, 'brainstorming', 6);
  const superpowersPlugin = findSuperpowersPlugin([
    path.join(homeDir(), '.claude', 'plugins', 'cache'),
    path.join(homeDir(), '.claude', 'plugins', 'marketplaces'),
  ]);
  const rtk = await which(['rtk']);
  return {
    caveman: caveman || null,
    superpowers: superpowers || null,
    superpowersPlugin: superpowersPlugin || null,
    rtk: rtk || (fs.existsSync('/usr/local/bin/rtk') ? '/usr/local/bin/rtk' : null),
  };
}

/** Cached detection — a chat start must not walk the plugin tree every time. */
async function capabilities() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = await detect();
  cache = { at: Date.now(), value };
  return value;
}

/**
 * The system-prompt append for a new chat. Empty when none of the toolkits
 * are installed, so the prompt stays clean on a bare machine.
 */
async function promptAppend() {
  const caps = await capabilities();
  const lines = ['CCE session bootstrap (always active):'];
  if (caps.caveman) {
    lines.push('- Voice: caveman (lite) — concise, no filler, professional but tight. '
      + 'Invoke the `caveman` skill and keep it at lite level.');
  }
  if (caps.rtk) {
    lines.push('- Shell output: rtk is installed (' + caps.rtk + '). Prefix shell commands with '
      + '`rtk` (for example `rtk git status`, `rtk read <path>`) so their output stays compact.');
  }
  if (caps.superpowers) {
    lines.push('- Method: superpowers is installed. Invoke the `brainstorming` skill before '
      + 'implementing anything non-trivial, then `writing-plans` and `test-driven-development`.');
  }
  lines.push('- Connectors: MCP servers attached to this session have full tool-calling access. '
    + 'Prefer their tools over shelling out.');
  if (lines.length === 1) return '';
  return lines.join('\n');
}

module.exports = {
  capabilities, detect, promptAppend, findSkillDir, findSuperpowersPlugin,
  // Test seam: the detection cache is keyed on HOME, so a test that repoints
  // HOME has to be able to drop it.
  __resetCacheForTests: () => { cache = { at: 0, value: null }; },
};
