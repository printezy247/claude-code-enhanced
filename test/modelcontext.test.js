// models.dev first (date-suffixed id stripped), then provider-declared
// context, else 0 — the number leanEngineEnv raises or lowers the window with.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { modelContext, ENGINE_DEFAULT_WINDOW } = require('../src/main/modelcontext.js');

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

  it('returns 0 when nothing knows the model', () => {
    expect(modelContext({ presetId: 'nope' }, 'm')).toBe(0);
    expect(modelContext(null, 'm')).toBe(0);
    expect(modelContext({ presetId: 'deepinfra' }, '')).toBe(0);
  });

  it('exports the engine default window as 200k', () => {
    expect(ENGINE_DEFAULT_WINDOW).toBe(200000);
  });
});
