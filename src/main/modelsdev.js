// models.dev catalog: provider + model metadata (context limits, cost,
// capabilities). A compacted full snapshot is bundled as the offline seed;
// `refresh()` pulls the live api.json into the userData dir so new models and
// providers appear without a release.
//
// Nothing here talks to a model — it is pure metadata used by the provider UI
// (capability badges, ctx-floor warnings, cost columns, deprecated-model hints).
'use strict';
const fs = require('fs');
const path = require('path');

const MODELSDEV_URL = 'https://models.dev/api.json';
const SEED = require('./models-dev.seed.json');

let cache = null;      // parsed catalog
let cacheFile = null;  // userData/models-dev.json

/** Wire the userData directory (once, at boot). */
function init(userDataDir) {
  cacheFile = path.join(userDataDir, 'models-dev.json');
  cache = null;
}

/** The active catalog: live cache if present, else the bundled seed. */
function load() {
  if (cache) return cache;
  try {
    if (cacheFile && fs.existsSync(cacheFile)) {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (parsed && typeof parsed === 'object') { cache = parsed; return cache; }
    }
  } catch { /* corrupt cache -> seed */ }
  cache = SEED;
  return cache;
}

/** {providers, models, source, updated} — for the Settings/Providers header. */
function stat() {
  const cat = load();
  let models = 0;
  for (const p of Object.values(cat)) models += Object.keys((p && p.models) || {}).length;
  let updated = 0;
  try { if (cacheFile && fs.existsSync(cacheFile)) updated = fs.statSync(cacheFile).mtimeMs; } catch { /* seed */ }
  return { providers: Object.keys(cat).length, models, source: updated ? 'live' : 'bundled', updated };
}

/** Fetch the live catalog and cache it. Returns a summary. */
async function refresh() {
  const res = await fetch(MODELSDEV_URL, {
    headers: { 'user-agent': 'claude-code-enhanced' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error('models.dev returned HTTP ' + res.status);
  const raw = await res.json();
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) throw new Error('models.dev returned no providers');
  const compact = compact(raw);
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(compact));
  }
  cache = compact;
  return { ...stat(), source: 'live', updated: Date.now() };
}

/** Strip the fields the UI never reads, keeping the catalog small on disk. */
function compact(raw) {
  const out = {};
  for (const [pid, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    const models = {};
    for (const [mid, m] of Object.entries(p.models || {})) {
      if (!m || typeof m !== 'object') continue;
      models[mid] = {
        id: m.id, name: m.name, limit: m.limit || null,
        reasoning: !!m.reasoning, tool_call: m.tool_call === true, attachment: !!m.attachment,
        modalities: m.modalities || null, cost: m.cost || null,
        release_date: m.release_date || null, knowledge: m.knowledge || null,
        open_weights: !!m.open_weights,
      };
    }
    out[pid] = { id: p.id, name: p.name, env: p.env || null, npm: p.npm || null, api: p.api || null, doc: p.doc || null, models };
  }
  return out;
}

/** One provider entry from models.dev, or null. */
function get(providerId) { return load()[providerId] || null; }

/** One model entry for a provider, or null. */
function model(providerId, modelId) {
  const p = get(providerId);
  if (!p) return null;
  return (p.models && p.models[modelId]) || null;
}

/** All model entries for a provider (array, newest-ish first). */
function modelsFor(providerId) {
  const p = get(providerId);
  if (!p || !p.models) return [];
  return Object.values(p.models);
}

/**
 * Best default model for a provider: prefer tool-call capable, largest context,
 * most recently released. models.dev carries all three.
 */
function bestModel(providerId) {
  const list = modelsFor(providerId);
  if (!list.length) return null;
  const score = (m) => (m.tool_call ? 1e9 : 0) + ((m.limit && m.limit.context) || 0) + (m.release_date ? Date.parse(m.release_date) / 1e6 : 0);
  return list.slice().sort((a, b) => score(b) - score(a))[0];
}

/** Free-text search across every provider's models. */
function searchModels(q, limit = 40) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const cat = load();
  const out = [];
  for (const [pid, p] of Object.entries(cat)) {
    for (const m of Object.values(p.models || {})) {
      if (out.length >= limit) return out;
      if (String(m.id).toLowerCase().includes(needle) || String(m.name).toLowerCase().includes(needle)) {
        out.push({ provider: pid, providerName: p.name, ...m });
      }
    }
  }
  return out;
}

module.exports = { init, load, stat, refresh, compact, get, model, modelsFor, bestModel, searchModels, MODELSDEV_URL };
