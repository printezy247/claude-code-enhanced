// Provider catalog: the data behind the "Connect" picker and the provider
// detail page. Curated entries carry the things models.dev does not know —
// auth method (key vs OAuth vs device-code), Anthropic-vs-OpenAI protocol,
// URL placeholders, local-runtime flags. Everything else is merged in from the
// models.dev snapshot so all 200+ providers are selectable.
'use strict';
const modelsdev = require('./modelsdev');

// ---- curated overlay -------------------------------------------------------
// `md` = models.dev provider id (defaults to `id`). `protocol` decides the
// transport: 'anthropic' is spoken natively by the engine; every other value is
// translated by the built-in adapters.
const CURATED = [
  {
    id: 'anthropic', name: 'Anthropic', display: 'Claude', md: 'anthropic',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    protocol: 'anthropic', authKind: 'oauth+api',
    oauth: {
      flow: 'code', label: 'Claude Pro / Max subscription',
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scopes: 'org:create_api_key user:profile user:inference',
      redirectUri: 'https://console.anthropic.com/oauth/code/callback',
      writesCredentials: 'claude-cli',
    },
    baseUrl: '', keyHeader: 'x-api-key',
    defaultModel: 'claude-sonnet-4-5-20250929', defaultSmall: 'claude-haiku-4-5',
    capabilities: ['native-anthropic', 'oauth', 'subscription'],
    blurb: 'Claude Pro/Max sign-in (OAuth) or a console API key. Still works if you just run /login in a terminal.',
  },
  { id: 'zai', name: 'Z.AI', display: 'Z.AI (GLM)', md: 'zai', docsUrl: 'https://z.ai/manage-apikey/apikey-list',
    protocol: 'anthropic', authKind: 'api-key',
    baseUrl: 'https://api.z.ai/api/anthropic', keyHeader: 'bearer',
    defaultModel: 'glm-4.6', defaultSmall: 'glm-4.5-air',
    capabilities: ['native-anthropic'], blurb: 'GLM coding plan on Z.AI\u2019s Anthropic-compatible endpoint.' },
  { id: 'deepseek', display: 'DeepSeek', name: 'DeepSeek · Anthropic endpoint', md: 'deepseek', docsUrl: 'https://platform.deepseek.com/api_keys',
    protocol: 'anthropic', authKind: 'api-key',
    baseUrl: 'https://api.deepseek.com/anthropic', keyHeader: 'bearer',
    defaultModel: 'deepseek-chat', defaultSmall: 'deepseek-chat', capabilities: ['native-anthropic'],
    blurb: 'V3/R1 through the official Anthropic-compatible API.' },
  { id: 'kimi', display: 'Moonshot · Kimi', name: 'Moonshot · Kimi for Coding', md: 'moonshotai', docsUrl: 'https://platform.moonshot.ai/console/api-keys',
    protocol: 'anthropic', authKind: 'api-key',
    baseUrl: 'https://api.kimi.com', keyHeader: 'bearer',
    defaultModel: 'kimi-for-coding', defaultSmall: 'kimi-for-coding', capabilities: ['native-anthropic'],
    blurb: 'Kimi K2 coding lane; endpoint editable if Moonshot ships a new one.' },
  { id: 'minimax', display: 'MiniMax', name: 'MiniMax', md: 'minimax', docsUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    protocol: 'anthropic', authKind: 'api-key',
    baseUrl: 'https://api.minimax.io/anthropic/v1', keyHeader: 'bearer',
    defaultModel: 'MiniMax-M2', defaultSmall: 'MiniMax-M2', capabilities: ['native-anthropic'] },
  { id: 'openrouter', display: 'OpenRouter', name: 'OpenRouter · multi-model gateway', md: 'openrouter', docsUrl: 'https://openrouter.ai/settings/keys',
    protocol: 'anthropic', authKind: 'api-key',
    baseUrl: 'https://openrouter.ai/api', keyHeader: 'bearer',
    defaultModel: 'anthropic/claude-sonnet-4.5', defaultSmall: 'anthropic/claude-3.5-haiku',
    capabilities: ['native-anthropic', 'gateway'], blurb: 'Any model on OpenRouter via its Anthropic-compatible API.' },
  { id: 'custom', display: 'Custom (Anthropic-compatible)', name: 'Custom · LiteLLM / proxy / self-hosted',
    protocol: 'anthropic', authKind: 'api-key', baseUrl: '', keyHeader: 'bearer',
    capabilities: ['native-anthropic'], blurb: 'Any Anthropic-compatible endpoint (LiteLLM, claude-code-proxy, Ollama bridges…).' },

  { id: 'openai', display: 'OpenAI', name: 'OpenAI', md: 'openai', docsUrl: 'https://platform.openai.com/api-keys',
    protocol: 'openai', authKind: 'oauth+api', keyHeader: 'bearer',
    oauth: {
      flow: 'pkce', label: 'ChatGPT Plus / Pro',
      authorizeUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      scopes: 'openid profile email offline_access',
      redirectUri: 'http://localhost:1455/auth/callback',
      extra: { codex_cli_simplified_flow: 'true', id_token_add_organizations: 'true', originator: 'codex_cli_rs' },
    },
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.2', defaultSmall: 'gpt-5-mini', capabilities: ['openai-compat', 'oauth'], blurb: 'API key or ChatGPT subscription sign-in (experimental for engine use).' },
  { id: 'mistral', display: 'Mistral', name: 'Mistral · La Plateforme', md: 'mistral', docsUrl: 'https://console.mistral.ai/api-keys',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.mistral.ai/v1', keyHeader: 'bearer',
    defaultModel: 'codestral-2508', defaultSmall: 'mistral-small-latest', capabilities: ['openai-compat'] },
  { id: 'groq', display: 'Groq', name: 'Groq · ultra-fast inference', md: 'groq', docsUrl: 'https://console.groq.com/keys',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.groq.com/openai/v1', keyHeader: 'bearer',
    defaultModel: 'llama-3.3-70b-versatile', defaultSmall: 'llama-3.1-8b-instant', capabilities: ['openai-compat'] },
  { id: 'google', display: 'Google AI Studio', name: 'Google AI Studio · Gemini (OpenAI-compatible)', md: 'google', docsUrl: 'https://aistudio.google.com/apikey',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHeader: 'bearer',
    defaultModel: 'gemini-3.5-flash', defaultSmall: 'gemini-3.5-flash-lite', capabilities: ['openai-compat'] },
  { id: 'google-native', display: 'Google AI Studio (native)', name: 'Google AI Studio · Gemini (native generateContent)', md: 'google', docsUrl: 'https://aistudio.google.com/apikey',
    protocol: 'gemini', authKind: 'api-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyHeader: 'x-goog-api-key',
    defaultModel: 'gemini-3.5-flash', defaultSmall: 'gemini-3.5-flash-lite', capabilities: ['openai-compat'] },
  { id: 'cloudflare-workers-ai', display: 'Cloudflare Workers AI', name: 'Cloudflare Workers AI', md: 'cloudflare-workers-ai', docsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    protocol: 'openai', authKind: 'api-key',
    baseUrlTemplate: 'https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1',
    placeholders: [{ key: 'ACCOUNT_ID', label: 'Cloudflare account ID', hint: 'dash → Workers & Pages → account ID' }],
    keyHeader: 'bearer', defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', defaultSmall: '@cf/meta/llama-3.1-8b-instruct',
    capabilities: ['openai-compat', 'needs-account-id'] },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', md: 'cloudflare-ai-gateway', docsUrl: 'https://dash.cloudflare.com/',
    protocol: 'openai', authKind: 'api-key',
    baseUrlTemplate: 'https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/compat',
    placeholders: [{ key: 'ACCOUNT_ID', label: 'Account ID' }, { key: 'GATEWAY_ID', label: 'Gateway ID' }],
    keyHeader: 'bearer', capabilities: ['openai-compat', 'needs-account-id', 'gateway'] },
  { id: 'xai', display: 'xAI', name: 'xAI · Grok', md: 'xai', docsUrl: 'https://console.x.ai/',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.x.ai/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'cerebras', display: 'Cerebras', name: 'Cerebras', md: 'cerebras', docsUrl: 'https://cloud.cerebras.ai/',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.cerebras.ai/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'togetherai', display: 'Together AI', name: 'Together AI', md: 'togetherai', docsUrl: 'https://api.together.ai/settings/api-keys',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.together.xyz/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'fireworks-ai', display: 'Fireworks AI', name: 'Fireworks AI', md: 'fireworks-ai', docsUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.fireworks.ai/inference/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'nvidia', display: 'NVIDIA', name: 'NVIDIA NIM', md: 'nvidia', docsUrl: 'https://build.nvidia.com/',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://integrate.api.nvidia.com/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'huggingface', display: 'Hugging Face', name: 'Hugging Face Inference', md: 'huggingface', docsUrl: 'https://huggingface.co/settings/tokens',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://router.huggingface.co/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'nebius', display: 'Nebius', name: 'Nebius Token Factory', md: 'nebius', docsUrl: 'https://tokenfactory.nebius.com/',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.studio.nebius.com/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'baseten', display: 'Baseten', name: 'Baseten', md: 'baseten', docsUrl: 'https://app.baseten.co/settings/api_keys',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://inference.baseten.co/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'deepinfra', display: 'DeepInfra', name: 'DeepInfra', md: 'deepinfra', docsUrl: 'https://deepinfra.com/dash/api_keys',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.deepinfra.com/v1/openai', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'vercel', display: 'Vercel AI Gateway', name: 'Vercel AI Gateway', md: 'vercel', docsUrl: 'https://vercel.com/dashboard',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://ai-gateway.vercel.sh/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat', 'gateway'] },
  { id: 'poolside', display: 'Poolside', name: 'Poolside', md: 'poolside', docsUrl: 'https://platform.poolside.ai',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.poolside.ai/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'opencode', display: 'OpenCode Zen', name: 'OpenCode Zen', md: 'opencode', docsUrl: 'https://opencode.ai/auth',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://opencode.ai/zen/v1', keyHeader: 'bearer',
    capabilities: ['openai-compat'] },
  { id: 'nararouter', display: 'NaraRouter', name: 'NaraRouter', docsUrl: 'https://router.bynara.id',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://router.bynara.id/v1', keyHeader: 'bearer',
    editableBaseUrl: true, capabilities: ['openai-compat'],
    defaultModel: 'nemotron-3.5-lightning-free', defaultSmall: '',
    recommendedModels: ['nemotron-3.5-lightning-free', 'nemotron-3-ultra-free', 'nemotron-3-super-free', 'ling-3.0-flash-sante-free', 'ling-3.0-flash-fin-free', 'laguna-s-2.1', 'jev', 'exo-stealth', 'agnes-3-flash', 'agnes-2.5-flash'],
    blurb: 'Free-plan models (7M tokens/day, 15 req/min), OpenAI-compatible. Get the key at router.bynara.id — the base URL is /v1.' },
  { id: 'lanox', display: 'Lanox', name: 'Lanox', docsUrl: 'https://api.lanox.ai',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://api.lanox.ai/v1', keyHeader: 'bearer',
    editableBaseUrl: true, capabilities: ['openai-compat', 'gateway'],
    defaultModel: 'gpt-5.6-sol', defaultSmall: '',
    recommendedModels: ['gpt-5.6-sol'],
    blurb: 'OpenAI, Qwen and Gemini models through one OpenAI-compatible gateway (/v1/chat/completions and /v1/responses). Pick models from the live list (GET /v1/models): it depends on your key.' },
  { id: 'agentrouter', display: 'AgentRouter', name: 'AgentRouter · OpenAI-compatible gateway', md: 'agentrouter',
    docsUrl: 'https://agentrouter.org/docs/opencode.html',
    protocol: 'openai', authKind: 'api-key', baseUrl: 'https://agentrouter.org/v1', keyHeader: 'bearer',
    defaultModel: 'deepseek-v4-flash', defaultSmall: 'deepseek-v4-flash',
    capabilities: ['openai-compat', 'gateway'],
    blurb: 'OpenAI-compatible route (/v1). AgentRouter fingerprints the client and may answer “unauthorized client detected” — if so, use the Anthropic route instead.' },
  { id: 'agentrouter-anthropic', display: 'AgentRouter (Claude route)', name: 'AgentRouter · Anthropic route',
    docsUrl: 'https://agentrouter.org/docs/opencode.html',
    protocol: 'anthropic', authKind: 'api-key', baseUrl: 'https://agentrouter.org', keyHeader: 'x-api-key',
    defaultModel: 'claude-opus-5', defaultSmall: 'claude-opus-5', normalizeUsage: true,
    capabilities: ['native-anthropic', 'gateway'],
    blurb: 'Base URL without /v1, x-api-key auth — matches AgentRouter’s supported Claude Code client, so it passes the client check the OpenAI route fails.' },
  { id: 'github-copilot', display: 'GitHub Copilot', name: 'GitHub Copilot', md: 'github-copilot', docsUrl: 'https://github.com/settings/copilot',
    protocol: 'openai', authKind: 'device-code', keyHeader: 'bearer',
    oauth: {
      flow: 'device', label: 'Sign in with GitHub',
      deviceUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: 'Iv1.b507a08c87ecfe98', scopes: 'read:user',
      exchange: 'copilot', copilotTokenUrl: 'https://api.githubcopilot.com/copilot_internal/v2/token',
    },
    baseUrl: 'https://api.githubcopilot.com', capabilities: ['openai-compat', 'oauth', 'subscription'],
    blurb: 'Use a GitHub Copilot subscription. Sign in with a device code; CCE swaps the GitHub token for a Copilot token automatically.' },
  { id: 'gitlab', display: 'GitLab Duo', name: 'GitLab Duo', md: 'gitlab', docsUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
    protocol: 'openai', authKind: 'oauth', keyHeader: 'bearer',
    oauth: {
      flow: 'pkce', label: 'Sign in with GitLab',
      authorizeUrl: 'https://gitlab.com/oauth/authorize',
      tokenUrl: 'https://gitlab.com/oauth/token',
      clientIdEnv: 'GITLAB_OAUTH_CLIENT_ID',
      scopes: 'api read_user read_repository',
      redirectUri: 'http://127.0.0.1:8080/callback',
    },
    baseUrl: 'https://gitlab.com/api/v4/ai', capabilities: ['openai-compat', 'oauth'],
    blurb: 'OAuth (needs a GitLab application id) or a personal access token. Experimental.' },
  { id: 'digitalocean', display: 'DigitalOcean', name: 'DigitalOcean Inference', md: 'digitalocean', docsUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    protocol: 'openai', authKind: 'oauth', keyHeader: 'bearer',
    oauth: {
      flow: 'pkce', label: 'Login with DigitalOcean',
      authorizeUrl: 'https://cloud.digitalocean.com/v1/oauth/authorize',
      tokenUrl: 'https://cloud.digitalocean.com/v1/oauth/token',
      clientIdEnv: 'DO_OAUTH_CLIENT_ID',
      scopes: 'read write',
      redirectUri: 'http://127.0.0.1:8080/callback',
    },
    baseUrl: 'https://inference.do-ai.run/v1', capabilities: ['openai-compat', 'oauth'],
    blurb: 'OAuth (needs a DigitalOcean OAuth application id) or a Model Access Key.' },
  { id: 'azure', display: 'Azure OpenAI', name: 'Azure OpenAI', md: 'azure', docsUrl: 'https://portal.azure.com/',
    protocol: 'openai', authKind: 'api-key',
    baseUrlTemplate: 'https://${RESOURCE_NAME}.openai.azure.com/openai/v1',
    placeholders: [{ key: 'RESOURCE_NAME', label: 'Azure resource name', hint: 'first part of <name>.openai.azure.com' }],
    keyHeader: 'api-key', capabilities: ['openai-compat', 'needs-account-id'] },
  { id: 'amazon-bedrock', display: 'Amazon Bedrock', name: 'Amazon Bedrock', md: 'amazon-bedrock',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html',
    protocol: 'openai', authKind: 'api-key',
    baseUrlTemplate: 'https://bedrock-runtime.${REGION}.amazonaws.com/openai/v1',
    placeholders: [{ key: 'REGION', label: 'AWS region', hint: 'e.g. us-east-1 — bedrock-runtime has no GET /models, so the picker uses the models.dev catalog' }],
    keyHeader: 'bearer',
    defaultModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0', defaultSmall: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    capabilities: ['openai-compat', 'cloud'],
    blurb: 'AWS Bedrock via its OpenAI-compatible endpoint. Paste a long-term Bedrock API key (starts ABSK…). SigV4/IAM users: keep AWS creds in the environment — key auth is what CCE sends.' },
  { id: 'google-vertex', display: 'Google Vertex AI', name: 'Google Vertex AI', md: 'google-vertex', protocol: 'openai', authKind: 'env',
    docsUrl: 'https://console.cloud.google.com/vertex-ai', capabilities: ['env-auth', 'cloud'],
    blurb: 'Uses GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC from the environment.' },

  // local runtimes
  { id: 'ollama', display: 'Ollama (local)', name: 'Ollama · local models (auto-discover)', md: 'ollama', protocol: 'anthropic', authKind: 'none',
    docsUrl: 'https://ollama.com/download', baseUrl: 'http://localhost:11434', keyHeader: 'bearer', keyOptional: true, local: true,
    capabilities: ['local', 'auto-discover'], blurb: 'Every model on your Ollama server appears automatically. Context is sized to fit automatically.' },
  { id: 'lmstudio', display: 'LM Studio (local)', name: 'LM Studio (local)', md: 'lmstudio', protocol: 'openai', authKind: 'none',
    docsUrl: 'https://lmstudio.ai/', baseUrl: 'http://127.0.0.1:1234/v1', keyHeader: 'bearer', keyOptional: true, local: true,
    capabilities: ['local', 'auto-discover'] },
  { id: 'llama.cpp', display: 'llama.cpp (local)', name: 'llama.cpp server (local)', protocol: 'openai', authKind: 'none',
    docsUrl: 'https://github.com/ggml-org/llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', keyHeader: 'bearer', keyOptional: true, local: true,
    capabilities: ['local', 'auto-discover'] },
  { id: 'vllm', display: 'vLLM (local)', name: 'vLLM (local)', protocol: 'openai', authKind: 'none',
    docsUrl: 'https://docs.vllm.ai/', baseUrl: 'http://127.0.0.1:8000/v1', keyHeader: 'bearer', keyOptional: true, local: true,
    capabilities: ['local', 'auto-discover'] },
  { id: 'openai-compatible', display: 'OpenAI-compatible', name: 'OpenAI-compatible (custom)', protocol: 'openai', authKind: 'api-key',
    baseUrl: '', keyHeader: 'bearer', editableBaseUrl: true, capabilities: ['openai-compat'],
    blurb: 'Any OpenAI-compatible server or gateway — paste its base URL and key.' },
];

/** Curated ids in declared order (the picker shows these first). */
const CURATED_IDS = CURATED.map(c => c.id);

/** models.dev npm package -> engine protocol. */
function protocolForNpm(npm) {
  const n = String(npm || '');
  if (n.includes('/anthropic')) return 'anthropic';
  if (n.includes('/google') && !n.includes('vertex')) return 'openai'; // OpenAI-compat endpoint is simpler + proven
  return 'openai';
}

// Shared with the renderer, which fills the same templates as the user types.
const { resolveTemplate, placeholdersIn } = require('../shared/tpl.js');

/** A generic catalog entry derived from a models.dev provider record. */
function isSizeHint(id) {
  const s = String(id || '').toLowerCase();
  return /\b(mini|small|flash|haiku|nano|lite|tiny)\b/i.test(s)
    || /[-_:](mini|small|flash|haiku|nano|lite|tiny|8b|7b|4b|3b|1b)/i.test(s);
}

function derive(md) {
  const best = modelsdev.bestModel(md.id);
  const models = modelsdev.modelsFor(md.id) || [];
  // Pick the cheapest/smallest model for background (title/summary) calls.
  // Never invent a name: only ids that models.dev actually lists.
  let smallId = '';
  const hinted = models.filter(m => isSizeHint(m.id || m.name || ''));
  const pool = hinted.length ? hinted : models;
  if (pool.length) {
    const sorted = pool.slice().sort((a, b) => {
      const la = String(a.id || '').length;
      const lb = String(b.id || '').length;
      if (la !== lb) return la - lb;
      const ca = (a.cost && (a.cost.input || a.cost.prompt)) || 999;
      const cb = (b.cost && (b.cost.input || b.cost.prompt)) || 999;
      return ca - cb;
    });
    smallId = sorted[0].id;
  }
  if (!smallId && models.length) smallId = models[0].id;
  const envVar = secretEnvNames(md.env)[0] || null;
  return {
    id: md.id, md: md.id, modelsDevId: md.id, name: md.name, display: md.name, docsUrl: md.doc || '',
    protocol: protocolForNpm(md.npm),
    authKind: 'api-key',
    baseUrl: md.api || '',
    envVar, keyHeader: 'bearer',
    defaultModel: best ? best.id : '',
    defaultSmall: smallId,
    derived: true,
    capabilities: ['openai-compat'],
    blurb: md.api
      ? 'API key only — base URL preset from models.dev.'
      : 'Configured via its environment variables (see docs).',
  };
}

/**
 * models.dev records configuration values next to the secret: Azure lists
 * AZURE_RESOURCE_NAME before AZURE_API_KEY, Vertex lists GOOGLE_VERTEX_PROJECT
 * and GOOGLE_APPLICATION_CREDENTIALS (a FILE PATH), Bedrock lists AWS_REGION.
 * Those are not credentials. Sending one as a bearer token produces a
 * confusing "401 invalid key" instead of "no credential set", so only
 * secret-shaped names are ever read as a key.
 */
// AWS_ACCESS_KEY_ID is excluded by the _ID rule, so _ACCESS_KEY must NOT be
// here: SUBMODEL_INSTAGEN_ACCESS_KEY is the credential of the submodel
// provider, and excluding it made that provider's env-var auth never resolve.
const NON_SECRET_ENV = /(_ID|_NAME|_PROJECT|_LOCATION|_HOST|_ACCOUNT|_ENDPOINT|_REGION|_PORT|_PATH|_FILE|_CREDENTIALS|_PRODUCT)$/i;
const SECRET_ENV = /(API_?KEY|_TOKEN$|_SECRET$|_KEY$|_PASSWORD$|_PAT$)/i;
function isSecretEnv(name) {
  const n = String(name || '');
  if (!n) return false;
  if (NON_SECRET_ENV.test(n)) return false;
  return SECRET_ENV.test(n);
}
/** The credential-shaped names out of an env list, in order. */
function secretEnvNames(list) {
  return (Array.isArray(list) ? list : []).filter(isSecretEnv).map(String);
}

/**
 * The full picker list: curated entries first (declared order), then every
 * other models.dev provider alphabetically. Each entry gains
 * `modelCount` + `modelsDevId` for the UI.
 *
 * The list is memoised per models.dev snapshot: building it walks 200+
 * providers, and every provider lookup (the env-var resolver, the renderer
 * payload, the picker) would otherwise rebuild the whole thing. A models.dev
 * refresh swaps the snapshot object, which invalidates the memo on its own.
 */
let buildCache = null;
let buildKey = null;
function build() {
  const md = modelsdev.load();
  if (buildCache && buildKey === md) return buildCache.slice();
  const seen = new Set();
  const out = [];
  for (const c of CURATED) {
    const e = { ...c, modelsDevId: c.md || c.id };
    const rec = md[e.modelsDevId];
    if (rec && !e.name) e.name = rec.name;
    if (!e.docsUrl && rec) e.docsUrl = rec.doc || '';
    // models.dev records the environment variable an API-key provider reads.
    // A curated entry that does not name one still has to be usable from the
    // environment, so adopt the recorded name (and the whole list) here.
    const secret = secretEnvNames(rec && rec.env);
    if (secret.length) {
      if (!e.envVar) e.envVar = secret[0];
      if (!Array.isArray(e.env)) e.env = secret.slice();
    }
    e.modelCount = rec ? Object.keys(rec.models || {}).length : 0;
    // Every catalog entry IS the catalog: the marker lets the picker say
    // "catalog-only" when a provider has no /models endpoint of its own.
    e.source = 'catalog';
    // A provider that cannot serve the main model falls back to its own
    // small/fast model, which is by construction a model it really serves.
    if (!e.fallbackModel) e.fallbackModel = e.defaultSmall || '';
    out.push(e);
    seen.add(e.id);
    if (e.modelsDevId) seen.add(e.modelsDevId);
  }
  for (const [id, rec] of Object.entries(md)) {
    if (seen.has(id) || CURATED.some(c => c.id === id)) continue;
    const e = derive(rec);
    e.modelCount = Object.keys(rec.models || {}).length;
    e.source = 'catalog';
    if (!e.fallbackModel) e.fallbackModel = e.defaultSmall || '';
    out.push(e);
  }
  buildCache = out;
  buildKey = md;
  return out.slice();
}

/** One catalog entry by id. */
function byId(id) {
  return build().find(e => e.id === id) || null;
}

module.exports = { CURATED, CURATED_IDS, build, byId, derive, resolveTemplate, placeholdersIn, protocolForNpm, isSecretEnv, secretEnvNames };
