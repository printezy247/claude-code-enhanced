// Request hygiene for non-Claude models: tool schemas each API accepts,
// effort / output limits gated by the catalog, images from tools, Gemini 3
// thought signatures.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adapters = require('../src/main/adapters.js');
const modelsdev = require('../src/main/modelsdev.js');
const { sanitizeSchema, buildOpenAIBody, buildGeminiBody, buildResponsesInput } = adapters;

const mcpSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['q', 'ghost'],
  properties: {
    q: { type: 'string', format: 'uri', minLength: 1 },
    mode: { const: 'fast' },
    opt: { type: ['string', 'null'], default: 'x' },
    n: { type: 'integer', exclusiveMinimum: 0 },
    pick: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nested: { type: 'object', additionalProperties: { type: 'string' }, properties: { $schema: { type: 'string' } } },
  },
};

describe('sanitizeSchema', () => {
  it('strips $schema for OpenAI-compatible servers and keeps the rest', () => {
    const out = sanitizeSchema(mcpSchema, 'openai');
    expect(out.$schema).toBeUndefined();
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.q.format).toBe('uri');
    expect(out.properties.mode.const).toBe('fast');
  });

  it('rewrites everything Gemini rejects', () => {
    const out = sanitizeSchema(mcpSchema, 'gemini');
    const p = out.properties;
    expect(out.$schema).toBeUndefined();
    expect(out.additionalProperties).toBeUndefined();
    expect(out.required).toEqual(['q']);                      // 'ghost' is not a property
    expect(p.q.format).toBeUndefined();                       // uri is not a Gemini format
    expect(p.mode).toEqual({ enum: ['fast'] });                // const -> enum
    expect(p.opt).toMatchObject({ type: 'string', nullable: true });
    expect(p.opt.default).toBeUndefined();
    expect(p.n.exclusiveMinimum).toBeUndefined();
    expect(p.pick).toMatchObject({ type: 'string', nullable: true });
    expect(p.pick.anyOf).toBeUndefined();
    expect(p.nested.additionalProperties).toBeUndefined();
    expect(p.nested.properties.$schema).toEqual({ type: 'string' });   // a property NAMED $schema survives
  });

  it('does not mutate its input and always returns an object schema', () => {
    const copy = JSON.stringify(mcpSchema);
    sanitizeSchema(mcpSchema, 'gemini');
    expect(JSON.stringify(mcpSchema)).toBe(copy);
    expect(sanitizeSchema(undefined, 'gemini')).toEqual({ type: 'object', properties: {} });
    expect(sanitizeSchema({ type: 'object' }, 'openai')).toEqual({ type: 'object', properties: {} });
  });

  it('is applied to the tools of every dialect', () => {
    const tools = [{ name: 't', description: 'd', input_schema: mcpSchema }];
    const o = buildOpenAIBody({ model: 'm', messages: [], tools }, false, {});
    expect(o.tools[0].function.parameters.$schema).toBeUndefined();
    const g = buildGeminiBody({ model: 'm', messages: [], tools }, {});
    expect(g.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined();
    const r = buildResponsesInput({ model: 'm', messages: [], tools }, {});
    expect(r.tools[0].parameters.$schema).toBeUndefined();
  });
});

describe('catalog gating', () => {
  // A throwaway catalog entry: reasoning off, no vision, 1000-token output cap.
  const prov = { presetId: 'phase3-test' };
  const withCatalog = (fn) => {
    const real = modelsdev.model;
    modelsdev.model = (pid, id) => (pid === 'phase3-test' && id === 'plain'
      ? { reasoning: false, tool_call: true, attachment: false, modalities: { input: ['text'] }, limit: { output: 1000 } } : real(pid, id));
    try { return fn(); } finally { modelsdev.model = real; }
  };
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

  it('drops effort, thinking and clamps max_tokens for a non-reasoning model', () => withCatalog(() => {
    const out = buildOpenAIBody({ model: 'plain', messages: [], max_tokens: 32000, effort: 'high', thinking: { budget_tokens: 4096 } }, false, prov);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
    expect(out.max_tokens).toBe(1000);
    const req = buildResponsesInput({ model: 'plain', messages: [], max_tokens: 32000, effort: 'high' }, prov);
    expect(req.reasoning).toBeUndefined();
    expect(req.max_output_tokens).toBe(1000);
  }));

  it('keeps effort for an uncatalogued model on a provider that accepts it', () => {
    const out = buildOpenAIBody({ model: 'unknown', messages: [], max_tokens: 32000, effort: 'high' }, false, { presetId: 'nope', reasoningParam: 'effort' });
    expect(out.reasoning_effort).toBe('high');
    expect(out.max_tokens).toBe(32000);
  });

  it('swaps images for a note when the model cannot see', () => withCatalog(() => {
    const out = buildOpenAIBody({ model: 'plain', messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, img] }] }, false, prov);
    expect(JSON.stringify(out.messages)).not.toContain('image_url');
    expect(JSON.stringify(out.messages)).toContain('cannot read images');
    const g = buildGeminiBody({ model: 'plain', messages: [{ role: 'user', content: [img] }] }, prov);
    expect(JSON.stringify(g.contents)).not.toContain('inlineData');
  }));
});

describe('images returned by tools', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_0_1', name: 'Read', input: { file_path: '/a.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_0_1', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] },
  ];

  it('OpenAI: tool message first, then the image as a user turn', () => {
    const out = buildOpenAIBody({ model: 'm', messages }, false, {});
    const roles = out.messages.map((m) => m.role);
    expect(roles).toEqual(['assistant', 'tool', 'user']);
    expect(out.messages[2].content[0].image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('Gemini: functionResponse then inlineData', () => {
    const g = buildGeminiBody({ model: 'm', messages }, {});
    const parts = g.contents[1].parts;
    expect(parts[0].functionResponse.response.output).toContain('shot');
    expect(parts[1].inlineData).toEqual({ mimeType: 'image/png', data: 'AAAA' });
  });
});

describe('Gemini thought signatures', () => {
  const google = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini' };
  const turn = (id) => [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  ];

  it('sends back the signature the model returned for that call id', () => {
    adapters.thoughtSignatures.set('call_0_77', 'SIG-ABC');
    const g = buildGeminiBody({ model: 'gemini-3-pro', messages: turn('call_0_77') }, google);
    expect(g.contents[1].parts[0].thoughtSignature).toBe('SIG-ABC');
  });

  it('uses the documented skip sentinel for Gemini 3 history it never saw', () => {
    const g = buildGeminiBody({ model: 'gemini-3-pro', messages: turn('call_0_unknown') }, google);
    expect(g.contents[1].parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
    const old = buildGeminiBody({ model: 'gemini-2.5-pro', messages: turn('call_0_unknown') }, google);
    expect(old.contents[1].parts[0].thoughtSignature).toBeUndefined();
  });
});

describe('Gemini signature capture from a real reply', () => {
  it('remembers the signature of a returned call and replays it on the next request', async () => {
    const google = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini', apiKey: 'k' };
    const reply = { candidates: [{ content: { parts: [{ functionCall: { name: 'Bash', args: { command: 'ls' } }, thoughtSignature: 'SIG-LIVE' }] }, finishReason: 'STOP' }] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const res = await adapters.callUpstream(google, { model: 'gemini-3-pro', messages: [{ role: 'user', content: 'go' }] }, false, undefined);
      const j = await res.json();
      const call = j.choices[0].message.tool_calls[0];
      const next = buildGeminiBody({
        model: 'gemini-3-pro',
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: 'Bash', input: { command: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] },
        ],
      }, google);
      expect(next.contents[1].parts[0].thoughtSignature).toBe('SIG-LIVE');
    } finally { globalThis.fetch = realFetch; }
  });
});
