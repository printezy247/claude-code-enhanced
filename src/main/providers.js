// OpenCode-style provider manager.
//
// The claude CLI itself is provider-agnostic through environment variables:
//   ANTHROPIC_BASE_URL       Anthropic-compatible endpoint
//   ANTHROPIC_AUTH_TOKEN     bearer token (Z.AI, DeepSeek, Kimi, OpenRouter, proxies)
//   ANTHROPIC_API_KEY        Anthropic-style API key
//   ANTHROPIC_MODEL          main model id
//   ANTHROPIC_SMALL_FAST_MODEL  background/haiku-tier model id
// A "provider instance" is a saved set of those values; spawning a session with
// one selected injects them into the PTY environment.
'use strict';
const crypto = require('crypto');

const PRESETS = [
  {
    id: 'anthropic-oauth',
    name: 'Anthropic · Claude subscription',
    kind: 'oauth',
    blurb: 'Uses your Claude Pro/Max plan. No key required — run /login in the terminal once; the OAuth flow happens in your browser.',
    baseUrl: '', authToken: '', apiKey: '', model: '', smallFastModel: '',
  },
  {
    id: 'anthropic-api',
    name: 'Anthropic · Console API key',
    kind: 'api-key',
    blurb: 'Pay-per-token with a key from console.anthropic.com.',
    baseUrl: '', authToken: '', apiKey: '', model: '', smallFastModel: '',
  },
  {
    id: 'zai',
    name: 'Z.AI · GLM coding plan',
    kind: 'api-key',
    blurb: 'GLM models via Z.AI\'s Anthropic-compatible endpoint.',
    baseUrl: 'https://api.z.ai/api/anthropic', authToken: '', apiKey: '',
    model: 'glm-4.6', smallFastModel: 'glm-4.5-air',
  },
  {
    id: 'ollama',
    name: 'Ollama · local models (auto-discover)',
    kind: 'api-key',
    blurb: 'Every model on your Ollama server (local + cloud tags) appears automatically in the model selector — no per-model setup. Set the auth token to: ollama',
    baseUrl: 'http://localhost:11434', authToken: '', apiKey: '',
    model: '', smallFastModel: '',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek · Anthropic endpoint',
    kind: 'api-key',
    blurb: 'DeepSeek V3/R1 through the official Anthropic-compatible API.',
    baseUrl: 'https://api.deepseek.com/anthropic', authToken: '', apiKey: '',
    model: 'deepseek-chat', smallFastModel: 'deepseek-chat',
  },
  {
    id: 'kimi',
    name: 'Moonshot · Kimi for Coding',
    kind: 'api-key',
    blurb: 'K2 models. Endpoint is editable if Moonshot ships a new one.',
    baseUrl: 'https://api.kimi.com', authToken: '', apiKey: '',
    model: 'kimi-for-coding', smallFastModel: 'kimi-for-coding',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter · multi-model gateway',
    kind: 'api-key',
    blurb: 'Any model on OpenRouter via its Anthropic-compatible API.',
    baseUrl: 'https://openrouter.ai/api', authToken: '', apiKey: '',
    model: 'anthropic/claude-sonnet-4.5', smallFastModel: 'anthropic/claude-3.5-haiku',
  },
  {
    id: 'mistral', display: 'Mistral', name: 'Mistral · La Plateforme', kind: 'api-key', protocol: 'openai',
    blurb: 'Key-only — the built-in translator converts Mistral\u2019s OpenAI API for the claude engine.',
    baseUrl: 'https://api.mistral.ai/v1', authToken: '', apiKey: '',
    model: 'mistral-large-latest', smallFastModel: 'mistral-small-latest',
  },
  {
    id: 'groq', display: 'Groq', name: 'Groq · ultra-fast inference', kind: 'api-key', protocol: 'openai',
    blurb: 'Key-only via the built-in translator. Llama 3.3 70B at extreme speed.',
    baseUrl: 'https://api.groq.com/openai/v1', authToken: '', apiKey: '',
    model: 'llama-3.3-70b-versatile', smallFastModel: 'llama-3.1-8b-instant',
  },
  {
    id: 'google-ai-studio', display: 'Google AI Studio', name: 'Google AI Studio · Gemini', kind: 'api-key', protocol: 'openai',
    blurb: 'Key-only — Gemini through Google\u2019s OpenAI-compatible endpoint, translated for claude.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', authToken: '', apiKey: '',
    model: 'gemini-2.5-flash', smallFastModel: 'gemini-2.5-flash-lite',
  },
  {
    id: 'cloudflare-workers-ai', display: 'Cloudflare Workers AI', name: 'Cloudflare Workers AI', kind: 'api-key', protocol: 'openai', editableBaseUrl: true,
    blurb: 'API key only from Cloudflare (dash → API tokens), plus YOUR account id in place of ACCOUNT_ID in the Base URL (dash → Workers & Pages → account id).',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1', authToken: '', apiKey: '',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', smallFastModel: '@cf/meta/llama-3.1-8b-instruct',
  },
  {
    id: 'nararouter', display: 'NaraRouter', name: 'NaraRouter', kind: 'api-key', protocol: 'openai', editableBaseUrl: true,
    blurb: 'OpenAI-compatible router with a generous free tier (5M tokens/day for students). Confirm the base URL from your NaraRouter dashboard — the field is editable.',
    baseUrl: 'https://api.nararouter.com/v1', authToken: '', apiKey: '',
    model: '', smallFastModel: '',
  },
  {
    id: 'custom',
    name: 'Custom · LiteLLM / proxy / self-hosted',
    kind: 'api-key',
    blurb: 'Any Anthropic-compatible endpoint (LiteLLM, claude-code-proxy, Ollama bridges…).',
    baseUrl: '', authToken: '', apiKey: '', model: '', smallFastModel: '',
  },
];

function newUid() { return crypto.randomBytes(6).toString('hex'); }

// Ensure at least the Anthropic OAuth instance exists on first run.
function ensureDefaults(store) {
  if (store.providers.length === 0) {
    store.providers = [{
      uid: newUid(),
      presetId: 'anthropic-oauth',
      name: 'Anthropic · Claude subscription',
      baseUrl: '', authToken: '', apiKey: '', model: '', smallFastModel: '', envExtras: {},
    }];
    store.settings.defaultProviderUid = store.providers[0].uid;
    store.save();
  }
  if (!store.providers.some(p => p.uid === store.settings.defaultProviderUid)) {
    store.settings.defaultProviderUid = store.providers[0].uid;
    store.save();
  }
}

// Env vars a session needs for the selected provider (+ telemetry opt-outs).
function envFor(instance, settings) {
  const env = {};
  if (!instance) return env;
  if (instance.baseUrl) env.ANTHROPIC_BASE_URL = instance.baseUrl;
  if (instance.authToken) env.ANTHROPIC_AUTH_TOKEN = instance.authToken;
  if (instance.apiKey) env.ANTHROPIC_API_KEY = instance.apiKey;
  if (instance.model) env.ANTHROPIC_MODEL = instance.model;
  if (instance.smallFastModel) env.ANTHROPIC_SMALL_FAST_MODEL = instance.smallFastModel;
  if (instance.envExtras) {
    for (const [k, v] of Object.entries(instance.envExtras)) {
      if (/^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string') env[k] = v;
    }
  }
  if (settings.disableTelemetry) {
    env.DISABLE_TELEMETRY = '1';
    env.DISABLE_ERROR_REPORTING = '1';
    env.DISABLE_AUTOUPDATER = '1';
  }
  return env;
}

function publicInstance(p) {
  // Never send raw secrets wholesale to the renderer UI in list form; the
  // renderer keeps its own edited copies instead. Show a masked hint only.
  const mask = s => (s ? s.slice(0, 6) + '…' + s.slice(-4) : '');
  return {
    uid: p.uid, presetId: p.presetId, name: p.name,
    baseUrl: p.baseUrl || '', model: p.model || '', smallFastModel: p.smallFastModel || '',
    envExtras: p.envExtras || {},
    protocol: p.protocol || 'anthropic',
    models: Array.isArray(p.models) ? p.models : [],
    hasAuthToken: !!p.authToken, hasApiKey: !!p.apiKey,
    authTokenHint: mask(p.authToken), apiKeyHint: mask(p.apiKey),
  };
}

module.exports = { PRESETS, ensureDefaults, envFor, publicInstance, newUid };
