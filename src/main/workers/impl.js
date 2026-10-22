'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function normalizeIndexInput(input) {
  if (typeof input === 'string') return { dir: input };
  return input || {};
}

function indexFiles(input) {
  const opts = normalizeIndexInput(input);
  const root = path.resolve(String(opts.dir || opts.root || '.').replace(/^~(?=\/|$)/, process.env.HOME || require('node:os').homedir()));
  const limit = Math.min(Number(opts.limit) > 0 ? Number(opts.limit) : 3000, 10000);
  const files = [];
  const walk = (d, depth) => {
    if (depth > 6 || files.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else files.push(path.relative(root, p));
      if (files.length >= limit) return;
    }
  };
  walk(root, 0);
  return files.slice(0, limit).sort();
}

function walkJsonl(dir) {
  const root = path.resolve(String(dir || '.').replace(/^~(?=\/|$)/, process.env.HOME || require('node:os').homedir()));
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

function normalizeSearchInput(input) {
  if (typeof input === 'string') return { query: input };
  return input || {};
}

function searchTranscripts(input) {
  const opts = normalizeSearchInput(input);
  const query = String(opts.query || opts.q || '');
  const limit = Math.min(Number(opts.limit) > 0 ? Number(opts.limit) : 1000, 10000);
  const files = Array.isArray(opts.files) ? opts.files.slice() : (opts.dir ? walkJsonl(opts.dir) : []);
  const out = [];
  const q = query.toLowerCase();
  for (const f of files) {
    if (out.length >= limit) break;
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      if (q && line.toLowerCase().includes(q)) {
        out.push({ file: f, line: line.slice(0, 500) });
        if (out.length >= limit) break;
      }
    }
  }
  return { query, matches: out, count: out.length };
}

function normalizeShellInput(input) {
  if (typeof input === 'string') return { shell: input };
  return input || {};
}

function resolveShellPath(input) {
  const opts = normalizeShellInput(input);
  const shell = opts.shell || process.env.SHELL || '/bin/bash';
  const env = {};
  try {
    const out = execFileSync(shell, ['-ilc', 'env'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of String(out).split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
  } catch {
    Object.assign(env, process.env);
  }
  if (!Object.keys(env).length) Object.assign(env, process.env);
  return { shell, env, path: env.PATH || process.env.PATH || '' };
}

function dispatch(job, payload) {
  if (job === 'file-index' || job === 'fileIndex') return indexFiles(payload);
  if (job === 'transcript-search' || job === 'transcriptSearch') return searchTranscripts(payload);
  if (job === 'shell-path' || job === 'shellPath') return resolveShellPath(payload);
  throw new Error('unknown worker job: ' + job);
}

module.exports = { indexFiles, searchTranscripts, resolveShellPath, dispatch, walkJsonl };