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

module.exports = { modelContext, ENGINE_DEFAULT_WINDOW, contextCache };
