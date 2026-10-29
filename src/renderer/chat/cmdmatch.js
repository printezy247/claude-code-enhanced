// Pure helpers for the "/" and "@" menus: matching, sections, recent
// commands, windowing. No DOM here, so the tests can load it directly.

export const SECTION_ORDER = ['Recent', 'Built-in', 'Project & user', 'Plugins', 'MCP'];

/**
 * Score one command against a query. Higher is better, -1 is no match.
 * Prefix beats word start beats substring beats a loose in-order match, and a
 * description hit counts least. `indices` are the matched name positions.
 */
export function fuzzyScore(query, name, description = '') {
  const q = String(query || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (!q) return { score: 1, indices: [] };
  if (n.startsWith(q)) return { score: 1000 - n.length, indices: range(0, q.length) };
  const word = n.search(new RegExp('[:/_.-]' + escapeRe(q)));
  if (word >= 0) return { score: 800 - n.length, indices: range(word + 1, word + 1 + q.length) };
  const at = n.indexOf(q);
  if (at >= 0) return { score: 600 - at, indices: range(at, at + q.length) };
  const loose = subsequence(q, n);
  if (loose) return { score: 300 - (loose[loose.length - 1] - loose[0]), indices: loose };
  if (String(description).toLowerCase().includes(q)) return { score: 100, indices: [] };
  return { score: -1, indices: [] };
}

/** Where the command comes from, from its name. */
export function sourceOf(c) {
  if (c.own) return { section: 'Built-in', badge: 'cce' };
  const name = String(c.name || '');
  const i = name.indexOf(':');
  if (i > 0) {
    const prefix = name.slice(0, i);
    if (/^mcp/i.test(prefix)) return { section: 'MCP', badge: 'mcp' };
    return { section: 'Plugins', badge: 'plugin:' + prefix };
  }
  return { section: 'Project & user', badge: 'local' };
}

/**
 * Rank and section a command list. With an empty query the recent commands
 * come first; with a query a recent command gets a small boost.
 * @returns {Array<{c:object,section:string,badge:string,indices:number[],score:number}>}
 */
export function rankCommands(all, query, recent = []) {
  const rank = new Map(recent.map((n, i) => [n, i]));
  const rows = [];
  for (const c of all) {
    const m = fuzzyScore(query, c.name, c.description);
    if (m.score < 0) continue;
    const src = sourceOf(c);
    const r = rank.has(c.name) ? 50 - rank.get(c.name) : 0;
    rows.push({ c, section: src.section, badge: src.badge, indices: m.indices, score: m.score + (query ? r : 0) });
  }
  if (!query) {
    const recents = rows.filter((x) => rank.has(x.c.name)).sort((a, b) => rank.get(a.c.name) - rank.get(b.c.name));
    for (const x of recents) x.section = 'Recent';
    const rest = rows.filter((x) => !rank.has(x.c.name));
    return recents.concat(sortBySection(rest));
  }
  rows.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return rows;
}

function sortBySection(rows) {
  const order = (s) => SECTION_ORDER.indexOf(s);
  return rows.slice().sort((a, b) => order(a.section) - order(b.section) || a.c.name.localeCompare(b.c.name));
}

export function loadRecent(storage, key) {
  try {
    const v = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20) : [];
  } catch { return []; }
}

export function pushRecent(storage, key, name) {
  const list = loadRecent(storage, key).filter((n) => n !== name);
  list.unshift(name);
  try { storage.setItem(key, JSON.stringify(list.slice(0, 20))); } catch { /* storage full: recents just are not kept */ }
  return list.slice(0, 20);
}

/** The "/word" being typed at the cursor. Works mid-message, not only at position 0. */
export function slashTokenAt(value, pos) {
  const before = String(value || '').slice(0, pos == null ? value.length : pos);
  const m = before.match(/(^|\s)\/([^\s/]*)$/);
  if (!m) return null;
  const end = before.length;
  return { start: end - m[2].length - 1, end, query: m[2] };
}

/** Replace the "/token" with the chosen command. */
export function applySlashToken(value, token, name) {
  const after = String(value).slice(token.end);
  const sep = after.startsWith(' ') ? '' : ' ';
  const head = String(value).slice(0, token.start) + '/' + name + sep;
  return { value: head + after, caret: head.length };
}

/** Which rows to draw for a scroll position (fixed row height). */
export function windowRange(total, rowHeight, scrollTop, viewHeight, overscan = 4) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan);
  return { first, last };
}

/** Name split into [text, matched] runs for highlighting without innerHTML. */
export function highlightParts(name, indices) {
  const set = new Set(indices);
  const parts = [];
  for (let i = 0; i < name.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += name[i]; else parts.push({ text: name[i], hit });
  }
  return parts;
}

/** Entries of a folder, from the flat project file list. */
export function folderEntries(files, folder, limit = 30) {
  const base = folder.replace(/\/+$/, '') + '/';
  const seen = new Set();
  for (const f of files) {
    if (!f.startsWith(base)) continue;
    const rest = f.slice(base.length);
    const slash = rest.indexOf('/');
    seen.add(slash < 0 ? rest : rest.slice(0, slash) + '/');
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** First n lines of a text, flagged when cut. */
export function headLines(text, n) {
  const lines = String(text || '').split('\n');
  return { text: lines.slice(0, n).join('\n'), cut: lines.length > n };
}

function range(a, b) { const out = []; for (let i = a; i < b; i++) out.push(i); return out; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function subsequence(q, n) {
  const out = [];
  let from = 0;
  for (const ch of q) {
    const i = n.indexOf(ch, from);
    if (i < 0) return null;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** File name for a saved code block, from its language. */
const EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', bash: 'sh', sh: 'sh', shell: 'sh', json: 'json', html: 'html', css: 'css', markdown: 'md', md: 'md', yaml: 'yml', yml: 'yml', diff: 'diff', sql: 'sql', rust: 'rs', go: 'go', java: 'java' };
export function codeFileName(lang) { return 'snippet.' + (EXT[String(lang || '').toLowerCase()] || 'txt'); }


const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'terminal', 'shellsession', 'fish']);

/** True for a code block meant for a shell: a shell language tag, or a #! line. */
export function isShellBlock(lang, text) {
  if (SHELL_LANGS.has(String(lang || '').toLowerCase())) return true;
  return !lang && /^#!\s*\/\S*\b(ba|z|fi)?sh\b/.test(String(text || '').trimStart());
}

/**
 * What to paste into a terminal: the block as written, minus the "$ " prompt
 * a console example puts in front of each command (only when every line has it).
 */
export function shellText(text) {
  const lines = String(text || '').replace(/\n+$/, '').split('\n');
  const body = lines.filter((l) => l.trim());
  if (body.length && body.every((l) => /^\$ /.test(l.trim()))) return lines.map((l) => l.replace(/^(\s*)\$ /, '$1')).join('\n');
  return lines.join('\n');
}
