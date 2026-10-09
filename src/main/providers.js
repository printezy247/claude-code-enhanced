// Provider manager.
//
// The claude CLI is provider-agnostic through environment variables:
//   ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY /
//   ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL
// A "provider instance" is a saved set of those values. Secrets are NOT stored
// on the instance any more — they live in the AuthStore (auth.json) keyed by
// uid, and `envFor`/`publicInstance` consult that store.
'use strict';
const crypto = require('crypto');
const catalog = require('./catalog');

let authRef = null;
/** Wire the AuthStore so instances can resolve their secrets. */
function useAuth(auth) { authRef = auth; }

function newUid() { return crypto.randomBytes(6).toString('hex'); }

/** Legacy preset shape (kept so older callers keep working). */
const PRESETS = catalog.CURATED.map(c => ({
  id: c.id, name: c.display || c.name, kind: c.authKind === 'oauth' || c.authKind === 'oauth+api' ? 'oauth' : 'api-key',
  protocol: c.protocol, editableBaseUrl: !!c.editableBaseUrl,
  blurb: c.blurb || '', baseUrl: c.baseUrl || '', authToken: '', apiKey: '',
  model: c.defaultModel || '', smallFastModel: c.defaultSmall || '',
}));

/** The full picker catalog (curated + every models.dev provider). */
function catalogEntries() { return catalog.build(); }

/** Ensure one provider exists on first run (Anthropic sign-in by default). */
function ensureDefaults(store) {
  if (store.providers.length === 0) {
    store.providers = [makeInstance({
      presetId: 'anthropic', name: 'Anthropic',
      baseUrl: '', model: '', smallFastModel: '',
    })];
    store.settings.defaultProviderUid = store.providers[0].uid;
    store.save();
  }
  if (!store.providers.some(p => p.uid === store.settings.defaultProviderUid)) {
    store.settings.defaultProviderUid = store.providers[0].uid;
    store.save();
  }
}

/** Build a fresh instance record from a catalog entry + user values. */
function makeInstance(entry, values = {}) {
  const placeholders = values.placeholders || {};
  const tpl = entry.baseUrlTemplate || entry.baseUrl || '';
  const resolved = entry.baseUrlTemplate ? catalog.resolveTemplate(tpl, placeholders) : tpl;
  return {
    uid: values.uid || newUid(),
    presetId: entry.id,
    name: values.name || entry.display || entry.name || 'Provider',
    protocol: values.protocol || entry.protocol || 'anthropic',
    baseUrl: values.baseUrl !== undefined ? values.baseUrl : resolved,
    keyHeader: values.keyHeader || entry.keyHeader || 'bearer',
    placeholders: entry.baseUrlTemplate ? placeholders : undefined,
    model: values.model || entry.defaultModel || '',
    smallFastModel: values.smallFastModel || entry.defaultSmall || '',
    models: [], blacklist: [], whitelist: [],
    envExtras: {}, headers: {},
    leanTools: null,
    disabled: false,
    alwaysTranslate: entry.protocol !== 'anthropic',
  };
}

/** Merge the catalog entry back onto a saved instance (protocol/headers). */
function entryFor(instance) {
  const e = catalog.byId(instance && instance.presetId);
  return e || null;
}

/** The env a session needs for the selected provider. */
function envFor(instance, settings) {
  const env = {};
  if (!instance) return env;
  const entry = entryFor(instance) || {};
  const protocol = instance.protocol || entry.protocol || 'anthropic';
  if (instance.baseUrl) env.ANTHROPIC_BASE_URL = instance.baseUrl;
  // Native-Anthropic providers carry their own credential in the env; proxied
  // providers get the proxy token instead (set in chats.create).
  if (protocol === 'anthropic') {
    const secret = authRef ? authRef.resolve(instance.uid) : { apiKey: instance.apiKey, authToken: instance.authToken };
    const key = secret.authToken || secret.apiKey || '';
    const header = (instance.keyHeader || entry.keyHeader || 'bearer');
    if (key) {
      if (header === 'x-api-key' || (!secret.authToken && secret.apiKey)) env.ANTHROPIC_API_KEY = key;
      else env.ANTHROPIC_AUTH_TOKEN = key;
    }
  }
  if (instance.model) env.ANTHROPIC_MODEL = instance.model;
  if (instance.smallFastModel) env.ANTHROPIC_SMALL_FAST_MODEL = instance.smallFastModel;
  if (instance.envExtras) {
    for (const [k, v] of Object.entries(instance.envExtras)) {
      if (/^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string') env[k] = v;
    }
  }
  if (settings && settings.disableTelemetry) {
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    env.DISABLE_AUTOUPDATER = '1';
  }
  return env;
}

/** Secret-free view of a provider for the renderer. */
function publicInstance(p) {
  const entry = entryFor(p) || {};
  const auth = authRef ? authRef.summary(p.uid) : {
    present: !!(p.apiKey || p.authToken), type: p.authToken ? 'api' : (p.apiKey ? 'api' : null),
    hint: p.apiKey ? p.apiKey.slice(0, 6) + '\u2026' + p.apiKey.slice(-4) : (p.authToken ? 'set' : ''),
  };
  return {
    uid: p.uid,
    presetId: p.presetId,
    name: p.name,
    display: entry.display || p.name,
    protocol: p.protocol || entry.protocol || 'anthropic',
    authKind: p.authKind || entry.authKind || (auth.type === 'oauth' ? 'oauth' : 'api-key'),
    baseUrl: p.baseUrl || '',
    placeholders: p.placeholders || undefined,
    modelsDevId: entry.modelsDevId || entry.id || p.presetId,
    envVar: entry.envVar || null,
    docsUrl: entry.docsUrl || '',
    model: p.model || '',
    smallFastModel: p.smallFastModel || '',
    options: p.options || {},
    headers: p.headers || {},
    models: Array.isArray(p.models) ? p.models : [],
    blacklist: Array.isArray(p.blacklist) ? p.blacklist : [],
    whitelist: Array.isArray(p.whitelist) ? p.whitelist : [],
    disabled: !!p.disabled,
    envExtras: p.envExtras || {},
    leanTools: Array.isArray(p.leanTools) ? p.leanTools : null,
    alwaysTranslate: p.alwaysTranslate !== false,
    capabilities: entry.capabilities || [],
    local: !!entry.local,
    // auth summary (never the secret)
    hasAuth: !!auth.present,
    authType: auth.type || null,
    authHint: auth.hint || '',
    authExpires: auth.expires || 0,
    authExpired: !!auth.expired,
  };
}

/** One-off fixes for base URLs shipped wrong in earlier presets. */
function migrateUrls(store) {
  let changed = false;
  for (const p of store.providers) {
    // NaraRouter shipped a dead domain; the live API is router.bynara.id.
    if (p.presetId === 'nararouter' && /nararouter\.com/.test(p.baseUrl || '')) {
      p.baseUrl = 'https://router.bynara.id/v1';
      changed = true;
    }
    // AgentRouter's OpenAI gateway rejects non-allowlisted clients; the
    // Anthropic route (which the claude engine speaks natively) is the one
    // that works, so convert the broken OpenAI-route instances.
    if (p.presetId === 'agentrouter' && (p.protocol || 'openai') === 'openai') {
      p.protocol = 'anthropic';
      p.baseUrl = 'https://agentrouter.org';
      p.keyHeader = 'x-api-key';
      if (!/^claude/i.test(p.model || '')) p.model = 'claude-opus-5';
      if (!/^claude/i.test(p.smallFastModel || '')) p.smallFastModel = 'claude-opus-5';
      p.alwaysTranslate = false;
      changed = true;
    }
  }
  if (changed) store.save();
  return changed;
}

/** One-shot model pinning the user explicitly requested (runs once per flag). */
function migrateModels(store) {
  store.settings.appliedFixes ??= {};
  const flags = store.settings.appliedFixes;
  let changed = false;
  for (const p of store.providers) {
    // NaraRouter: pin the 9 free models as the picker's whitelist + default.
    if (p.presetId === 'nararouter' && !flags.naraModels) {
      const entry = catalog.byId('nararouter');
      const list = (entry && entry.recommendedModels) || [];
      if (list.length) {
        p.models = list.slice();
        p.whitelist = list.slice();
        if (!p.model) p.model = list[0];
        changed = true;
      }
      flags.naraModels = true;
    }
    // AgentRouter: single model only.
    if ((p.presetId === 'agentrouter' || p.presetId === 'agentrouter-anthropic') && !flags.agentModel) {
      p.model = 'deepseek-v4-flash';
      if (!p.smallFastModel || p.smallFastModel === 'gpt-5.6-sol' || p.smallFastModel === 'claude-opus-5') {
        p.smallFastModel = 'deepseek-v4-flash';
      }
      changed = true;
      flags.agentModel = true;
    }
  }
  if (changed) store.save();
  return changed;
}

module.exports = {
  PRESETS, ensureDefaults, envFor, publicInstance, newUid,
  useAuth, catalogEntries, makeInstance, entryFor,
  migrateUrls, migrateModels,
};
