// Tool-call hygiene for the translated (non-Anthropic) path.
//
// Small and local models put tool calls in places the engine cannot read
// (prose, the reasoning channel), name tools loosely ("bash", "read_file"),
// repeat a call in both places, and slip on JSON syntax. These helpers decide
// what is really a call, what it is called, whether it is a duplicate, and
// whether broken arguments can safely be mended.
'use strict';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Loose names models use for the engine's built-in tools (normalized form). */
const ALIASES = {
  bash: 'Bash', shell: 'Bash', terminal: 'Bash', runcommand: 'Bash', executecommand: 'Bash',
  runshellcommand: 'Bash', execbash: 'Bash', runbash: 'Bash',
  readfile: 'Read', fileread: 'Read', viewfile: 'Read', openfile: 'Read',
  writefile: 'Write', createfile: 'Write', filewrite: 'Write',
  editfile: 'Edit', replaceinfile: 'Edit', strreplace: 'Edit', strreplaceeditor: 'Edit', fileedit: 'Edit',
  grepsearch: 'Grep', searchfiles: 'Grep', searchcode: 'Grep', ripgrep: 'Grep',
  findfiles: 'Glob', listfiles: 'Glob', globfiles: 'Glob',
};

/**
 * The name a call should carry, or null when it is not one of the tools in
 * this request. `known` is the set of tool names the request offers; an empty
 * set means no call can run (a summary or title request), so nothing counts.
 */
function resolveToolName(name, known) {
  const raw = String(name || '');
  if (!raw) return null;
  if (!known) return raw;
  if (!known.size) return null;
  if (known.has(raw)) return raw;
  const n = norm(raw);
  if (!n) return null;
  const same = [...known].filter((k) => norm(k) === n);
  if (same.length === 1) return same[0];
  const alias = ALIASES[n];
  if (alias && known.has(alias)) return alias;
  // "search" for the one connector tool ending in __search
  const tail = [...known].filter((k) => k.startsWith('mcp__') && norm(k.split('__').pop()) === n);
  if (tail.length === 1) return tail[0];
  return null;
}

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};

/** A stable string for a call, to spot the same call arriving twice. */
function callSignature(name, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch { return name + '\u0000' + a; } }
  return name + '\u0000' + JSON.stringify(sortKeys(a == null ? {} : a));
}

const asObject = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
};

/**
 * Mend argument JSON the model finished but wrote badly: a trailing comma,
 * Python's True/False/None, single quotes, a missing closing brace.
 *
 * This is for a model's slip, never for a cut-off: a call that was truncated
 * (output limit, dropped stream) is incomplete, and closing it would run a
 * write with half its content. The caller decides which case it is in.
 * @returns {object|null} the arguments, or null when they cannot be mended
 */
function repairToolArgs(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const direct = asObject(s);
  if (direct) return direct;
  if (!s.includes('"') && s.includes("'")) s = s.replace(/'/g, '"');

  let out = '';
  const closers = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '{') { closers.push('}'); out += ch; continue; }
    if (ch === '[') { closers.push(']'); out += ch; continue; }
    if (ch === '}' || ch === ']') {
      out = out.replace(/,\s*$/, '');
      if (closers.length && closers[closers.length - 1] === ch) closers.pop();
      out += ch;
      continue;
    }
    const lit = /^(True|False|None)\b/.exec(s.slice(i, i + 5));
    if (lit) {
      out += lit[1] === 'True' ? 'true' : lit[1] === 'False' ? 'false' : 'null';
      i += lit[1].length - 1;
      continue;
    }
    out += ch;
  }
  if (inStr) return null;   // an unfinished string is a cut-off, not a slip
  out = out.replace(/,\s*$/, '') + closers.reverse().join('');
  return asObject(out);
}

/** True when the named tool has required parameters (its schema says so). */
function requiresArgs(tools, name) {
  const t = (Array.isArray(tools) ? tools : []).find((x) => x && x.name === name);
  const req = t && t.input_schema && t.input_schema.required;
  return Array.isArray(req) && req.length > 0;
}

module.exports = { resolveToolName, callSignature, repairToolArgs, requiresArgs, ALIASES };
