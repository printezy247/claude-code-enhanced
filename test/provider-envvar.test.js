// A provider whose catalog entry names an environment variable must be able to
// authenticate from that variable when no key was stored in the app.
//
// OpenCode Go's preset declares OPENCODE_API_KEY (models.dev records it), but
// the value was never read, so the request went upstream with no credential at
// all and Go answered "Go requires a credential".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const providers = require('../src/main/providers.js');

let home;
let store;
let saved;

beforeEach(() => {
  home = require('node:os').homedir();
  saved = process.env.OPENCODE_API_KEY;
  store = {
    providers: [{
      uid: 'u1', presetId: 'opencode-go', name: 'OpenCode Go',
      protocol: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1',
      keyHeader: 'bearer', headers: {}, model: 'beam-free', smallFastModel: '',
      whitelist: [], blacklist: [], models: [], disabled: false,
      envExtras: {}, leanTools: null, alwaysTranslate: true,
    }],
    settings: {}, save() {},
  };
});

afterEach(() => {
  if (saved === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = saved;
});

describe('environment-variable credentials', () => {
  it('declares an env var for the OpenCode Go preset', () => {
    const entry = providers.entryFor(store.providers[0]);
    expect(entry).toBeTruthy();
    expect(entry.envVar).toBe('OPENCODE_API_KEY');
  });

  it('reads the key from the environment when none is stored', () => {
    const auth = { resolve: () => ({}) };
    providers.useAuth(auth);
    const key = providers.resolveApiKey(store.providers[0], auth, { OPENCODE_API_KEY: ' sk-from-env ' });
    expect(key).toBe('sk-from-env');
  });

  it('prefers the stored key over the environment', () => {
    const auth = { resolve: () => ({ apiKey: 'stored-key' }) };
    providers.useAuth(auth);
    const key = providers.resolveApiKey(store.providers[0], auth, { OPENCODE_API_KEY: 'env-key' });
    expect(key).toBe('stored-key');
  });

  it('returns nothing when neither source has a key', () => {
    const auth = { resolve: () => ({}) };
    providers.useAuth(auth);
    expect(providers.resolveApiKey(store.providers[0], auth, {})).toBe('');
  });

  it('does not read the environment for a provider without one', () => {
    const plain = { ...store.providers[0], presetId: 'openrouter' };
    const auth = { resolve: () => ({}) };
    providers.useAuth(auth);
    expect(providers.resolveApiKey(plain, auth, { OPENCODE_API_KEY: 'env-key' })).toBe('');
  });

  it('reads key from instance-declared envVar', () => {
    const custom = { uid: 'u2', name: 'Custom Env Auth', envVar: 'CUSTOM_AI_KEY' };
    const auth = { resolve: () => ({}) };
    providers.useAuth(auth);
    expect(providers.resolveApiKey(custom, auth, { CUSTOM_AI_KEY: 'custom-secret-key' })).toBe('custom-secret-key');
  });

  it('reads key from catalog md.env array', () => {
    const provider = { uid: 'u3', presetId: 'deepseek', name: 'DeepSeek' };
    const auth = { resolve: () => ({}) };
    providers.useAuth(auth);
    expect(providers.resolveApiKey(provider, auth, { DEEPSEEK_API_KEY: 'deepseek-secret' })).toBe('deepseek-secret');
  });
});

// A SECOND env-auth provider, and the rule that makes both the resolver and
// the proxy's secret cache agree: one shared list of env var names.
describe('the shared env-var list', () => {
  const auth = { resolve: () => ({}) };

  it('resolves a second env-auth provider (Groq)', () => {
    const provider = { uid: 'g1', presetId: 'groq', name: 'Groq' };
    providers.useAuth(auth);
    expect(providers.resolveApiKey(provider, auth, { GROQ_API_KEY: 'gsk-secret' })).toBe('gsk-secret');
  });

  it('names the env var of the second provider in the shared list', () => {
    const provider = { uid: 'g1', presetId: 'groq', name: 'Groq' };
    expect(providers.envVarNames(provider)).toContain('GROQ_API_KEY');
  });

  it('gives the resolver and the proxy secret cache the SAME list', () => {
    // The proxy cache (main.js refreshSecretCache) reads envVarNames(); the
    // resolver (resolveApiKey) reads the same helper. If they ever diverge,
    // the proxy sends no credential while the resolver says there is one.
    const provider = { uid: 'g1', presetId: 'groq', name: 'Groq' };
    const names = providers.envVarNames(provider);
    const key = providers.resolveApiKey(provider, auth, { GROQ_API_KEY: 'gsk-secret' });
    expect(names.filter((n) => 'gsk-secret' === ({ GROQ_API_KEY: 'gsk-secret' })[n])).toHaveLength(1);
    expect(key).toBe('gsk-secret');
  });

  it('never uses a configuration value as the credential', () => {
    // Azure records AZURE_RESOURCE_NAME next to AZURE_API_KEY. Sending the
    // resource name as a bearer token looks like a bad key, not a missing one.
    const provider = { uid: 'az1', presetId: 'azure', name: 'Azure OpenAI' };
    const names = providers.envVarNames(provider);
    expect(names).toContain('AZURE_API_KEY');
    expect(names).not.toContain('AZURE_RESOURCE_NAME');
    const env = { AZURE_RESOURCE_NAME: 'my-resource', AZURE_API_KEY: 'azure-secret' };
    expect(providers.resolveApiKey(provider, auth, env)).toBe('azure-secret');
  });

  it('finds the models.dev env var of a curated preset whose catalog id differs', () => {
    // The Kimi preset is 'moonshotai' on models.dev.
    const provider = { uid: 'k1', presetId: 'kimi', name: 'Kimi' };
    expect(providers.envVarNames(provider)).toContain('MOONSHOT_API_KEY');
    expect(providers.resolveApiKey(provider, auth, { MOONSHOT_API_KEY: 'sk-moon' })).toBe('sk-moon');
  });
});
