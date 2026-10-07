// Local-model (Ollama) pre-warm helpers: context probing, memory-aware ctx
// sizing, and model-name resolution. Kept out of main.js so `npm run check`
// can test them against fake servers.
'use strict';

const CCE_CTX_FLOOR = 70000; // claude engine base prompt on this machine ≈ 68.5K
async function ollamaModelCtx(base, model) {
  try {
    const res = await fetch(base.replace(/\/+$/, '') + '/api/show', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const mi = j.model_info || {};
    const key = Object.keys(mi).find(k => k.endsWith('.context_length'));
    return key ? Number(mi[key]) : null;
  } catch { return null; }
}
// Model fields must be a SINGLE slug — a comma-joined list is sent verbatim
// to the provider and rejected as 'invalid model name'.
const sanitizeModel = (m) => String(m || '').split(',')[0].trim();

// KV-cache bytes per token from the model's architecture metadata (f16 cache).
async function ollamaKvBytesPerToken(base, model) {
  try {
    const res = await fetch(base.replace(/\/+$/, '') + '/api/show', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const mi = (await res.json()).model_info || {};
    const pref = [...new Set(Object.keys(mi).map(k => k.split('.')[0]))].find(x => x !== 'general');
    const L = pref && mi[pref + '.block_count'], KV = pref && mi[pref + '.attention.head_count_kv'];
    if (!L || !KV) return null;
    return 2 * Number(L) * Number(KV) * Number(mi[pref + '.attention.key_length'] || 128) * 2;
  } catch { return null; }
}
function memAvailableBytes() {
  try {
    const m = require('fs').readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
    return m ? Number(m[1]) * 1024 : 0;
  } catch { return 0; }
}

// Load a local model into memory at the largest context that actually fits.
// A KV cache larger than free RAM kills the llama runner with HTTP 500
// ('llama-server process has terminated'), so start from a memory-informed
// size and step down until Ollama accepts a load ≥ the engine's context floor.
const warmCtxCache = new Map(); // base|model → ctx that loaded successfully
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
async function warmOllamaModel(base, model, desiredCtx) {
  base = base.replace(/\/+$/, '');
  const resolved0 = model; // original request, for the corrected-model report
  // Resolve the requested name against what the server actually serves:
  // hand-typed names ("loocooperator") become 400 invalid-model errors
  // otherwise. Exact case-insensitive match first, then edit distance ≤3.
  let resolved = model;
  let isOllama = false;
  try {
    const tagsRes = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(8000) });
    if (tagsRes.ok) {
      isOllama = true;
      const names = [...new Set((((await tagsRes.json()).models) || []).map(m => m.name || m.model).filter(Boolean))];
      if (names.length && !names.includes(model)) {
        const ci = names.find(n => n.toLowerCase() === model.toLowerCase());
        if (ci) resolved = ci;
        else {
          let best = null, bestD = 4;
          for (const n of names) {
            const d = editDistance(model.toLowerCase(), n.toLowerCase());
            if (d < bestD) { bestD = d; best = n; }
          }
          if (best) resolved = best;
          else return { ok: false, error: model + ' is not on this server. Available: ' + names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '') };
        }
      }
    }
  } catch { /* tags endpoint absent — non-Ollama server, send the name as-is */ }
  // Only Ollama exposes /api/generate. Every other baseUrl provider (DeepSeek,
  // Kimi, OpenRouter, LM Studio…) 404s below and would wrongly block chat
  // creation with "Ollama could not load <model>".
  if (!isOllama) return { ok: true, skipped: true, model };
  model = resolved;
  const native = await ollamaModelCtx(base, model);
  if (native !== null && native < CCE_CTX_FLOOR) {
    return { ok: false, native, error: model + ' serves only ' + native.toLocaleString() + ' tokens of context — the claude engine base prompt needs ≥' + CCE_CTX_FLOOR.toLocaleString() + '. Load a larger-context model instead.' };
  }
  const cacheKey = base + '|' + model;
  let ctx = Math.max(CCE_CTX_FLOOR, Math.min(desiredCtx || 131072, native || Infinity));
  if (warmCtxCache.has(cacheKey)) {
    ctx = Math.min(ctx, warmCtxCache.get(cacheKey));
  } else {
    // First load this session: pick a starting size from free RAM minus the
    // weights, so we don't burn ~12s per failed oversized attempt.
    try {
      const kv = await ollamaKvBytesPerToken(base, model);
      let weights = 0;
      const tags = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => null);
      weights = (tags && tags.models || []).find(m => m.name === model || m.model === model);
      weights = weights ? Number(weights.size) || 0 : 0;
      const budget = memAvailableBytes() * 0.75 - Math.max(weights, 1024 * 1024 * 1024);
      if (budget > 0) {
        const perTok = kv || 160 * 1024;
        const fit = Math.floor(budget / perTok / 4096) * 4096;
        if (fit >= CCE_CTX_FLOOR) ctx = Math.min(ctx, fit); // only lower, never raise past failures
      }
    } catch { /* estimate unavailable — keep the desired size */ }
  }
  const tried = new Set();
  let lastErr = '';
  while (true) {
    tried.add(ctx);
    try {
      const res = await fetch(base + '/api/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: '30m', stream: false, options: { num_ctx: ctx } }),
        signal: AbortSignal.timeout(300_000),
      });
      if (res.ok) { warmCtxCache.set(cacheKey, ctx); return { ok: true, ctx, native, model, corrected: model !== resolved0 ? model : undefined }; }
      const j = await res.json().catch(() => ({}));
      lastErr = String(j.error || ('HTTP ' + res.status));
    } catch (err) { lastErr = String((err && err.message) || err); }
    const next = Math.floor(ctx * 0.85 / 4096) * 4096;
    if (next >= CCE_CTX_FLOOR && !tried.has(next)) { ctx = next; continue; }
    if (ctx > CCE_CTX_FLOOR && !tried.has(CCE_CTX_FLOOR)) { ctx = CCE_CTX_FLOOR; continue; }
    break;
  }
  warmCtxCache.delete(cacheKey);
  return { ok: false, native, error: 'Ollama could not load ' + model + ' at ≥' + CCE_CTX_FLOOR.toLocaleString() + ' context (' + lastErr + '). Free memory by unloading other models (⚙ models → unload), lower Settings → Local models → num_ctx, or pick a lighter model.' };
}

// Best default for a local provider when nothing is selected: a loaded model
// (any ctx — it's already resident), else the largest-ctx ≥70K model. Without
// this the engine falls back to its own default name (claude-opus-5-5), which
// Ollama rejects with 'invalid model name' on the first turn.
async function pickLocalDefault(base) {
  try {
    base = base.replace(/\/+$/, '');
    const ps = await fetch(base + '/api/ps', { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
    const loaded = new Set(((ps && ps.models) || []).map(m => m.name || m.model).filter(Boolean));
    const tags = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(8000) }).then(r => r.json());
    const names = [...new Set(((tags.models) || []).map(m => m.name || m.model).filter(Boolean))];
    const probed = await Promise.all(names.slice(0, 40).map(async (n) => ({ id: n, ctx: await ollamaModelCtx(base, n) })));
    const viable = probed.filter(m => m.ctx !== null && m.ctx >= CCE_CTX_FLOOR);
    if (!viable.length) return null;
    viable.sort((a, b) => (loaded.has(b.id) ? 1 : 0) - (loaded.has(a.id) ? 1 : 0) || b.ctx - a.ctx);
    return viable[0].id;
  } catch { return null; }
}

module.exports = { CCE_CTX_FLOOR, ollamaModelCtx, sanitizeModel, warmOllamaModel, pickLocalDefault };
