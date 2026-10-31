// The Shannon AI preset: an OpenAI-compatible API with bearer auth.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../src/main/catalog.js');
const providers = require('../src/main/providers.js');

describe('Shannon AI provider preset', () => {
  const e = catalog.byId('shannon');
  it('is in the catalog as an OpenAI-compatible, bearer-key provider', () => {
    expect(e).toBeTruthy();
    expect(e).toMatchObject({ display: 'Shannon AI', protocol: 'openai', authKind: 'api-key', keyHeader: 'bearer', baseUrl: 'https://api.shannon-ai.com/v1' });
  });
  it('has default models, and the base URL can be edited', () => {
    expect(e.defaultModel).toBe('shannon-3');
    expect(e.recommendedModels).toContain('shannon-coder-1');
    expect(e.editableBaseUrl).toBe(true);
  });
  it('makes an instance that points at the API', () => {
    const inst = providers.makeInstance(e, {});
    expect(inst).toMatchObject({ presetId: 'shannon', baseUrl: 'https://api.shannon-ai.com/v1', protocol: 'openai' });
  });
  it('is listed once', () => {
    expect(catalog.list ? catalog.list().filter((x) => x.id === 'shannon').length : 1).toBe(1);
  });
});
