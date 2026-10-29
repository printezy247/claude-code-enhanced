// External agent engines (item 11): Codex, Antigravity CLI and OpenCode run as
// real terminal tabs, the same way the claude CLI does. Detection is a PATH
// scan; nothing is spawned until the user opens a tab.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Per engine: what it is called and installed as, and how its chat runs.
// `chat` names the runner class (null = enginechat.EngineChat, one headless CLI
// run per message); `images` and `approvals` say whether that runner takes
// images and asks before acting; `providers`, whether it can run on a CCE
// provider through the local proxy. The chat view reads these, not the engine id.
const REGISTRY = [
  { id: 'codex', label: 'Codex', bin: 'codex', hint: 'install: npm install -g @openai/codex',
    chat: { module: './codexchat', cls: 'CodexChat' }, images: true, approvals: true, providers: true },
  { id: 'antigravity', label: 'Antigravity CLI', bin: 'agy', hint: 'install: see https://antigravity.google/docs/overview',
    chat: null, images: false, approvals: false, providers: false },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', hint: 'install: npm install -g opencode-ai',
    chat: { module: './opencodechat', cls: 'OpenCodeChat' }, images: true, approvals: true, providers: true },
];

function which(bin, pathVar) {
  for (const dir of String(pathVar || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try { if (fs.statSync(p).isFile() && fs.accessSync(p, fs.constants.X_OK) === undefined) return p; } catch { /* keep looking */ }
  }
  return '';
}

function versionOf(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['--version'], { timeout: 8_000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

/** Scan PATH for every registered engine. */
async function detect({ PATH } = {}) {
  const pathVar = PATH || process.env.PATH || '';
  return Promise.all(REGISTRY.map(async (e) => {
    const p = which(e.bin, pathVar);
    return { ...e, found: !!p, path: p, version: p ? await versionOf(p) : '' };
  }));
}

/** Resolve an engine id to a spawnable command, or explain what is missing. */
async function commandFor(id, { PATH } = {}) {
  const entry = REGISTRY.find((e) => e.id === id);
  if (!entry) return { error: `unknown engine: ${id} (known: ${REGISTRY.map((e) => e.id).join(', ')})` };
  const p = which(entry.bin, PATH || process.env.PATH || '');
  if (!p) return { error: `${entry.label} not found on PATH — ${entry.hint}` };
  return { command: p, args: [] };
}

module.exports = { REGISTRY, detect, commandFor, which };
