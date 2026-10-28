'use strict';
// Auto-learn skills (item 19): after a chat shows a workflow worth repeating,
// ask the same model to draft a SKILL.md. Nothing is written until you accept
// the proposal — same pending/accept flow as auto-memory.
const fs = require('fs');
const path = require('path');

// Directory-name-safe only: no slashes, no dots, no uppercase surprises.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PROBE_PROMPT = [
  'Look back over this conversation for a workflow you performed that is likely to repeat for this user',
  '(a command sequence, a check-before-done ritual, a file layout, a review recipe).',
  'If there is one, answer with a JSON array of skill drafts, else answer with [].',
  'Each draft: {"name":"kebab-case-slug","description":"one line, when to use it","body":"the steps as markdown"}.',
  'Name must be lowercase letters/digits/hyphens only. Maximum one draft. No prose outside the JSON.',
].join(' ');

// Pull the first JSON array out of a model answer and keep only drafts a
// skills directory can actually hold. Path-traversal names are dropped here,
// not at write time.
function parseProposals(text) {
  const s = String(text || '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const name = String(p.name || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) continue;
    const description = String(p.description || '').trim().slice(0, 300);
    let body = String(p.body || '').trim().slice(0, 4000);
    if (!description || !body) continue;
    // The body lands in a file you will read later — strip the active bits.
    body = body.replace(/<\s*(script|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|iframe|object|embed)[^>]*\/?\s*>/gi, '');
    out.push({ name, description, body });
  }
  return out;
}

function createAutoLearn({ skillsDir, storeFile } = {}) {
  if (!skillsDir || !storeFile) throw new Error('createAutoLearn needs skillsDir and storeFile');

  function readPending() {
    try {
      const j = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch { return []; }
  }
  function writePending(list) {
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify(list, null, 2));
    } catch { /* best effort */ }
  }

  function addPending(drafts) {
    const list = readPending();
    const have = new Set(list.map((p) => p.name));
    let added = 0;
    for (const d of (Array.isArray(drafts) ? drafts : [])) {
      const name = String(d && d.name || '').toLowerCase();
      if (!NAME_RE.test(name) || have.has(name)) continue;
      list.push({
        name,
        description: String(d.description || '').slice(0, 300),
        body: String(d.body || '').slice(0, 4000),
        at: Date.now(),
      });
      have.add(name);
      added++;
    }
    if (added) writePending(list);
    return added;
  }

  function listPending() { return readPending(); }

  async function resolve(name, accept) {
    const key = String(name || '');
    const list = readPending();
    const draft = list.find((p) => p.name === key);
    const rest = list.filter((p) => p.name !== key);
    writePending(rest);                                  // accepted or rejected: out of pending
    if (!draft || !accept) return { saved: false, pending: rest.length };
    if (!NAME_RE.test(draft.name)) return { saved: false, pending: rest.length };
    const dir = path.join(skillsDir, draft.name);
    const md = [
      '---',
      'name: ' + draft.name,
      'description: ' + draft.description.replace(/[\r\n]+/g, ' '),
      '---',
      '',
      draft.body,
      '',
    ].join('\n');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
    } catch (err) {
      return { saved: false, error: String(err && err.message || err), pending: rest.length };
    }
    return { saved: true, path: path.join(dir, 'SKILL.md'), pending: rest.length };
  }

  return { addPending, listPending, resolve };
}

module.exports = { createAutoLearn, parseProposals, PROBE_PROMPT };
