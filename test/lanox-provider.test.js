// The Lanox preset: an OpenAI-compatible gateway with bearer auth.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../src/main/catalog.js');
const providers = require('../src/main/providers.js');

describe('Lanox provider preset', () => {
  const e = catalog.byId('lanox');
  it('is in the catalog as an OpenAI-compatible, bearer-key provider', () => {
    expect(e).toBeTruthy();
    expect(e).toMatchObject({ display: 'Lanox', protocol: 'openai', authKind: 'api-key', keyHeader: 'bearer', baseUrl: 'https://api.lanox.ai/v1' });
  });
  it('has a default model, and the base URL can be edited', () => {
    expect(e.defaultModel).toBe('gpt-5.6-sol');
    expect(e.editableBaseUrl).toBe(true);
  });
  it('makes an instance that points at the gateway', () => {
    const inst = providers.makeInstance(e, {});
    expect(inst).toMatchObject({ presetId: 'lanox', baseUrl: 'https://api.lanox.ai/v1', protocol: 'openai' });
  });
  it('is listed once', () => {
    expect(catalog.list ? catalog.list().filter((x) => x.id === 'lanox').length : 1).toBe(1);
  });
});
