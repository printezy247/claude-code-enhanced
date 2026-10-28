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

// Google 400s on a `reasoning` field and on reasoning_effort outside
// none|minimal|low|medium|high; its native thinkingBudget must be 1..24576 and
// is exclusive with thinkingLevel (all measured against the live API).
describe('thinking and effort sent to google', () => {
  const turn = (extra = {}) => ({
    model: 'gemini-3.5-flash', max_tokens: 32000,
    thinking: { budget_tokens: 31999, type: 'enabled' },
    messages: [{ role: 'user', content: 'hi' }], ...extra,
  });
  const other = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', protocol: 'openai', keyHeader: 'bearer' };
  const eff = (e) => adapters.buildOpenAIBody(turn({ output_config: { effort: e } }), true, compat).reasoning_effort;

  it('compat: drops the rejected reasoning field and maps the budget onto reasoning_effort', () => {
    const out = adapters.buildOpenAIBody(turn(), true, compat);
    expect(out.reasoning).toBeUndefined();
    expect(out.reasoning_effort).toBe('high');
    expect(adapters.buildOpenAIBody(turn({ thinking: { budget_tokens: 1024 } }), true, compat).reasoning_effort).toBe('minimal');
    expect(adapters.buildOpenAIBody(turn({ thinking: { budget_tokens: 8192 } }), true, compat).reasoning_effort).toBe('medium');
  });

  it('compat: clamps xhigh and max to high, keeps valid levels, omits unknown ones', () => {
    expect(eff('xhigh')).toBe('high');
    expect(eff('max')).toBe('high');
    for (const l of ['none', 'minimal', 'low', 'medium', 'high']) expect(eff(l)).toBe(l);
    expect(eff('turbo')).toBeUndefined();
  });

  it('compat: a provider that accepts effort keeps it, and never gets a `reasoning` field', () => {
    const out = adapters.buildOpenAIBody(turn({ model: 'gpt-5', effort: 'xhigh' }), true, other);
    expect(out.reasoning).toBeUndefined();
    expect(out.reasoning_effort).toBe('xhigh');
  });

  it('native: clamps the budget, omits a zero budget, uses a level only without a budget', () => {
    const cfg = (b) => adapters.buildGeminiBody(b, native).generationConfig.thinkingConfig;
    // includeThoughts asks Gemini for its thought summaries (reasoning the
    // chat can show) wherever thinking is configured. #feat-reasoning-summaries
    expect(cfg(turn())).toEqual({ thinkingBudget: 24576, includeThoughts: true });
    expect(cfg(turn({ thinking: { budget_tokens: 4096 } }))).toEqual({ thinkingBudget: 4096, includeThoughts: true });
    expect(cfg(turn({ thinking: { budget_tokens: 0 } }))).toBeUndefined();
    expect(cfg(turn({ thinking: undefined, output_config: { effort: 'low' } }))).toEqual({ thinkingLevel: 'low', includeThoughts: true });
    expect(cfg(turn({ thinking: undefined, output_config: { effort: 'max' } }))).toEqual({ thinkingLevel: 'high', includeThoughts: true });
  });

  it('native: another gemini gateway keeps the budget it was given', () => {
    const gw = { baseUrl: 'https://gw.example/v1beta', apiKey: 'k', protocol: 'gemini', keyHeader: 'bearer' };
    expect(adapters.buildGeminiBody(turn(), gw).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 31999, includeThoughts: true });
  });
});
