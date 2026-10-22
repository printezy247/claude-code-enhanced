// The OpenAI-format adapter: ONE request shape for every provider that speaks
// it (OpenAI, Groq, Mistral, Google AI Studio, NaraRouter, AgentRouter…).
//
// The old version of this file asserted on a literal defined in its own body
// and proved nothing. These assertions pin the shape the API actually accepts.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildOpenAIBody } = require('../src/main/adapters.js');

describe('buildOpenAIBody', () => {
  it('always produces a messages array and a model field', () => {
    const out = buildOpenAIBody({ model: 'm', messages: [] }, false, {});
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.model).toBe('m');
    expect(out.stream).toBe(false);
    expect(out.max_tokens).toBe(4096);
  });

  it('passes tool schemas through in the shape the OpenAI API accepts', () => {
    const out = buildOpenAIBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
    }, false, {});
    expect(out.tools).toEqual([{
      type: 'function',
      function: {
        name: 'Read',
        description: 'read a file',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    }]);
  });

  it('gives a tool with no schema an empty object, never undefined', () => {
    const out = buildOpenAIBody({ model: 'm', messages: [], tools: [{ name: 'Read' }] }, false, {});
    expect(out.tools[0].function.parameters).toEqual({ type: 'object', properties: {} });
    expect(out.tools[0].function.description).toBe('');
  });

  it('maps the tool choice onto the OpenAI spelling', () => {
    const mk = (tc) => buildOpenAIBody({ model: 'm', messages: [], tools: [{ name: 'Read' }], tool_choice: tc }, false, {}).tool_choice;
    expect(mk({ type: 'any' })).toBe('required');
    expect(mk({ type: 'tool', name: 'Read' })).toEqual({ type: 'function', function: { name: 'Read' } });
    expect(mk({ type: 'none' })).toBe('none');
    expect(mk(undefined)).toBe('auto');
  });

  it('asks for usage on a streaming call even when it carries no tools', () => {
    const out = buildOpenAIBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, true, {});
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.tools).toBeUndefined();
  });

  it('translates an Anthropic tool_result into an OpenAI tool message', () => {
    const out = buildOpenAIBody({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] },
      ],
    }, false, {});
    expect(out.messages.map(m => m.role)).toEqual(['assistant', 'tool']);
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'contents' });
  });

  it('keeps the system message first, where every provider accepts it', () => {
    const out = buildOpenAIBody({
      model: 'm',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'env note' }],
    }, false, {});
    expect(out.messages[0].role).toBe('system');
    expect(out.messages[0].content).toBe('You are helpful.\n\nenv note');
  });
});
