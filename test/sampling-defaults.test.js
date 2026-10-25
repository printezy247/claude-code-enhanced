import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { samplingDefaults, probeContextWindow, contextCache } = require('../src/main/modelcontext.js');
const adapters = require('../src/main/adapters.js');

describe('sampling defaults per model family', () => {
  test('Qwen gets 0.55, Gemini 1.0, DeepSeek-R1 nothing', () => {
    expect(samplingDefaults({}, 'qwen3-coder').temperature).toBe(0.55);
    expect(samplingDefaults({}, 'gemini-2.5-pro').temperature).toBe(1.0);
    expect(samplingDefaults({}, 'deepseek-r1')).toEqual({});
    expect(samplingDefaults({}, 'gpt-4o')).toEqual({});
  });
  test('provider overrides win', () => {
    expect(samplingDefaults({ temperature: 0.2, topP: 0.9 }, 'qwen3')).toEqual({ temperature: 0.2, top_p: 0.9 });
  });
  test('request value beats the default in the OpenAI body', () => {
    const prov = { baseUrl: 'https://x/v1' };
    const base = { model: 'qwen3-coder', messages: [{ role: 'user', content: 'hi' }] };
    expect(adapters.buildOpenAIBody(base, false, prov).temperature).toBe(0.55);
    expect(adapters.buildOpenAIBody({ ...base, temperature: 0.1 }, false, prov).temperature).toBe(0.1);
    expect(adapters.buildOpenAIBody({ ...base, model: 'deepseek-r1' }, false, prov).temperature).toBeUndefined();
  });
});

describe('context probe auth', () => {
  test('sends the provider key', async () => {
    contextCache.clear();
    const seen = [];
    const orig = global.fetch;
    global.fetch = async (u, o) => { seen.push(o); return { ok: true, json: async () => ({ data: [{ id: 'm', context_length: 5000 }] }) }; };
    try {
      expect(await probeContextWindow({ baseUrl: 'https://gated/v1', apiKey: 'k1' }, 'm')).toBe(5000);
    } finally { global.fetch = orig; }
    expect(seen[0].headers.Authorization).toBe('Bearer k1');
  });
});

describe('phase 1 extras', () => {
  const modelsdev = require('../src/main/modelsdev.js');
  const providers = require('../src/main/providers.js');
  test('dated Mistral ids normalise', () => {
    expect(modelsdev.normalizeModelId('mistral-large-2411')).toBe('mistral-large');
    expect(modelsdev.normalizeModelId('codestral-2501')).toBe('codestral');
    expect(modelsdev.normalizeModelId('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(modelsdev.normalizeModelId('qwen3-2507')).toBe('qwen3-2507');
  });
  test('OpenRouter Gemini gets a cache breakpoint', () => {
    const prov = { baseUrl: 'https://openrouter.ai/api/v1' };
    const b = { model: 'google/gemini-2.5-pro', system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
    const out = adapters.buildOpenAIBody(b, false, prov);
    expect(out.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
  test('catalog small model is picked for a provider with none', () => {
    const pid = 'google';
    const m = providers.catalogSmallModel({ presetId: pid, baseUrl: 'https://generativelanguage.googleapis.com' });
    expect(typeof m).toBe('string');
    expect(providers.catalogSmallModel({ presetId: pid, baseUrl: 'https://api.anthropic.com' })).toBe('');
  });
});
