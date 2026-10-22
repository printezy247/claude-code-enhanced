// models.dev first (date-suffixed id stripped), then provider-declared
// context, else 0 — the number leanEngineEnv raises or lowers the window with.
//
// Task A4 added the normalization table (date suffix, case, alias), the probe
// of the provider's own /models endpoint for a model models.dev does not know,
// and the cache that keeps a probe from being repeated.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { modelContext, ENGINE_DEFAULT_WINDOW, contextCache, probeContextWindow } = require('../src/main/modelcontext.js');

afterEach(() => { contextCache.clear(); vi.unstubAllGlobals(); });

describe('modelContext', () => {
  it('returns models.dev context for a known model', () => {
    expect(modelContext({ presetId: 'deepinfra' }, 'tencent/Hy3')).toBe(262144);
  });

  it('strips -YYYY-MM-DD suffix before lookup', () => {
    expect(modelContext({ presetId: 'deepinfra' }, 'tencent/Hy3-2026-01-01')).toBe(262144);
  });

  it('falls back to provider.contextWindow when models.dev misses', () => {
    expect(modelContext({ presetId: 'nope', contextWindow: 400000 }, 'm')).toBe(400000);
  });

  it('falls back to provider.models[].context by model id', () => {
    expect(modelContext({ presetId: 'nope', models: [{ id: 'm', context: 131072 }] }, 'm')).toBe(131072);
  });

  it('resolves known model aliases even without provider presetId', () => {
    expect(modelContext(null, 'gpt-4-32k')).toBe(32768);
    expect(modelContext({ presetId: 'nope' }, 'codestral')).toBe(32768);
    expect(modelContext(null, 'qwen2.5-coder')).toBe(131072);
  });

  it('returns 0 when nothing knows the model', () => {
    expect(modelContext({ presetId: 'nope' }, 'm')).toBe(0);
    expect(modelContext(null, 'm')).toBe(0);
    expect(modelContext({ presetId: 'deepinfra' }, '')).toBe(0);
  });

  it('exports the engine default window as 200k', () => {
    expect(ENGINE_DEFAULT_WINDOW).toBe(200000);
  });
});

describe('the normalization table', () => {
  it('strips a date suffix and finds the base model', () => {
    // models.dev lists gpt-4o, not the dated variant.
    expect(modelContext({ presetId: 'openai' }, 'gpt-4o-2024-08-06')).toBe(128000);
  });

  it('ignores the case of the model id', () => {
    expect(modelContext({ presetId: 'openai' }, 'GPT-4O')).toBe(128000);
  });

  it('maps an alias onto the id the catalog knows', () => {
    // "gpt-4o-latest" is not a models.dev id; "gpt-4o" is.
    expect(modelContext({ presetId: 'openai' }, 'gpt-4o-latest')).toBe(128000);
  });

  it('does not report a context for a model nothing knows', () => {
    expect(modelContext({ presetId: 'openai' }, 'totally-unknown-model')).toBe(0);
  });
});

describe('the probe for a model the catalog does not know', () => {
  it('reads context_length from the provider\'s /models endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'weird-model', context_length: 111111 }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = await probeContextWindow({ baseUrl: 'https://api.example/v1' }, 'weird-model');
    expect(ctx).toBe(111111);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads max_context_tokens as well', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'weird-model', max_context_tokens: 222222 }] }),
    }));
    expect(await probeContextWindow({ baseUrl: 'https://api.example/v1' }, 'weird-model')).toBe(222222);
  });

  it('caches the answer, so a second lookup does not probe again', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'weird-model', context_length: 111111 }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await probeContextWindow({ baseUrl: 'https://api.example/v1' }, 'weird-model');
    await probeContextWindow({ baseUrl: 'https://api.example/v1' }, 'weird-model');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the cached value is what modelContext then reports', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'weird-model', context_length: 111111 }] }),
    }));
    const provider = { presetId: 'nope', baseUrl: 'https://api.example/v1' };
    await probeContextWindow(provider, 'weird-model');
    expect(modelContext(provider, 'weird-model')).toBe(111111);
  });

  it('reports 0 when the endpoint does not know the model', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [] }) }));
    expect(await probeContextWindow({ baseUrl: 'https://api.example/v1' }, 'weird-model')).toBe(0);
  });

  it('reports 0 when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    expect(await probeContextWindow({ baseUrl: 'https://api.example/v1' }, 'weird-model')).toBe(0);
  });
});
