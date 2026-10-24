// Text-only ask mode: a model the catalog marks tool_call:false is sent no tools.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildOpenAIBody, buildGeminiBody, buildResponsesInput } = require('../src/main/adapters.js');
const modelsdev = require('../src/main/modelsdev.js');

const tools = [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }];
const prov = { presetId: 'notools-test' };
const withCatalog = (toolCall, fn) => {
  const real = modelsdev.model;
  modelsdev.model = (pid, id) => (pid === 'notools-test' && id === 'm' ? { tool_call: toolCall, limit: {} } : real(pid, id));
  try { return fn(); } finally { modelsdev.model = real; }
};

describe('tools gate', () => {
  it('withholds tools from a model that cannot call them, in every dialect', () => withCatalog(false, () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools };
    expect(buildOpenAIBody(body, false, prov).tools).toBeUndefined();
    expect(buildResponsesInput(body, prov).tools).toBeUndefined();
    expect(buildGeminiBody(body, prov).tools).toBeUndefined();
  }));

  it('keeps tools when the catalog allows them or has no verdict', () => {
    withCatalog(true, () => {
      expect(buildOpenAIBody({ model: 'm', messages: [], tools }, false, prov).tools).toHaveLength(1);
    });
    expect(buildOpenAIBody({ model: 'unknown', messages: [], tools }, false, { presetId: 'nope' }).tools).toHaveLength(1);
  });
});
