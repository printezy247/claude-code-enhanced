// The provider capability matrix.
//
// The old version of this file asserted on a literal matrix defined in its own
// body and proved nothing. These assertions read the REAL catalog and the REAL
// secret-free provider view the renderer gets.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../src/main/catalog.js');
const providers = require('../src/main/providers.js');

describe('catalog capabilities', () => {
  it('gives every curated entry a capability list', () => {
    for (const e of catalog.CURATED) {
      expect(Array.isArray(e.capabilities), e.id + ' has no capabilities').toBe(true);
      expect(e.capabilities.length, e.id + ' has no capabilities').toBeGreaterThan(0);
    }
  });

  it('marks the Anthropic-native and the OpenAI-compatible providers apart', () => {
    expect(catalog.byId('anthropic').capabilities).toContain('native-anthropic');
    expect(catalog.byId('openai').capabilities).toContain('openai-compat');
  });

  it('marks a derived models.dev provider as OpenAI-compatible', () => {
    const derived = catalog.build().find(e => e.derived);
    expect(derived).toBeTruthy();
    expect(derived.capabilities).toContain('openai-compat');
  });

  it('tags a local runtime as local', () => {
    expect(catalog.byId('ollama').capabilities).toContain('local');
  });
});

describe('publicInstance', () => {
  const instance = {
    uid: 'u1', presetId: 'anthropic', name: 'Claude', protocol: 'anthropic',
    baseUrl: '', model: 'claude-sonnet-4-5', smallFastModel: 'claude-haiku-4-5',
  };

  it('carries the capabilities of the catalog entry', () => {
    expect(providers.publicInstance(instance).capabilities).toEqual(catalog.byId('anthropic').capabilities);
  });

  it('never carries a secret', () => {
    const view = providers.publicInstance({ ...instance, apiKey: 'sk-live-SECRET' });
    const text = JSON.stringify(view);
    expect(text).not.toContain('sk-live-SECRET');
    // The hint is a hint: a short excerpt, never the key itself.
    expect(view.hasAuth).toBe(true);
    expect(view.authHint.length).toBeLessThan(20);
    expect(view.authHint).not.toBe('sk-live-SECRET');
  });
});
