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
const modelsdev = require('./modelsdev');
const oauth = require('./oauth');

let authRef = null;
/** Wire the AuthStore so instances can resolve their secrets. */
function useAuth(auth) { authRef = auth; }
let refreshSecretCacheFn = null;
/** Wire the main-process refreshSecretCache so ensureFreshAuth can rebuild the proxy cache. */
function setRefreshSecretCache(fn) { refreshSecretCacheFn = fn; }

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

function normalizeBaseUrl(baseUrl, protocol) {
  let b = String(baseUrl || '').trim();
  if (!b) return '';
  // Reject non-http(s) schemes outright.
  if (/^[a-z][a-z0-9+.\-]*:/i.test(b) && !/^https?:\/\//i.test(b)) return '';
  b = b.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) {
    b = (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(b) ? 'http://' : 'https://') + b;
  }
  const proto = protocol || 'openai';
  const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(b);
  if (proto === 'openai' && !local && !/\/v1$/i.test(b)) {
    // Curated hosts that need the segment added even though they carry a path.
    if (/api\.openai\.com$/i.test(b) || /openrouter\.ai\/api$/i.test(b) || /api\.groq\.com\/openai$/i.test(b)) {
      b += '/v1';
    } else {
      // Bare host or host with no real path: ensure /v1.
      try {
        const u = new URL(b);
        if (u.pathname === '/' || u.pathname === '') b += '/v1';
      } catch { /* leave as-is */ }
    }
  }
  return b;
}

/** Build a fresh instance record from a catalog entry + user values. */
function makeInstance(entry, values = {}) {
  const placeholders = values.placeholders || {};
  const tpl = entry.baseUrlTemplate || entry.baseUrl || '';
  const resolved = entry.baseUrlTemplate ? catalog.resolveTemplate(tpl, placeholders) : tpl;
  const proto = values.protocol || entry.protocol || 'anthropic';
  const rawBase = values.baseUrl !== undefined ? values.baseUrl : resolved;
  return {
    uid: values.uid || newUid(),
    presetId: entry.id,
    name: values.name || entry.display || entry.name || 'Provider',
    protocol: proto,
    baseUrl: normalizeBaseUrl(rawBase, proto),
    keyHeader: values.keyHeader || entry.keyHeader || 'bearer',
    placeholders: entry.baseUrlTemplate ? placeholders : undefined,
    model: values.model || entry.defaultModel || '',
    smallFastModel: values.smallFastModel || entry.defaultSmall || '',
    // A provider may name the model it falls back to when the main one is
    // missing or overloaded. Declared here so it is persisted with the
    // instance and editable in the provider UI. #A6
    fallbackModel: values.fallbackModel !== undefined ? values.fallbackModel : (entry.fallbackModel || ''),
    envVar: (values.envVar !== undefined) ? values.envVar : (entry.envVar || null),
    models: values.models ? values.models.slice() : (entry.recommendedModels || []).slice(), blacklist: [], whitelist: [],
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

/**
 * The API key for a provider, from the auth store, else from the environment
 * variable its catalog entry names.
 *
 * models.dev records an env var for API-key providers (OpenCode Go's preset
 * declares OPENCODE_API_KEY). CCE never read it, so a provider configured
 * without a pasted key went upstream with no credential at all and the gateway
 * answered "Go requires a credential". The stored key still wins, so an
 * explicit key in the app overrides the environment.
 *
 * @param {object} instance the provider instance
 * @param {object} [auth] the auth store (injected so tests can drive it)
 * @param {object} [env] the environment to read (defaults to process.env)
 */
function envVarNames(instance) {
  if (!instance) return [];
  const entry = entryFor(instance) || {};
  // The models.dev id is not always the catalog id (the kimi preset is
  // moonshotai on models.dev), so the entry's own modelsDevId wins; the
  // preset id is only the last resort.
  const mdId = instance.modelsDevId || entry.modelsDevId || instance.presetId;
  const md = modelsdev.get(mdId);
  const names = [
    // An env var the user named explicitly is taken at face value.
    instance.envVar,
    entry.envVar,
    // The discovered lists are filtered: models.dev mixes configuration
    // values (AZURE_RESOURCE_NAME, GOOGLE_VERTEX_PROJECT) in with the secret,
    // and one of those sent as a bearer token looks like a bad key.
    ...catalog.secretEnvNames(entry.env),
    ...catalog.secretEnvNames(md && md.env),
  ].filter(Boolean);
  return [...new Set(names)];
}

function resolveApiKey(instance, auth, env) {
  const store = auth || authRef;
  const fromStore = store ? store.resolve(instance.uid) : {};
  if (fromStore.apiKey) return fromStore.apiKey;
  if (fromStore.authToken) return '';
  const names = envVarNames(instance);
  if (!names.length) return '';
  const source = env || process.env;
  for (const name of names) {
    if (source[name]) return String(source[name]).trim();
  }
  return '';
}

/**
 * A cheap tool-capable model from the catalog for a provider that names no
 * small-fast model (flash / mini / haiku / lite / nano), lowest input price
 * first. Third-party providers only: a Claude login keeps the engine default.
 */
function catalogSmallModel(instance) {
  try {
    const pid = instance && (instance.presetId || instance.modelsDevId);
    if (!pid || /(^|\.)anthropic\.com/i.test(String(instance.baseUrl || ''))) return '';
    const list = modelsdev.modelsFor(pid).filter((m) => m && m.tool_call && /(flash|mini|haiku|lite|nano|small)/i.test(m.id) && !/(embed|image|tts|audio|live)/i.test(m.id));
    if (!list.length) return '';
    const price = (m) => (m.cost && Number(m.cost.input)) || 1e9;
    return list.slice().sort((a, b) => price(a) - price(b))[0].id;
  } catch { return ''; }
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
    } else if (instance.baseUrl && (entry.keyOptional || entry.local)) {
      // Keyless local server (Ollama ignores the value). Without any token the
      // engine falls back to its saved Claude.ai login and reports an expired
      // OAuth session instead of talking to the local server.
      env.ANTHROPIC_AUTH_TOKEN = 'local-no-key';
      env.ANTHROPIC_API_KEY = '';
    }
  }
  if (instance.model) env.ANTHROPIC_MODEL = instance.model;
  const small = instance.smallFastModel || catalogSmallModel(instance);
  if (small) env.ANTHROPIC_SMALL_FAST_MODEL = small;
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
    keyHeader: p.keyHeader || entry.keyHeader || 'bearer',
    placeholders: p.placeholders || undefined,
    modelsDevId: entry.modelsDevId || entry.id || p.presetId,
    envVar: p.envVar || entry.envVar || null,
    docsUrl: entry.docsUrl || '',
    model: p.model || '',
    smallFastModel: p.smallFastModel || entry.defaultSmall || '',
    // The model this provider falls back to: the instance's own choice, then
    // the catalog's. Never a secret, so it travels to the renderer freely. #A6
    fallbackModel: p.fallbackModel || entry.fallbackModel || '',
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
    authExpired: !!auth.expired || !!p.authExpired || !!(auth.expires && auth.expires < Date.now()),
  };
}

/** One-off fixes for base URLs shipped wrong in earlier presets. */
function migrateUrls(store) {
  let changed = false;
  for (const p of store.providers) {
    // General normalization: strip trailing slash, ensure scheme, add /v1 for
    // openai-compat providers that are missing it. Idempotent.
    const norm = normalizeBaseUrl(p.baseUrl, p.protocol);
    if (norm && norm !== p.baseUrl) { p.baseUrl = norm; changed = true; }
    // NaraRouter shipped a dead domain; the live API is router.bynara.id.
    if (p.presetId === 'nararouter' && /nararouter\.com/.test(p.baseUrl || '')) {
      p.baseUrl = 'https://router.bynara.id/v1';
      changed = true;
    }
    // AgentRouter's OpenAI gateway rejects non-allowlisted clients; the
    // Anthropic route (which the claude engine speaks natively) is the one
    // that works, so convert the broken OpenAI-route instances.
    // A non-Claude model (e.g. deepseek-v4-flash) was chosen on purpose and
    // lives on the OpenAI route, so leave those instances alone.
    if (p.presetId === 'agentrouter' && (p.protocol || 'openai') === 'openai' && (!p.model || /^claude/i.test(p.model))) {
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
    // NaraRouter: the first pin shipped a typo ('exo-stealh') and missed one
    // free model. Re-sync once, keeping any user-added ids.
    if (p.presetId === 'nararouter' && !flags.naraModelsV2) {
      const list = ((catalog.byId('nararouter') || {}).recommendedModels || []);
      const fix = (arr) => {
        const out = (arr || []).map(id => id === 'exo-stealh' ? 'exo-stealth' : id);
        if (out.length) for (const id of list) if (!out.includes(id)) out.push(id);
        return out;
      };
      p.models = fix(p.models); p.whitelist = fix(p.whitelist);
      changed = true;
    }
    // AgentRouter: single model only.
    if (p.presetId === 'agentrouter' && !flags.agentModel) {
      p.model = 'deepseek-v4-flash';
      if (!p.smallFastModel || p.smallFastModel === 'gpt-5.6-sol' || p.smallFastModel === 'claude-opus-5') {
        p.smallFastModel = 'deepseek-v4-flash';
      }
      changed = true;
      flags.agentModel = true;
    }
    // Google AI Studio: the first preset shipped a model id that 404s and a pro
    // default with no free-tier quota. Swap those two, once; leave other picks.
    if ((p.presetId === 'google' || p.presetId === 'google-native') && !flags.googleModels) {
      if (p.smallFastModel === 'gemini-3.1-flash') { p.smallFastModel = 'gemini-3.5-flash-lite'; changed = true; }
      if (p.model === 'gemini-3.1-pro-preview') { p.model = 'gemini-3.5-flash'; changed = true; }
    }
  }
  flags.googleModels = true;
  // 128K was the old default; it needs ~14 GB for a 4B model and swaps a 16 GB
  // machine to a crawl. One-time move to the 72K default (users can re-pick).
  if (!flags.localCtx72k) {
    if (Number(store.settings.localNumCtx) === 131072) { store.settings.localNumCtx = 73728; changed = true; }
    flags.localCtx72k = true;
    changed = true;
  }
  flags.naraModelsV2 = true;
  if (changed) store.save();
  return changed;
}

/**
 * A key that cannot work at this base URL, explained. Xiaomi MiMo issues two
 * kinds of key: pay-as-you-go `sk-` keys for api.xiaomimimo.com and Token Plan
 * `tp-` keys for the token-plan-<region> hosts; each is a 401 on the other.
 * @returns {string} what to change, or '' when nothing is known to be wrong
 */
function keyUrlMismatch(baseUrl, key) {
  const base = String(baseUrl || '').trim();
  const k = String(key || '').trim();
  if (!k || !base) return '';

  // Xiaomi MiMo
  if (/xiaomimimo\.com/i.test(base)) {
    const tokenPlanHost = /token-plan-/i.test(base);
    if (/^tp-/i.test(k) && !tokenPlanHost) {
      return 'This is a Xiaomi Token Plan key (tp-…), but the base URL is the pay-as-you-go one. '
        + 'In Edit, set the URL to the Token Plan base URL shown on your Token Plan page, '
        + 'e.g. https://token-plan-cn.xiaomimimo.com/v1 (other regions: token-plan-sgp, token-plan-ams).';
    }
    if (/^sk-/i.test(k) && tokenPlanHost) {
      return 'This is a Xiaomi pay-as-you-go key (sk-…), but the base URL is a Token Plan one. '
        + 'In Edit, set the URL to https://api.xiaomimimo.com/v1, or paste your tp-… Token Plan key instead.';
    }
  }

  // Trailing slash or double slash in the base URL
  const hasTrailingSlash = /\/$/.test(base);
  const hasDoubleSlash = /\/\/[^/]/.test(base.replace(/^https?:\/\//i, ''));
  if (hasTrailingSlash || hasDoubleSlash) {
    return 'The base URL has a trailing slash or a double slash (' + base + '). Remove the extra slash so requests resolve to the right path.';
  }

  // OpenAI-style base URL missing the /v1 path segment (Azure uses /openai/deployments, not /v1)
  if (/openai\.com|openrouter|groq|deepseek/i.test(base) && !/\/v1(\/|$)/i.test(base)) {
    return 'The base URL is missing the /v1 path segment (' + base + '). Add /v1, e.g. ' + base.replace(/\/+$/, '') + '/v1.';
  }

  // Google key passed as a query parameter instead of a header
  if (/[\?&]key=/i.test(base)) {
    return 'A Google API key must be sent as a header (Authorization: Bearer or x-goog-api-key), not as a ?key= query parameter. Remove ?key= from the base URL.';
  }

  // Azure resource missing deployments
  if (/openai\.azure\.com/i.test(base) && !/deployments/i.test(base)) {
    return 'Azure OpenAI endpoints require a deployment path, e.g. https://<resource>.openai.azure.com/openai/deployments/<deployment>.';
  }

  // Azure base URL whose resource name does not match the key
  if (/openai\.azure\.com/i.test(base) && /deployments/i.test(base)) {
    const m = base.match(/https?:\/\/([^.]+)\.openai\.azure\.com/i);
    const resource = m ? m[1] : '';
    const azureKeyShape = /^[0-9a-f]{32}$/i.test(k);
    if (resource && !azureKeyShape) {
      return 'The Azure resource name in the base URL (' + resource + ') does not match the key. Use the API key from the same Azure resource.';
    }
  }

  // Anthropic key on non-Anthropic OpenAI-style host
  if (/^sk-ant-/i.test(k) && /api\.openai\.com|azure\.com|groq\.com|deepseek\.com/i.test(base)) {
    return 'This appears to be an Anthropic API key (sk-ant-…), but the provider URL points to ' + base + '. '
      + 'Use the official Anthropic provider or set the base URL to https://api.anthropic.com.';
  }

  // OpenAI project key on Anthropic host
  if (/^sk-proj-/i.test(k) && /api\.anthropic\.com/i.test(base)) {
    return 'This appears to be an OpenAI project key (sk-proj-…), but the base URL is Anthropic. '
      + 'Set the base URL to https://api.openai.com/v1 and protocol to OpenAI.';
  }

  // Google API key on non-Google host
  if (/^AIzaSy/i.test(k) && /api\.openai\.com|api\.anthropic\.com/i.test(base)) {
    return 'This appears to be a Google API key (AIzaSy…), but the provider is pointed at an Anthropic or OpenAI host. '
      + 'Connect Google AI Studio via Providers → Connect or set the base URL to https://generativelanguage.googleapis.com.';
  }

  return '';
}

/**
 * Clean the model fields of a provider save, touching only the ones sent.
 * Partial saves (the enable/disable toggle, the Models and Advanced tabs) used
 * to blank both models, so a provider lost its default and its chats fell back
 * to whatever ~/.claude/settings.json pins (e.g. "sonnet"), which a
 * third-party provider does not serve.
 */
function normalizeModelFields(instance) {
  const one = (m) => String(m || '').split(',')[0].trim();
  if ('model' in instance) instance.model = one(instance.model);
  if ('smallFastModel' in instance) instance.smallFastModel = one(instance.smallFastModel);
  if ('fallbackModel' in instance) instance.fallbackModel = one(instance.fallbackModel);
  return instance;
}

/**
 * The model a chat asks for when none was picked. A provider with no default
 * would otherwise inherit the engine's own default (the "model" in
 * ~/.claude/settings.json), a Claude name a third-party provider does not
 * serve; its first listed model is the better guess.
 */
function chatModelFor(instance, picked) {
  if (picked) return picked;
  if (!instance) return '';
  if (instance.model) return instance.model;
  const thirdParty = !!instance.baseUrl && !/(^|\.)anthropic\.com/i.test(String(instance.baseUrl));
  if (!thirdParty) return '';
  return (instance.whitelist && instance.whitelist[0]) || (instance.models && instance.models[0]) || '';
}

/**
 * Refresh an OAuth provider's token if it is expired (or about to). Copilot
 * short-lived tokens are re-minted from the long-lived GitHub token. A failed
 * refresh is retried once with backoff; it never throws, marks the provider
 * `authExpired`, and leaves a still-valid stored token untouched.
 */
const refreshFlights = new Map();   // uid -> in-flight refresh (single-flight)
function ensureFreshAuth(inst, authOrDeps, oauthModOverride) {
  if (!inst || !inst.uid) return Promise.resolve();
  const live = refreshFlights.get(inst.uid);
  if (live) return live;
  const p = ensureFreshAuthOnce(inst, authOrDeps, oauthModOverride)
    .finally(() => refreshFlights.delete(inst.uid));
  refreshFlights.set(inst.uid, p);
  return p;
}

async function ensureFreshAuthOnce(inst, authOrDeps, oauthModOverride) {
  let auth = authOrDeps;
  let oauthMod = oauthModOverride;
  let refreshSecretCache = refreshSecretCacheFn;
  if (authOrDeps && typeof authOrDeps.get !== 'function') {
    const deps = authOrDeps || {};
    auth = deps.auth || authRef;
    oauthMod = deps.oauth || oauthMod;
    if (typeof deps.refreshSecretCache === 'function') refreshSecretCache = deps.refreshSecretCache;
  }
  auth = auth || authRef;
  oauthMod = oauthMod || oauth;
  if (!inst) return;
  const rec = auth ? auth.get(inst.uid) : null;
  if (!rec || rec.type !== 'oauth') return;
  const soon = !!(rec.expires && rec.expires - Date.now() < 120_000);
  if (!soon && !rec.expired) return;
  const entry = entryFor(inst) || {};
  const cfg = entry.oauth || {};

  const doRefresh = async () => {
    if (cfg.exchange === 'copilot' || (rec.meta && rec.meta.copilot)) {
      return await oauthMod.refreshCopilot(rec.refresh);
    } else if (rec.refresh && cfg.tokenUrl) {
      return await oauthMod.refreshTokens(cfg, rec.refresh);
    }
    return null;
  };

  try {
    const tokens = await doRefresh();
    if (!tokens) return;
    auth.setOAuth(inst.uid, {
      access: tokens.access,
      refresh: tokens.refresh || rec.refresh,
      expires: tokens.expires,
      meta: { ...rec.meta, ...(tokens.meta || {}), expired: false },
    });
    inst.authExpired = false;
    if (typeof refreshSecretCache === 'function') refreshSecretCache();
  } catch (err) {
    // Retry once with exponential backoff (600ms -> 1200ms) so a transient
    // token-service blip does not immediately burn a second request.
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const tokens = await doRefresh();
      if (tokens) {
        auth.setOAuth(inst.uid, {
          access: tokens.access,
          refresh: tokens.refresh || rec.refresh,
          expires: tokens.expires,
          meta: { ...rec.meta, ...(tokens.meta || {}), expired: false },
        });
        inst.authExpired = false;
        if (typeof refreshSecretCache === 'function') refreshSecretCache();
        return;
      }
    } catch { /* second attempt failed */ }
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const tokens = await doRefresh();
      if (tokens) {
        auth.setOAuth(inst.uid, {
          access: tokens.access,
          refresh: tokens.refresh || rec.refresh,
          expires: tokens.expires,
          meta: { ...rec.meta, ...(tokens.meta || {}), expired: false },
        });
        inst.authExpired = false;
        if (typeof refreshSecretCache === 'function') refreshSecretCache();
        return;
      }
    } catch { /* third attempt failed */ }

    console.error('[auth] refresh failed for ' + (inst.name || inst.uid) + ':', String((err && err.message) || err));
    inst.authExpired = true;
    // Re-read: never write the stale record back over tokens saved meanwhile.
    const latest = auth.get(inst.uid) || rec;
    if (latest.expires && latest.expires < Date.now()) {
      auth.setOAuth(inst.uid, { ...latest, meta: { ...(latest.meta || {}), expired: true } });
    }
  }
}

module.exports = {
  normalizeModelFields, chatModelFor, catalogSmallModel,
  keyUrlMismatch, normalizeBaseUrl,
  PRESETS, ensureDefaults, envFor, publicInstance, newUid,
  useAuth, catalogEntries, makeInstance, entryFor, resolveApiKey,
  envVarNames, ensureFreshAuth, setRefreshSecretCache, migrateUrls, migrateModels,
};
