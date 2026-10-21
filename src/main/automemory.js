// Auto-memory proposals. After a chat the model suggests up to three lasting
// facts; they wait in a hidden file until Jack accepts one, and only then is a
// note written to the project's memory folder and indexed in MEMORY.md.
const fs = require('fs');
const os = require('os');
const path = require('path');

const homeDir = () => process.env.HOME || os.homedir();
const TYPES = ['user', 'feedback', 'project', 'reference'];
const MAX_PROPOSALS = 3;

const PROBE_PROMPT = 'Reply with ONLY a JSON array, no prose and no code fence, of up to 3 facts worth remembering '
  + 'in FUTURE chats on this project: Jack\'s preferences, corrections he gave you, non-obvious constraints, '
  + 'decisions. Skip anything the code or git history already shows and anything that only matters to this chat. '
  + 'Each item: {"name":"short-kebab-slug","type":"user|feedback|project|reference","description":"one line",'
  + '"body":"the fact; for feedback and project add **Why:** and **How to apply:** lines"}. Reply [] if nothing qualifies.';

/** The engine keys a project folder by turning every non-alphanumeric into a dash. */
const memDir = (cwd) => path.join(homeDir(), '.claude', 'projects', String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
const pendingFile = (cwd) => path.join(memDir(cwd), '.proposals.json');   // dot file: never loaded as memory

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Pull the JSON array out of a model reply (bare, fenced, or inside prose). */
function parseProposals(text) {
  const s = String(text || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it.name !== 'string' || typeof it.description !== 'string' || typeof it.body !== 'string') continue;
    const slug = slugOf(it.name);
    if (!slug || !it.body.trim()) continue;
    out.push({
      slug,
      type: TYPES.includes(it.type) ? it.type : 'project',
      description: it.description.replace(/\s+/g, ' ').trim().slice(0, 200),
      body: it.body.trim().slice(0, 1500),
    });
    if (out.length === MAX_PROPOSALS) break;
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const listPending = (cwd) => readJson(pendingFile(cwd), []);

/** Queue proposals; skips notes already saved or already waiting. Returns how many were queued. */
function addPending(cwd, proposals) {
  const dir = memDir(cwd);
  const have = listPending(cwd);
  const fresh = (proposals || []).filter((p) => !fs.existsSync(path.join(dir, p.slug + '.md')) && !have.some((h) => h.slug === p.slug));
  if (!fresh.length) return 0;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pendingFile(cwd), JSON.stringify(have.concat(fresh), null, 2));
  return fresh.length;
}

/** Accept (write the note + index line) or reject (drop) one waiting proposal. */
function resolve(cwd, slug, accept) {
  const have = listPending(cwd);
  const p = have.find((h) => h.slug === slug);
  if (!p) return { saved: false, missing: true };
  fs.writeFileSync(pendingFile(cwd), JSON.stringify(have.filter((h) => h !== p), null, 2));
  if (!accept) return { saved: false };
  const dir = memDir(cwd);
  const file = path.join(dir, p.slug + '.md');
  if (fs.existsSync(file)) return { saved: false, duplicate: true };
  fs.writeFileSync(file, '---\nname: ' + p.slug + '\ndescription: ' + JSON.stringify(p.description)
    + '\nmetadata:\n  type: ' + p.type + '\n---\n\n' + p.body + '\n');
  const indexFile = path.join(dir, 'MEMORY.md');
  const title = p.slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  fs.writeFileSync(indexFile, index + (index && !index.endsWith('\n') ? '\n' : '') + '- [' + title + '](' + p.slug + '.md) — ' + p.description + '\n');
  return { saved: true };
}

module.exports = { PROBE_PROMPT, memDir, parseProposals, listPending, addPending, resolve };
