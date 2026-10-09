// Unified local-runtime manager.
//
// Ollama, LM Studio, llama.cpp's llama-server and vLLM each expose a different
// API for the same idea: list models, load one, free its memory. This module
// normalises them so the model-manager UI works against any of them, and it can
// scan the usual ports so a running server is discovered automatically.
'use strict';
const { ollamaModelCtx } = require('./localmodels');

const LOCAL_CANDIDATES = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  { id: 'ollama-alt', name: 'Ollama (:11435)', baseUrl: 'http://127.0.0.1:11435' },
];

const jget = async (url, timeout = 2500, opts = {}) => {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
};

/** Which runtime is at this base URL? 'ollama' | 'openai' | null. */
async function detect(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  try { await jget(base + '/api/tags', 2000); return 'ollama'; } catch { /* not ollama */ }
  try { await jget(base + '/models', 2000); return 'openai'; } catch { /* not openai */ }
  return null;
}

/** Scan the well-known local ports; returns the servers that answered. */
async function scan(extra = []) {
  const candidates = [...LOCAL_CANDIDATES, ...extra.filter(Boolean)];
  const seen = new Set();
  const found = [];
  await Promise.all(candidates.map(async (c) => {
    const base = String(c.baseUrl).replace(/\/+$/, '');
    if (seen.has(base)) return;
    const runtime = await detect(base);
    if (!runtime) return;
    if (seen.has(base)) return;
    seen.add(base);
    let modelCount = 0;
    try {
      const info = await list(base);
      modelCount = (info.available || []).length;
    } catch { /* count stays 0 */ }
    found.push({ id: c.id, name: c.name, baseUrl: base, runtime, ok: true, modelCount });
  }));
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Normalised model list: {runtime, loaded:[...], available:[...]}. */
async function list(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const runtime = await detect(base);
  if (runtime === 'ollama') {
    const [ps, tags] = await Promise.all([
      jget(base + '/api/ps', 4000).catch(() => ({ models: [] })),
      jget(base + '/api/tags', 6000).catch(() => ({ models: [] })),
    ]);
    const loaded = (ps.models || []).map(m => ({
      name: m.name || m.model, sizeVram: m.size_vram || m.size || 0, expires: m.expires_at || null,
    }));
    const loadedNames = new Set(loaded.map(m => m.name));
    const available = await Promise.all((tags.models || []).map(async (m) => {
      const name = m.name || m.model;
      const d = m.details || {};
      return {
        name, size: m.size || 0, ctx: await ollamaModelCtx(base, name),
        paramSize: d.parameter_size || '', quant: d.quantization_level || '',
        loaded: loadedNames.has(name), family: d.family || '',
      };
    }));
    available.sort((a, b) => a.name.localeCompare(b.name));
    return { runtime, loaded, available };
  }
  if (runtime === 'openai') {
    const j = await jget(base + '/models', 6000);
    const available = (j.data || []).map(m => ({
      name: m.id, size: 0, ctx: m.context_length || m.max_model_len || null,
      paramSize: '', quant: '', loaded: true,
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { runtime, loaded: available.map(a => ({ name: a.name, sizeVram: 0, expires: null })), available };
  }
  throw new Error('no local runtime at ' + baseUrl);
}

/** Load or unload a model. OpenAI-compatible servers load on demand. */
async function manage(baseUrl, { model, action, numCtx, keepAlive }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const runtime = await detect(base);
  if (runtime !== 'ollama') {
    // Nothing to do: these runtimes load the model on first inference and keep
    // it according to their own settings.
    if (action === 'unload') return { ok: false, unsupported: true, error: 'This runtime unloads models on its own — restart it to free memory.' };
    return { ok: true, delegated: true };
  }
  const body = { model, prompt: '', stream: false, keep_alive: action === 'unload' ? 0 : (keepAlive === -1 ? -1 : (keepAlive || '30m')) };
  if (numCtx && action !== 'unload') body.options = { num_ctx: Number(numCtx) };
  const res = await fetch(base + '/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(action === 'unload' ? 30_000 : 300_000),
  });
  return { ok: res.ok, status: res.status, runtime };
}

module.exports = { LOCAL_CANDIDATES, detect, scan, list, manage };
