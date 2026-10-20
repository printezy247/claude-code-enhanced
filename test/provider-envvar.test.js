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
});
