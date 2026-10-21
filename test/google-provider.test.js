// Google AI Studio (Gemini), measured against the live API with a real key:
//  - compat route (/v1beta/openai): needs Authorization: Bearer
//  - native route (/v1beta): any Authorization header is a 401; wants x-goog-api-key
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adapters = require('../src/main/adapters.js');
const catalog = require('../src/main/catalog.js');
const providers = require('../src/main/providers.js');

const COMPAT = 'https://generativelanguage.googleapis.com/v1beta/openai';
const NATIVE = 'https://generativelanguage.googleapis.com/v1beta';
const compat = { baseUrl: COMPAT, apiKey: 'AIza-k', protocol: 'openai', keyHeader: 'bearer' };
const native = { baseUrl: NATIVE, apiKey: 'AIza-k', protocol: 'gemini', keyHeader: 'x-goog-api-key' };

describe('google native route', () => {
  it('sends x-goog-api-key and no Authorization header', () => {
    const h = adapters.upHeaders(native);
    expect(h['x-goog-api-key']).toBe('AIza-k');
    expect(h.Authorization).toBeUndefined();
  });

  it('does so even for a native instance saved with the bearer style', () => {
    const h = adapters.upHeaders({ ...native, keyHeader: 'bearer' });
    expect(h.Authorization).toBeUndefined();
    expect(h['x-goog-api-key']).toBe('AIza-k');
  });

  it('keeps the bearer token on the compat route', () => {
    const h = adapters.upHeaders(compat);
    expect(h.Authorization).toBe('Bearer AIza-k');
  });
});

describe('google presets', () => {
  it('the compat preset uses a bearer token and real model ids', () => {
    const g = catalog.byId('google');
    expect(g.keyHeader).toBe('bearer');
    expect(g.defaultModel).toBe('gemini-3.5-flash');
    expect(g.defaultSmall).toBe('gemini-3.5-flash-lite');
  });

  it('a native preset is one click away', () => {
    const g = catalog.byId('google-native');
    expect(g.protocol).toBe('gemini');
    expect(g.baseUrl).toBe(NATIVE);
    expect(g.keyHeader).toBe('x-goog-api-key');
    expect(g.md).toBe('google');
    expect(catalog.build().some(e => e.id === 'google-native')).toBe(true);
  });

  it('publicInstance tells the renderer the auth style', () => {
    expect(providers.publicInstance({ uid: 'g', presetId: 'google-native', name: 'G', keyHeader: 'x-goog-api-key' }).keyHeader).toBe('x-goog-api-key');
  });
});

describe('existing google instances', () => {
  const store = (p) => ({ providers: [p], settings: {}, save() {} });
  const old = () => ({ uid: 'g1', presetId: 'google', protocol: 'openai', baseUrl: COMPAT, keyHeader: 'query', model: 'gemini-3.1-pro-preview', smallFastModel: 'gemini-3.1-flash' });

  it('replaces the dead small model and the quota-less pro default, once', () => {
    const s = store(old());
    expect(providers.migrateModels(s)).toBe(true);
    expect(s.providers[0].model).toBe('gemini-3.5-flash');
    expect(s.providers[0].smallFastModel).toBe('gemini-3.5-flash-lite');
    s.providers[0].model = 'gemini-3.1-pro-preview';   // user picks it again on purpose
    providers.migrateModels(s);
    expect(s.providers[0].model).toBe('gemini-3.1-pro-preview');
  });

  it('leaves models the user chose alone', () => {
    const s = store({ ...old(), model: 'gemini-3.7-flash', smallFastModel: 'gemini-3.5-flash-lite' });
    providers.migrateModels(s);
    expect(s.providers[0].model).toBe('gemini-3.7-flash');
  });
});
