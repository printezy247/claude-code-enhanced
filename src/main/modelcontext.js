// Context-window truth for one provider's model. Single home for
// ENGINE_DEFAULT_WINDOW so chats.js and main.js can never drift apart.
'use strict';
const modelsdev = require('./modelsdev');

/** Chat models are assumed to have this window unless told otherwise. */
const ENGINE_DEFAULT_WINDOW = 200_000;

const contextCache = new Map();
// A probe that failed (timeout, 401, a gateway with no /models) is remembered
// for a few minutes, not for the life of the app: the key may be fixed or the
// network back a moment later.
const PROBE_FAIL_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const probeFailures = new Map();

// First match wins, so a specific family comes before the general one. Where
// the window differs across a family the lower figure is used: claiming more
// than a model has stops compaction from firing before the provider errors.
const KNOWN_MODEL_ALIASES = [
  { match: /gemini-(?:1\.5|2\.0|2\.5|3(?:\.\d)?)-(?:pro|flash)/i, context: 1_000_000 },
  { match: /claude-(?:3|3\.5|3\.7|4)-(?:sonnet|haiku|opus)/i, context: 200_000 },
  { match: /claude-(?:sonnet|haiku|opus)-[45]/i, context: 200_000 },
  { match: /deepseek-(?:r1|v3|v4|chat|coder|reasoner)/i, context: 128_000 },
  { match: /llama-4/i, context: 1_000_000 },
  { match: /llama-3\.[123]/i, context: 128_000 },
  { match: /qwen3?-coder/i, context: 262_144 },
  { match: /qwen(?:2\.5|3)/i, context: 131_072 },
  { match: /kimi-k2/i, context: 131_072 },
  { match: /glm-4\.[5-9]/i, context: 131_072 },
  { match: /gpt-oss/i, context: 131_072 },
  { match: /grok-4/i, context: 256_000 },
  { match: /grok-3/i, context: 131_072 },
  { match: /gpt-5/i, context: 400_000 },
  { match: /gpt-4\.1/i, context: 1_047_576 },
  { match: /(?:^|[/:])o(?:1|3|4)(?:-mini|-pro|-preview)?(?:$|-\d)/i, context: 200_000 },
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
  const none = { reasoning: null, vision: null, tools: null, temperature: null, maxOutput: 0 };
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
    temperature: typeof hit.temperature === 'boolean' ? hit.temperature : null,
    maxOutput: Number(hit.limit && hit.limit.output) || 0,
  };
}

/**
 * Reasoning-effort levels a model accepts, like OpenCode's per-model
 * "variants": empty means the model has no effort setting and the picker is
 * hidden. A provider can pin its own list with `effortLevels`.
 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function effortLevels(provider, model) {
  const own = provider && Array.isArray(provider.effortLevels)
    ? provider.effortLevels.map(String).filter((e) => EFFORT_ORDER.includes(e)) : null;
  if (own && own.length) return own;
  const caps = modelCaps(provider, model);
  if (caps.reasoning === false) return [];
  const base = String((provider && provider.baseUrl) || '');
  if (!base || /(^|\.)anthropic\.com/i.test(base)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/generativelanguage\.googleapis\.com/i.test(base) || (provider && provider.protocol === 'gemini')) return ['low', 'high'];
  // Anything else: only a model the catalog marks as reasoning has levels.
  // A local or uncatalogued model reports nothing, so the control stays away.
  return caps.reasoning === true ? ['low', 'medium', 'high'] : [];
}

/** Probe provider's /models endpoint for context window (#A4) */
async function probeContextWindow(provider, model) {
  const id = String(model || (provider && provider.model) || '').trim();
  if (!id) return 0;
  const baseUrl = provider && (provider.baseUrl || '');
  const pid = provider && (provider.presetId || provider.modelsDevId || provider.id || '');
  const cacheKey = `${pid || baseUrl}:${id}`;
  if (contextCache.get(cacheKey) > 0) return contextCache.get(cacheKey);
  const failedAt = probeFailures.get(cacheKey);
  if (failedAt && Date.now() - failedAt < PROBE_FAIL_TTL_MS) return 0;

  if (!baseUrl) return 0;
  const fail = () => { probeFailures.set(cacheKey, Date.now()); return 0; };
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const res = await fetch(url, { headers: probeHeaders(provider, baseUrl), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res || !res.ok) return fail();
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
    return fail();
  } catch {
    return fail();
  }
}

/**
 * Headers for a provider's /models listing. Gated endpoints answer 401 without
 * the provider's key, and each family spells the key differently: Anthropic
 * wants x-api-key plus a version, Google its own header, the rest a bearer.
 */
function probeHeaders(provider, baseUrl) {
  const headers = { accept: 'application/json' };
  const key = provider && provider.apiKey;
  const anthropic = /(^|\.)anthropic\.com/i.test(baseUrl) || (provider && provider.protocol === 'anthropic');
  if (key) {
    if (/generativelanguage\.googleapis\.com/i.test(baseUrl) || (provider && provider.keyHeader === 'x-goog-api-key')) headers['x-goog-api-key'] = key;
    else if (provider && provider.keyHeader === 'bearer') headers.Authorization = 'Bearer ' + key;
    else if ((provider && provider.keyHeader === 'x-api-key') || anthropic) headers['x-api-key'] = key;
    else headers.Authorization = 'Bearer ' + key;
  }
  if (anthropic) headers['anthropic-version'] = '2023-06-01';
  if (provider && provider.headers && typeof provider.headers === 'object') Object.assign(headers, provider.headers);
  return headers;
}

/**
 * Sampling defaults a model family does best with, when the client sent none.
 * A provider can pin its own with `temperature` / `topP`. Reasoning models
 * that reject sampling (catalog temperature:false, DeepSeek-R1) get nothing.
 */
const SAMPLING_DEFAULTS = [
  { match: /deepseek[-_/]?r1|deepseek-reasoner/i, none: true },
  { match: /qwen/i, temperature: 0.55, top_p: 1 },
  { match: /gemini/i, temperature: 1.0 },
];
function samplingDefaults(provider, model) {
  const out = {};
  const id = String(model || (provider && provider.model) || '');
  const own = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const ownT = own(provider && provider.temperature);
  const ownP = own(provider && provider.topP);
  if (ownT != null) out.temperature = ownT;
  if (ownP != null) out.top_p = ownP;
  if (ownT != null && ownP != null) return out;
  const row = SAMPLING_DEFAULTS.find((r) => r.match.test(id));
  if (!row || row.none) return out;
  if (out.temperature == null && row.temperature != null) out.temperature = row.temperature;
  if (out.top_p == null && row.top_p != null) out.top_p = row.top_p;
  return out;
}

function clearProbeFailures() { probeFailures.clear(); }

module.exports = { probeHeaders, clearProbeFailures, PROBE_FAIL_TTL_MS, samplingDefaults, SAMPLING_DEFAULTS, modelContext, modelCaps, effortLevels, ENGINE_DEFAULT_WINDOW, contextCache, probeContextWindow };
