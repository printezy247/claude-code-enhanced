'use strict';
// Codebase index (item 15): a cheap symbol+path index of a project so the
// model (or you) can find "where is buildBoard" without reading files into
// context. The index is plain JSON under userData — no server, no network.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Junk that never belongs in an index (same list the file tree ignores).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache', '__pycache__', '.venv', 'vendor', '.next']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm', '.zip', '.gz', '.tar', '.pdf', '.lock', '.bin', '.exe', '.so', '.dylib', '.pyc', '.class', '.jar', '.map']);
const MAX_FILE_BYTES = 256 * 1024;   // big files are not worth indexing line by line
const MAX_FILES = 20000;
const MAX_RESULTS = 50;

// Definitions worth remembering: function/class/const lets and Go/Python-ish
// forms, good enough for "find the symbol" queries without a real parser.
const SYMBOL_RES = [
  /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\s)(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /^\s*def\s+([A-Za-z_][\w]*)/gm,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm,
  /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_][\w]*)/gm,
];

function symbolsOf(line, lineNo) {
  const out = [];
  for (const re of SYMBOL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m[1] && m[1].length > 1) out.push({ name: m[1], line: lineNo });
      if (out.length > 20) break;
    }
  }
  return out;
}

function shouldSkipDir(name) { return SKIP_DIRS.has(name) || name.startsWith('.'); }
function shouldSkipFile(name) {
  const ext = path.extname(name).toLowerCase();
  return SKIP_EXT.has(ext) || name === '.DS_Store';
}

function walk(dir, rel, files) {
  if (files.length >= MAX_FILES) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (files.length >= MAX_FILES) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      walk(abs, rel ? rel + '/' + e.name : e.name, files);
    } else if (e.isFile()) {
      if (shouldSkipFile(e.name)) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (!st.size || st.size > MAX_FILE_BYTES) continue;
      files.push({ abs, rel: rel ? rel + '/' + e.name : e.name, size: st.size });
    }
  }
}

function createCodeIndex({ storeDir } = {}) {
  const dir = storeDir || path.join(os.homedir(), '.cache', 'cce', 'index');
  const cache = new Map();   // cwd -> index object (the JSON on disk is the backup)
  const storeFor = (cwd) => path.join(dir, crypto.createHash('sha1').update(String(cwd)).digest('hex') + '.json');

  function save(cwd, idx) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(storeFor(cwd), JSON.stringify(idx));
    } catch { /* cache is best effort */ }
  }

  function load(cwd) {
    const key = String(cwd);
    if (cache.has(key)) return cache.get(key);
    try {
      const j = JSON.parse(fs.readFileSync(storeFor(key), 'utf8'));
      if (j && Array.isArray(j.files)) { cache.set(key, j); return j; }
    } catch { /* not built yet */ }
    return null;
  }

  async function build(cwd) {
    const root = String(cwd);
    const found = [];
    walk(root, '', found);
    const files = [];
    let symbols = 0;
    for (let i = 0; i < found.length; i++) {
      if (i && i % 200 === 0) await new Promise((r) => setImmediate(r));   // don't hitch the UI
      const f = found[i];
      let text;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      const syms = [];
      const lines = text.split('\n');
      for (let n = 0; n < lines.length; n++) {
        if (lines[n].length > 500) continue;
        const s = symbolsOf(lines[n], n + 1);
        if (s.length) { syms.push(...s); symbols += s.length; }
        if (syms.length > 200) break;
      }
      files.push({ path: f.rel, symbols: syms });
    }
    const idx = { cwd: root, builtAt: Date.now(), files };
    cache.set(root, idx);
    save(root, idx);
    return { files: files.length, symbols, builtAt: idx.builtAt };
  }

  function status(cwd) {
    const idx = load(cwd);
    if (!idx) return { built: false, files: 0, symbols: 0 };
    let symbols = 0;
    for (const f of idx.files) symbols += f.symbols.length;
    return { built: true, files: idx.files.length, symbols, builtAt: idx.builtAt };
  }

  function search(cwd, query) {
    const idx = load(cwd);
    const q = String(query || '').trim().toLowerCase();
    if (!idx || !q) return [];
    const hits = [];
    // Symbols first — "where is buildBoard" should return the definition,
    // not every file whose path contains the word.
    for (const f of idx.files) {
      for (const s of f.symbols) {
        if (s.name.toLowerCase().includes(q)) {
          hits.push({ path: f.path, symbol: s.name, line: s.line });
          if (hits.length >= MAX_RESULTS) return hits;
        }
      }
    }
    for (const f of idx.files) {
      if (f.path.toLowerCase().includes(q)) {
        hits.push({ path: f.path });
        if (hits.length >= MAX_RESULTS) return hits;
      }
    }
    return hits;
  }

  return { build, search, status };
}

// One index shared by the IPC handlers and the per-chat MCP server.
let sharedIdx = null;
function shared() {
  if (!sharedIdx) {
    let storeDir;
    try {
      const { app } = require('electron');
      storeDir = path.join(app.getPath('userData'), 'codeindex');
    } catch { storeDir = path.join(os.homedir(), '.cache', 'cce', 'index'); }
    sharedIdx = createCodeIndex({ storeDir });
  }
  return sharedIdx;
}

module.exports = { createCodeIndex, shared };
