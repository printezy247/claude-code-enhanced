// Context-window truth for one provider's model. Single home for
// ENGINE_DEFAULT_WINDOW so chats.js and main.js can never drift apart.
'use strict';
const modelsdev = require('./modelsdev');

/** Chat models are assumed to have this window unless told otherwise. */
const ENGINE_DEFAULT_WINDOW = 200_000;

const contextCache = new Map();

const KNOWN_MODEL_ALIASES = [
  { match: /gemini-(?:1\.5|2\.0|2\.5)-(?:pro|flash)/i, context: 1_000_000 },
  { match: /claude-(?:3|3\.5|3\.7|4)-(?:sonnet|haiku|opus)/i, context: 200_000 },
  { match: /deepseek-(?:r1|v3|chat|coder)/i, context: 128_000 },
  { match: /llama-3\.[123]/i, context: 128_000 },
  { match: /qwen(?:2\.5|3)/i, context: 131_072 },
  { match: /o(?:1|3|4)(?:-mini|-preview)?/i, context: 200_000 },
  { match: /gpt-4o(?:-mini)?/i, context: 128_000 },
  { match: /gpt-4-turbo/i, context: 128_000 },
  { match: /gpt-4-32k/i, context: 32_768 },
  { match: /gpt-4(?:-\d+)?$/i, context: 8_192 },
  { match: /gpt-3\.5-turbo(?:-16k)?/i, context: 16_384 },
  { match: /mistral-(?:large|medium|small|nemo)/i, context: 128_000 },
  { match: /codestral/i, context: 32_768 },
];

/**
 * Context window of a provider's model: models.dev first (dated variants
 * normalized), then the provider's own declared limit, then known model aliases,
 * else 0 — the engine then assumes its default window.
 */
function modelContext(provider, model) {
  const pid = provider && (provider.presetId || provider.modelsDevId || provider.id);
  const id = String(model || (provider && provider.model) || '').trim();
  if (!id) return 0;

  const cacheKey = `${pid || (provider && provider.baseUrl) || ''}:${id}`;
  if (contextCache.has(cacheKey) && contextCache.get(cacheKey) > 0) {
    return contextCache.get(cacheKey);
  }
  if (contextCache.has(id) && contextCache.get(id) > 0) {
    return contextCache.get(id);
  }

  let result = 0;
  if (pid) {
    const cleanId = modelsdev.normalizeModelId ? modelsdev.normalizeModelId(id) : id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const hit = modelsdev.model(pid, id)
      || modelsdev.model(pid, cleanId)
      || modelsdev.model(pid, id.replace(/-\d{4}-\d{2}-\d{2}$/, ''))
      || modelsdev.model(pid, id.toLowerCase())
      || modelsdev.model(pid, cleanId.toLowerCase());
    const catalog = (hit && hit.limit && Number(hit.limit.context)) || 0;
    if (catalog > 0) result = catalog;
  }

  if (!result) {
    const declared = Number(provider && provider.contextWindow) || 0;
    if (declared > 0) result = declared;
  }

  if (!result && provider) {
    for (const m of (Array.isArray(provider.models) ? provider.models : [])) {
      if (!m || typeof m !== 'object' || m.id !== id) continue;
      const c = Number(m.context) || Number(m.ctx) || Number(m.contextWindow)
        || Number(m.limit && m.limit.context) || 0;
      if (c > 0) { result = c; break; }
    }
  }

  if (!result) {
    for (const rule of KNOWN_MODEL_ALIASES) {
      if (rule.match.test(id)) {
        result = rule.context;
        break;
      }
    }
  }

  return result;
}

/**
 * What the catalog says a model can do. Every field is null when the catalog
 * has no entry (or no verdict), and callers then keep their permissive
 * default: only an explicit `false` / a real limit ever changes a request.
 */
function modelCaps(provider, model) {
  const pid = provider && (provider.presetId || provider.modelsDevId || provider.id);
  const id = String(model || (provider && provider.model) || '').trim();
  const none = { reasoning: null, vision: null, tools: null, maxOutput: 0 };
  if (!pid || !id) return none;
  const cleanId = modelsdev.normalizeModelId(id);
  const hit = modelsdev.model(pid, id) || modelsdev.model(pid, cleanId) || modelsdev.model(pid, id.toLowerCase())
    || modelsdev.model(pid, cleanId.toLowerCase());
  if (!hit) return none;
  const inputs = hit.modalities && Array.isArray(hit.modalities.input) ? hit.modalities.input : null;
  return {
    reasoning: typeof hit.reasoning === 'boolean' ? hit.reasoning : null,
    vision: inputs ? inputs.includes('image') : (typeof hit.attachment === 'boolean' ? hit.attachment : null),
    tools: typeof hit.tool_call === 'boolean' ? hit.tool_call : null,
    maxOutput: Number(hit.limit && hit.limit.output) || 0,
  };
}

/** Probe provider's /models endpoint for context window (#A4) */
async function probeContextWindow(provider, model) {
  const id = String(model || (provider && provider.model) || '').trim();
  if (!id) return 0;
  const baseUrl = provider && (provider.baseUrl || '');
  const pid = provider && (provider.presetId || provider.modelsDevId || provider.id || '');
  const cacheKey = `${pid || baseUrl}:${id}`;
  if (contextCache.has(cacheKey)) return contextCache.get(cacheKey);

  if (!baseUrl) return 0;
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const res = await fetch(url);
    if (!res || !res.ok) {
      contextCache.set(cacheKey, 0);
      return 0;
    }
    const json = await res.json();
    const list = Array.isArray(json) ? json : (Array.isArray(json && json.data) ? json.data : []);
    const hit = list.find(m => m && (m.id === id || m.name === id));
    if (hit) {
      const ctx = Number(hit.context_length) || Number(hit.max_context_tokens) || Number(hit.context_window) || 0;
      if (ctx > 0) {
        contextCache.set(cacheKey, ctx);
        contextCache.set(id, ctx);
        return ctx;
      }
    }
    contextCache.set(cacheKey, 0);
    return 0;
  } catch {
    contextCache.set(cacheKey, 0);
    return 0;
  }
}

module.exports = { modelContext, modelCaps, ENGINE_DEFAULT_WINDOW, contextCache, probeContextWindow };
