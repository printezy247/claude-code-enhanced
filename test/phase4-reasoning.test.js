// Phase 4 (0.9.71): reasoning on the translated path. Earlier reasoning goes
// back to the providers whose thinking models need it, and reasoning settings
// go only to providers known to accept them.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildOpenAIBody, buildResponsesInput, reasoningParam, replaysReasoning } = require('../src/main/adapters.js');

const prov = (baseUrl, extra = {}) => ({ baseUrl, apiKey: 'k', protocol: 'openai', ...extra });
const ask = (model, extra = {}) => ({
  model, max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }],
  effort: 'high', thinking: { type: 'enabled', budget_tokens: 8000 }, ...extra,
});

describe('reasoning settings go only to providers that accept them', () => {
  it('OpenAI: reasoning_effort for o-series and GPT-5, nothing for other models, never a `reasoning` object', () => {
    const p = prov('https://api.openai.com/v1');
    for (const m of ['gpt-5', 'gpt-5.2-mini', 'o3', 'o4-mini']) {
      const out = buildOpenAIBody(ask(m), false, p);
      expect(out.reasoning_effort, m).toBe('high');
      expect(out.reasoning, m).toBeUndefined();
    }
    const plain = buildOpenAIBody(ask('gpt-4.1'), false, p);
    expect(plain.reasoning_effort).toBeUndefined();
    expect(plain.reasoning).toBeUndefined();
  });

  it('OpenRouter: one `reasoning` object, effort first, else the budget', () => {
    const p = prov('https://openrouter.ai/api/v1');
    expect(buildOpenAIBody(ask('anthropic/claude-sonnet-4'), false, p).reasoning).toEqual({ effort: 'high' });
    const noEffort = buildOpenAIBody(ask('x/y', { effort: undefined }), false, p);
    expect(noEffort.reasoning).toEqual({ max_tokens: 8000 });
    expect(noEffort.reasoning_effort).toBeUndefined();
  });

  it('Groq and xAI: only the models that take it', () => {
    expect(buildOpenAIBody(ask('openai/gpt-oss-120b'), false, prov('https://api.groq.com/openai/v1')).reasoning_effort).toBe('high');
    expect(buildOpenAIBody(ask('llama-3.3-70b'), false, prov('https://api.groq.com/openai/v1')).reasoning_effort).toBeUndefined();
    expect(buildOpenAIBody(ask('grok-3-mini'), false, prov('https://api.x.ai/v1')).reasoning_effort).toBe('high');
    expect(buildOpenAIBody(ask('grok-4'), false, prov('https://api.x.ai/v1')).reasoning_effort).toBeUndefined();
  });

  it('an unknown OpenAI-compatible server gets neither field (it would answer 400)', () => {
    const out = buildOpenAIBody(ask('some-model'), false, prov('https://llm.example.com/v1'));
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
  });

  it('a provider entry can force the choice', () => {
    expect(buildOpenAIBody(ask('m'), false, prov('https://llm.example.com/v1', { reasoningParam: 'effort' })).reasoning_effort).toBe('high');
    expect(buildOpenAIBody(ask('gpt-5'), false, prov('https://api.openai.com/v1', { reasoningParam: 'none' })).reasoning_effort).toBeUndefined();
    expect(reasoningParam(prov('https://llm.example.com/v1', { reasoningParam: 'openrouter' }), 'm')).toBe('openrouter');
  });

  it('Claude-only levels are clamped, and output_config.effort is read', () => {
    const p = prov('https://api.openai.com/v1');
    expect(buildOpenAIBody(ask('gpt-5', { effort: 'max' }), false, p).reasoning_effort).toBe('high');
    expect(buildOpenAIBody(ask('gpt-5', { effort: undefined, output_config: { effort: 'low' } }), false, p).reasoning_effort).toBe('low');
  });

  it('the Responses API gets a clamped level too', () => {
    const req = buildResponsesInput(ask('gpt-5', { effort: 'max' }), prov('https://api.openai.com/v1'));
    expect(req.reasoning).toEqual({ effort: 'high' });
  });
});

describe('earlier reasoning is handed back to thinking models', () => {
  const history = (thinking) => ({
    model: 'deepseek-v4-flash', max_tokens: 1024,
    messages: [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking, signature: '' },
        { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a.txt' }] },
    ],
  });
  const assistantOf = (out) => out.messages.find((m) => m.role === 'assistant');

  it('DeepSeek, Kimi and MiniMax get reasoning_content on the assistant turn with the tool call', () => {
    for (const [model, base] of [
      ['deepseek-v4-flash', 'https://api.deepseek.com/v1'],
      ['kimi-k2-thinking', 'https://api.moonshot.ai/v1'],
      ['MiniMax-M2', 'https://api.minimax.io/v1'],
      ['deepseek/deepseek-v3.2', 'https://openrouter.ai/api/v1'],
    ]) {
      const out = buildOpenAIBody({ ...history('I should list the files'), model }, false, prov(base));
      const a = assistantOf(out);
      expect(a.reasoning_content, model).toBe('I should list the files');
      expect(a.tool_calls, model).toHaveLength(1);
    }
  });

  it('other models do not get the field', () => {
    const out = buildOpenAIBody({ ...history('thinking'), model: 'gpt-5' }, false, prov('https://api.openai.com/v1'));
    expect(assistantOf(out).reasoning_content).toBeUndefined();
  });

  it('empty reasoning is not sent, and a thinking-only turn is still dropped', () => {
    const out = buildOpenAIBody(history('   '), false, prov('https://api.deepseek.com/v1'));
    expect(assistantOf(out).reasoning_content).toBeUndefined();
    const only = buildOpenAIBody({ model: 'deepseek-v4-flash', messages: [
      { role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: '' }] },
    ] }, false, prov('https://api.deepseek.com/v1'));
    expect(only.messages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('a provider entry can force it on or off', () => {
    expect(replaysReasoning(prov('https://llm.example.com/v1', { replayReasoning: true }), 'x')).toBe(true);
    expect(replaysReasoning(prov('https://api.deepseek.com/v1', { replayReasoning: false }), 'deepseek-chat')).toBe(false);
  });
});
