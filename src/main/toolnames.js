// OpenAI-format APIs cap a function name at 64 characters and Mistral wants
// tool-call ids of exactly nine letters or digits. MCP tool names routinely
// pass 64 and the engine's ids are longer than nine, so both are mapped on the
// way out and (for names) back on the way in.
'use strict';
const crypto = require('crypto');

const MAX_NAME = 64;
const hash = (s, n) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);

/** A stable wire name of at most 64 characters for a longer tool name. */
const BAD_CHARS = /[^a-zA-Z0-9_-]/;
function shortName(name) {
  const s = String(name || '');
  if (s.length <= MAX_NAME && !BAD_CHARS.test(s)) return s;
  // OpenAI-format APIs accept only [a-zA-Z0-9_-]; a plugin tool such as
  // "mcp__plugin:ecc:chrome.devtools__x" is rejected (or silently dropped).
  const clean = s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean.slice(0, MAX_NAME - 9) + '_' + hash(s, 8);
}

/**
 * Rewrite over-long tool names in an Anthropic-format request body. Returns the
 * body to send and `back(name)` to restore an original name in a reply.
 */
function wrapToolNames(body) {
  const names = new Set();
  for (const t of (body && body.tools) || []) if (t && t.name) names.add(t.name);
  for (const m of (body && body.messages) || []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === 'tool_use' && b.name) names.add(b.name);
  }
  const long = [...names].filter((n) => n.length > MAX_NAME || BAD_CHARS.test(n));
  if (!long.length) return { body, back: (n) => n };
  const wire = new Map(long.map((n) => [n, shortName(n)]));
  const orig = new Map(long.map((n) => [shortName(n), n]));
  const to = (n) => wire.get(n) || n;
  const out = { ...body };
  if (Array.isArray(body.tools)) out.tools = body.tools.map((t) => (t && wire.has(t.name) ? { ...t, name: to(t.name) } : t));
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map((m) => (Array.isArray(m.content)
      ? { ...m, content: m.content.map((b) => (b && b.type === 'tool_use' && wire.has(b.name) ? { ...b, name: to(b.name) } : b)) }
      : m));
  }
  if (body.tool_choice && body.tool_choice.name && wire.has(body.tool_choice.name)) out.tool_choice = { ...body.tool_choice, name: to(body.tool_choice.name) };
  return { body: out, back: (n) => orig.get(n) || n };
}

/** Mistral accepts only [a-zA-Z0-9]{9} as a tool-call id. */
const isMistral = (prov) => /mistral\.ai/i.test(String((prov && prov.baseUrl) || '')) || (prov && prov.presetId) === 'mistral';
function wireToolId(prov, id) {
  const s = String(id || '');
  if (!isMistral(prov) || /^[a-zA-Z0-9]{9}$/.test(s)) return s;
  return hash(s, 9);
}

module.exports = { MAX_NAME, shortName, wrapToolNames, wireToolId, isMistral };
