// Context-window truth for one provider's model. Single home for
// ENGINE_DEFAULT_WINDOW so chats.js and main.js can never drift apart.
'use strict';
const modelsdev = require('./modelsdev');

/** Chat models are assumed to have this window unless told otherwise. */
const ENGINE_DEFAULT_WINDOW = 200_000;

/**
 * Context window of a provider's model: models.dev first (dated variants
 * like qwen3.5-plus-2026-02-15 fall back to the undated entry), then the
 * provider's own declared limit, else 0 — the engine then assumes its
 * default window.
 */
function modelContext(provider, model) {
  const pid = provider && provider.presetId;
  const id = String(model || (provider && provider.model) || '');
  if (!pid || !id) return 0;
  const hit = modelsdev.model(pid, id) || modelsdev.model(pid, id.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
  const catalog = (hit && hit.limit && Number(hit.limit.context)) || 0;
  if (catalog > 0) return catalog;
  // Provider-declared: instance-level window, then its model list entry
  // (live listings carry ctx; hand-declared objects may use context).
  const declared = Number(provider.contextWindow) || 0;
  if (declared > 0) return declared;
  for (const m of (Array.isArray(provider.models) ? provider.models : [])) {
    if (!m || typeof m !== 'object' || m.id !== id) continue;
    const c = Number(m.context) || Number(m.ctx) || Number(m.contextWindow)
      || Number(m.limit && m.limit.context) || 0;
    if (c > 0) return c;
  }
  return 0;
}

module.exports = { modelContext, ENGINE_DEFAULT_WINDOW };
