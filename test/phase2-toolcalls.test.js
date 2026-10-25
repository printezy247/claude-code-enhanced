// Phase 2 (0.9.69): what counts as a tool call on the translated path.
//
// Every case here is one the harness review proved: prose that shows a JSON
// example must not run, a call that arrives twice runs once, a model's JSON
// slip is mended but a cut-off call never is, and Gemini / Responses endings
// that are not a clean finish say so.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const { startProxy, extractTextToolCalls, aggregateToAnthropic } = require('../src/main/proxy.js');
const { resolveToolName, callSignature, repairToolArgs, requiresArgs } = require('../src/main/toolcalls.js');
const adapters = require('../src/main/adapters.js');

const KNOWN = new Set(['Bash', 'Read', 'Write', 'mcp__srv__search']);

describe('resolveToolName', () => {
  it('keeps an exact name, maps loose spellings, refuses unknown tools', () => {
    expect(resolveToolName('Bash', KNOWN)).toBe('Bash');
    expect(resolveToolName('bash', KNOWN)).toBe('Bash');
    expect(resolveToolName('read_file', KNOWN)).toBe('Read');
    expect(resolveToolName('search', KNOWN)).toBe('mcp__srv__search');
    expect(resolveToolName('rm_everything', KNOWN)).toBeNull();
  });
  it('a request with no tools can run nothing', () => {
    expect(resolveToolName('Bash', new Set())).toBeNull();
  });
  it('does not map onto a tool the request lacks', () => {
    expect(resolveToolName('shell', new Set(['Read']))).toBeNull();
  });
});

describe('callSignature', () => {
  it('ignores key order and string-vs-object arguments', () => {
    expect(callSignature('Bash', '{"b":1,"a":2}')).toBe(callSignature('Bash', { a: 2, b: 1 }));
    expect(callSignature('Bash', { a: 1 })).not.toBe(callSignature('Read', { a: 1 }));
  });
});

describe('repairToolArgs', () => {
  it('mends a model slip', () => {
    expect(repairToolArgs('{"a": 1,}')).toEqual({ a: 1 });
    expect(repairToolArgs('{"a": True, "b": None}')).toEqual({ a: true, b: null });
    expect(repairToolArgs("{'command': 'ls'}")).toEqual({ command: 'ls' });
    expect(repairToolArgs('{"a": {"b": [1, 2]}')).toEqual({ a: { b: [1, 2] } });
    expect(repairToolArgs('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('never closes an unfinished string (that is a cut-off, not a slip)', () => {
    expect(repairToolArgs('{"file_path":"a.js","content":"line1\\nline2')).toBeNull();
    expect(repairToolArgs('not json')).toBeNull();
    expect(repairToolArgs('')).toBeNull();
  });
});

describe('requiresArgs', () => {
  const tools = [{ name: 'A', input_schema: { required: ['x'] } }, { name: 'B', input_schema: {} }];
  it('reads the schema', () => {
    expect(requiresArgs(tools, 'A')).toBe(true);
    expect(requiresArgs(tools, 'B')).toBe(false);
    expect(requiresArgs(tools, 'C')).toBe(false);
  });
});

describe('extractTextToolCalls with the request\'s tools', () => {
  it('leaves a JSON example in prose alone (the proven rm_everything case)', () => {
    const prose = 'A call looks like {"name": "rm_everything", "arguments": {"path": "/"}} in the docs.';
    const r = extractTextToolCalls(prose, '', KNOWN);
    expect(r.tools).toEqual([]);
    expect(r.text).toBe(prose);
  });
  it('still recovers a real call and maps its name', () => {
    const r = extractTextToolCalls('{"name":"bash","arguments":{"command":"ls"}}', '', KNOWN);
    expect(r.tools).toEqual([{ name: 'Bash', args: { command: 'ls' } }]);
  });
  it('keeps the words around an unusable blob (they used to vanish)', () => {
    const r = extractTextToolCalls('hello {"name":"x","arguments":"notjson"} bye', '');
    expect(r.text).toBe('hello {"name":"x","arguments":"notjson"} bye');
  });
  it('wrapped example to an unknown tool stays text', () => {
    const t = 'see <tool_call>{"name":"nope","arguments":{}}</tool_call> ok';
    expect(extractTextToolCalls(t, '', KNOWN).text).toBe(t);
  });
});

describe('aggregated reply', () => {
  const agg = (message, finish = 'stop', tools = [{ name: 'Read', input_schema: { required: ['file_path'] } }]) =>
    aggregateToAnthropic({ choices: [{ message, finish_reason: finish }], usage: {} }, { model: 'm', tools });
  const uses = (j) => j.content.filter((b) => b.type === 'tool_use');

  it('runs a call once when it is in the reasoning and structured', () => {
    const j = agg({
      content: '', reasoning: '<tool_call>{"name":"Read","arguments":{"file_path":"/a"}}</tool_call>',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }],
    }, 'tool_calls');
    expect(uses(j)).toHaveLength(1);
  });
  it('mends a trailing comma instead of dropping the call', () => {
    const j = agg({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a",}' } }] }, 'tool_calls');
    expect(uses(j)[0].input).toEqual({ file_path: '/a' });
  });
  it('a cut-off call is not run and not mended', () => {
    const j = agg({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a' } }] }, 'length');
    expect(uses(j)).toHaveLength(0);
    expect(j.content.map((b) => b.text).join('')).toMatch(/cut off/);
    expect(j.stop_reason).toBe('max_tokens');
  });
  it('unusable arguments from a finished reply reach the engine so it can say what is missing', () => {
    const j = agg({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: 'file_path=/a' } }] }, 'tool_calls');
    expect(uses(j)).toHaveLength(1);
    expect(uses(j)[0].input).toEqual({});
    expect(j.stop_reason).toBe('tool_use');
  });
  it('a loose structured name is mapped to the real tool', () => {
    const j = agg({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/a"}' } }] }, 'tool_calls');
    expect(uses(j)[0].name).toBe('Read');
  });
  it('prose JSON about an unknown tool is not run', () => {
    const j = agg({ content: 'e.g. {"name":"rm_everything","arguments":{"path":"/"}}' }, 'stop');
    expect(uses(j)).toHaveLength(0);
  });
});

async function viaProxy(upstreamHandler, body) {
  const upstream = http.createServer(upstreamHandler);
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKey: 'k' }), { token: 't0k', port: 0 });
  const res = await fetch('http://127.0.0.1:' + proxy.port + '/px/t1/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t0k' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  await new Promise((r) => proxy.server.close(r));
  await new Promise((r) => upstream.close(r));
  return { status: res.status, text };
}
const sseTools = (text) => [...text.matchAll(/"content_block":\{"type":"tool_use","id":"([^"]*)","name":"([^"]*)"/g)].map((m) => m[2]);
const READ = { name: 'Read', description: 'r', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
const sse = (res, objs) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const o of objs) res.write('data: ' + JSON.stringify(o) + '\n\n'); };

describe('streamed reply', () => {
  const ask = (chunks, tools = [READ], end = true) => viaProxy((_q, res) => { sse(res, chunks); if (end) res.end('data: [DONE]\n\n'); else res.end(); },
    { model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'x' }], tools });

  it('prose that shows a call to an unknown tool is shown, not run', async () => {
    const r = await ask([
      { choices: [{ delta: { content: 'Example: {"name":"rm_everything","arguments":{"path":"/"}} ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    expect(sseTools(r.text)).toEqual([]);
    expect(r.text).toContain('rm_everything');
    expect(r.text).toContain('"stop_reason":"end_turn"');
  });

  it('a call in the reasoning and the same call structured runs once, after the thinking', async () => {
    const r = await ask([
      { choices: [{ delta: { reasoning_content: 'plan <tool_call>{"name":"Read","arguments":{"file_path":"/a"}}</tool_call>' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(sseTools(r.text)).toEqual(['Read']);
    expect(r.text.indexOf('thinking_delta')).toBeLessThan(r.text.indexOf('"type":"tool_use"'));
  });

  it('mends a finished reply with a trailing comma', async () => {
    const r = await ask([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/a",}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(sseTools(r.text)).toEqual(['Read']);
    expect(r.text).toContain('{\\"file_path\\":\\"/a\\"}');
    expect(r.text).not.toContain(',}');
  });

  it('a cut-off call (output limit) is not run, is not mended, and says so', async () => {
    const r = await ask([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/a' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);
    expect(sseTools(r.text)).toEqual([]);
    expect(r.text).toContain('cut off');
    expect(r.text).toContain('"stop_reason":"max_tokens"');
  });

  it('a stream that dies inside a call, with nothing else said, is reported so the engine retries', async () => {
    const r = await ask([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/a' } }] } }] },
    ], [READ], false);
    expect(r.text).toContain('event: error');
    expect(r.text).toContain('middle of a tool call');
    expect(sseTools(r.text)).toEqual([]);
  });

  it('a finished reply with unusable arguments still reaches the engine', async () => {
    const r = await ask([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: 'file_path=/a' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(sseTools(r.text)).toEqual(['Read']);
    expect(r.text).toContain('"stop_reason":"tool_use"');
  });
});

const body = (text) => ({ body: (async function* () { yield Buffer.from(text); })() });
const collect = async (gen) => { const out = []; for await (const c of gen) out.push(c); return out; };
const finishOf = (out) => (out.find((c) => c.choices && c.choices[0] && c.choices[0].finish_reason) || { choices: [{}] }).choices[0].finish_reason;

describe('Gemini endings', () => {
  it('a malformed tool call is reported as a failure the engine retries', async () => {
    const out = await collect(adapters.geminiChunks(body('data: {"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}]}\n\n'), 'm'));
    expect(out.some((c) => c.error && /malformed/i.test(c.error.message))).toBe(true);
  });
  it('MAX_TOKENS is a cut, SAFETY says why', async () => {
    expect(finishOf(await collect(adapters.geminiChunks(body('data: {"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"a"}]}}]}\n\n'), 'm')))).toBe('length');
    const safe = await collect(adapters.geminiChunks(body('data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n'), 'm'));
    expect(JSON.stringify(safe)).toContain('SAFETY');
  });
  it('a blocked prompt (no candidate) says so', async () => {
    const out = await collect(adapters.geminiChunks(body('data: {"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}\n\n'), 'm'));
    expect(JSON.stringify(out)).toContain('PROHIBITED_CONTENT');
  });
  it('the non-streamed reply gets the same treatment', () => {
    expect(adapters.geminiToOpenAI({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }, 'm').error).toBeTruthy();
    const cut = adapters.geminiToOpenAI({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'a' }] } }] }, 'm');
    expect(cut.choices[0].finish_reason).toBe('length');
    const safe = adapters.geminiToOpenAI({ candidates: [{ finishReason: 'SAFETY' }] }, 'm');
    expect(safe.choices[0].message.content).toContain('SAFETY');
  });
});

describe('Responses API endings', () => {
  const ev = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
  it('keeps two calls\' arguments apart even when the delta names only its item', async () => {
    const out = await collect(adapters.responsesChunks(body(
      ev({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'i0', call_id: 'c0', name: 'A' } })
      + ev({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'i1', call_id: 'c1', name: 'B' } })
      + ev({ type: 'response.function_call_arguments.delta', item_id: 'i0', delta: '{"a":1}' })
      + ev({ type: 'response.function_call_arguments.delta', item_id: 'i1', delta: '{"b":2}' })
      + ev({ type: 'response.completed', response: { usage: {} } }),
    ), 'm'));
    const args = {};
    for (const c of out) for (const t of (c.choices && c.choices[0].delta.tool_calls) || []) args[t.index] = (args[t.index] || '') + t.function.arguments;
    expect(args).toEqual({ 0: '{"a":1}', 1: '{"b":2}' });
  });
  it('an unknown item id falls back to the call opened last, not call 0', async () => {
    const out = await collect(adapters.responsesChunks(body(
      ev({ type: 'response.output_item.added', item: { type: 'function_call', id: 'i0', call_id: 'c0', name: 'A' } })
      + ev({ type: 'response.output_item.added', item: { type: 'function_call', id: 'i1', call_id: 'c1', name: 'B' } })
      + ev({ type: 'response.function_call_arguments.delta', item_id: 'zzz', delta: '{}' }),
    ), 'm'));
    const last = out.filter((c) => c.choices && c.choices[0].delta.tool_calls).pop();
    expect(last.choices[0].delta.tool_calls[0].index).toBe(1);
  });
  it('takes a call that only arrives in output_item.done', async () => {
    const out = await collect(adapters.responsesChunks(body(
      ev({ type: 'response.output_item.done', item: { type: 'function_call', id: 'i0', call_id: 'c0', name: 'A', arguments: '{"x":1}' } })
      + ev({ type: 'response.completed', response: { usage: {} } }),
    ), 'm'));
    const call = out.map((c) => c.choices && c.choices[0].delta.tool_calls).filter(Boolean)[0][0];
    expect(call.function).toEqual({ name: 'A', arguments: '{"x":1}' });
    expect(finishOf(out)).toBe('tool_calls');
  });
  it('response.failed is an error, not an empty finish', async () => {
    const out = await collect(adapters.responsesChunks(body(ev({ type: 'response.failed', response: { error: { message: 'boom' } } })), 'm'));
    expect(out[0].error.message).toBe('boom');
  });
  it('the non-streamed reply: incomplete is a cut, failed is an error', () => {
    expect(adapters.responsesToOpenAI({ status: 'incomplete', output: [] }, 'm').choices[0].finish_reason).toBe('length');
    expect(adapters.responsesToOpenAI({ status: 'failed', error: { message: 'no' }, output: [] }, 'm').error.message).toBe('no');
  });
});
