// Batch B: long tool names, Mistral ids, sampling gates, parallel call slots, cache accounting.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wrapToolNames, shortName, wireToolId } = require('../src/main/toolnames.js');
const { buildOpenAIBody } = require('../src/main/adapters.js');
const { pickToolSlot, cachedFrom, anthropicUsage } = require('../src/main/proxy.js');
const modelsdev = require('../src/main/modelsdev.js');

const LONG = 'mcp__plugin_ecc_chrome-devtools__' + 'x'.repeat(50);
const schema = { type: 'object', properties: {} };

describe('long tool names (3.7)', () => {
  it('shortens to 64 characters, consistently and uniquely', () => {
    expect(shortName(LONG)).toHaveLength(64);
    expect(shortName(LONG)).toBe(shortName(LONG));
    expect(shortName(LONG + 'a')).not.toBe(shortName(LONG + 'b'));
    expect(shortName('Read')).toBe('Read');
  });
  it('rewrites tools, history and tool_choice, and maps replies back', () => {
    const body = {
      tools: [{ name: LONG, input_schema: schema }, { name: 'Read', input_schema: schema }],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: LONG, input: {} }] }],
      tool_choice: { type: 'tool', name: LONG },
    };
    const w = wrapToolNames(body);
    expect(w.body.tools[0].name).toHaveLength(64);
    expect(w.body.tools[1].name).toBe('Read');
    expect(w.body.messages[0].content[0].name).toBe(w.body.tools[0].name);
    expect(w.body.tool_choice.name).toBe(w.body.tools[0].name);
    expect(w.back(w.body.tools[0].name)).toBe(LONG);
    expect(w.back('Read')).toBe('Read');
    expect(body.tools[0].name).toBe(LONG);   // the input is untouched
  });
  it('returns the body as is when nothing is long', () => {
    const body = { tools: [{ name: 'Read', input_schema: schema }] };
    expect(wrapToolNames(body).body).toBe(body);
  });
});

describe('Mistral tool ids (3.6)', () => {
  const mistral = { baseUrl: 'https://api.mistral.ai/v1' };
  it('maps any id to nine letters or digits, the same way every time', () => {
    const id = wireToolId(mistral, 'toolu_01ABCDEFGHIJKLMNOP');
    expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(wireToolId(mistral, 'toolu_01ABCDEFGHIJKLMNOP')).toBe(id);
    expect(wireToolId(mistral, 'abc123xyz')).toBe('abc123xyz');
  });
  it('leaves other providers alone and pairs call and result', () => {
    expect(wireToolId({ baseUrl: 'https://api.openai.com/v1' }, 'toolu_1')).toBe('toolu_1');
    const out = buildOpenAIBody({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_LONGID_1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_LONGID_1', content: 'ok' }] },
    ] }, false, mistral);
    const call = out.messages.find((m) => m.tool_calls).tool_calls[0].id;
    expect(call).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(out.messages.find((m) => m.role === 'tool').tool_call_id).toBe(call);
  });
});

describe('sampling parameters (3.9)', () => {
  it('drops temperature and top_p for a model the catalog says rejects them', () => {
    const real = modelsdev.model;
    modelsdev.model = (pid, id) => (pid === 'temp-test' && id === 'm' ? { temperature: false } : real(pid, id));
    try {
      const out = buildOpenAIBody({ model: 'm', messages: [], temperature: 0.7, top_p: 0.9 }, false, { presetId: 'temp-test' });
      expect(out.temperature).toBeUndefined();
      expect(out.top_p).toBeUndefined();
    } finally { modelsdev.model = real; }
    expect(buildOpenAIBody({ model: 'x', messages: [], temperature: 0.7 }, false, { presetId: 'none' }).temperature).toBe(0.7);
  });
});

describe('parallel tool-call slots (3.10)', () => {
  it('routes an id-bearing chunk to the slot that holds that id', () => {
    const buf = new Map([[0, { id: 'a', real: true }], [1, { id: 'b', real: true }]]);
    expect(pickToolSlot(buf, { id: 'a', index: 1 })).toBe(0);
  });
  it('appends an index-less, id-less chunk to the call opened last', () => {
    const buf = new Map([[0, { id: 'a', real: true }], [1, { id: 'b', real: true }]]);
    expect(pickToolSlot(buf, { function: { arguments: '{"x"' } })).toBe(1);
  });
  it('still opens a new slot when an index is reused for a new id', () => {
    const buf = new Map([[0, { id: 'a', real: true }]]);
    expect(pickToolSlot(buf, { id: 'c', index: 0 })).toBe(1);
  });
});

describe('cache accounting (3.11)', () => {
  it('reads cached tokens from OpenAI, DeepSeek and Anthropic shaped usage', () => {
    expect(cachedFrom({ prompt_tokens_details: { cached_tokens: 900 } })).toBe(900);
    expect(cachedFrom({ prompt_cache_hit_tokens: 40 })).toBe(40);
    expect(cachedFrom({ cache_read_input_tokens: 7 })).toBe(7);
    expect(cachedFrom({})).toBe(0);
  });
  it('reports cache reads apart from input tokens, as the engine expects', () => {
    expect(anthropicUsage(1000, 50, 900)).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 });
    expect(anthropicUsage(1000, 50, 0)).toEqual({ input_tokens: 1000, output_tokens: 50 });
    expect(anthropicUsage(100, 5, 500).input_tokens).toBe(0);   // never negative
  });
  it('marks the system prompt for Claude models on OpenRouter', () => {
    const body = { model: 'anthropic/claude-sonnet-4.5', system: 'be brief', messages: [{ role: 'user', content: 'hi' }] };
    const out = buildOpenAIBody(body, false, { baseUrl: 'https://openrouter.ai/api/v1' });
    expect(out.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    const plain = buildOpenAIBody({ ...body, model: 'openai/gpt-5' }, false, { baseUrl: 'https://openrouter.ai/api/v1' });
    expect(typeof plain.messages[0].content).toBe('string');
  });
});
