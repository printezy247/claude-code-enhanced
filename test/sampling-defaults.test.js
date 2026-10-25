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
