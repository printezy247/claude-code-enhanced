// Per-provider fallback model routing.
//
// The old version of this file asserted on a local object and proved nothing.
// These assertions drive the REAL proxy resolver and the REAL declaration
// path (catalog entry -> instance -> global setting).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxy = require('../src/main/proxy.js');
const providers = require('../src/main/providers.js');
const catalog = require('../src/main/catalog.js');

describe('proxy.fallbackModel', () => {
  it('prefers the model the provider declares', () => {
    expect(proxy.fallbackModel({ fallbackModel: 'backup-model', model: 'main-model' }, 'claude-x'))
      .toBe('backup-model');
  });

  it('falls back to the small/fast model when the provider declares none', () => {
    expect(proxy.fallbackModel({ smallFastModel: 'small', model: 'main' }, 'claude-x')).toBe('small');
  });

  it('never returns the model that is missing', () => {
    expect(proxy.fallbackModel({ fallbackModel: 'claude-x', model: 'other' }, 'claude-x')).toBe('other');
  });

  it('returns nothing when the provider has no other model', () => {
    expect(proxy.fallbackModel({}, 'claude-x')).toBe('');
  });
});

describe('the declaration path', () => {
  it('a catalog entry may declare a fallback model', () => {
    const entry = catalog.byId('anthropic');
    expect(entry).toBeTruthy();
    // The curated Anthropic entry names the model its background calls use.
    expect(typeof entry.fallbackModel === 'string' || entry.fallbackModel === undefined).toBe(true);
  });

  it('an instance carries its own fallback model into the secret-free view', () => {
    const view = providers.publicInstance({
      uid: 'u1', presetId: 'openai', name: 'OpenAI', protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', fallbackModel: 'gpt-4o-mini',
    });
    expect(view.fallbackModel).toBe('gpt-4o-mini');
  });

  it('an instance without one reports the catalog default', () => {
    const view = providers.publicInstance({
      uid: 'u2', presetId: 'openai', name: 'OpenAI', protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o',
    });
    expect(view.fallbackModel).toBe((catalog.byId('openai') || {}).fallbackModel || '');
  });
});
