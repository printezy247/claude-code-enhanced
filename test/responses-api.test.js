// The proxy's OpenAI Responses endpoint (what Codex speaks since Feb 2026),
// run against a fake chat-completions provider. Mirrors a real Codex 0.165
// exchange: developer prompt, function tools, a namespace and web_search,
// a tool call and its output, then the final answer.
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { startProxy } = require('../src/main/proxy.js');
const { responsesToAnthropic } = require('../src/main/responses.js');

const seen = [];
let upstream; let proxy;
async function setup() {
  if (proxy) return proxy;
  upstream = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const j = JSON.parse(b); seen.push(j);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (!j.messages.some((m) => m.role === 'tool')) {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Running it.' } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'done' } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 2 } });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  proxy = await startProxy(async () => ({ baseUrl: base, apiKey: 'k', protocol: 'openai' }), { token: 'tok' });
  return proxy;
}
afterAll(() => { try { proxy.server.close(); upstream.close(); } catch { /* closed */ } });

async function post(body) {
  const p = await setup();
  const r = await fetch('http://127.0.0.1:' + p.port + '/px/u1/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  const events = [];
  for (const frame of text.split('\n\n')) {
    const ev = (frame.match(/^event: (.*)$/m) || [])[1];
    const data = (frame.match(/^data: (.*)$/m) || [])[1];
    if (ev && data) events.push([ev, JSON.parse(data)]);
  }
  return { status: r.status, events, text };
}

const TOOLS = [
  { type: 'function', name: 'exec_command', description: 'Run', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'namespace', name: 'multi_agent_v1', tools: [] },
  { type: 'web_search' },
];

describe('Responses API on the proxy', () => {
  it('translates the request: developer prompt to system, hosted tools dropped', () => {
    const { body } = responsesToAnthropic({ model: 'm', stream: true, tools: TOOLS,
      input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be brief' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] });
    expect(body.system).toBe('be brief');
    expect(body.tools.map((t) => t.name)).toEqual(['exec_command']);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('streams text and a function call as Responses events', async () => {
    const { status, events } = await post({ model: 'qwen3-coder', stream: true, tools: TOOLS,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run echo' }] }] });
    expect(status).toBe(200);
    const names = events.map((e) => e[0]);
    expect(names[0]).toBe('response.created');
    expect(names).toContain('response.output_text.delta');
    expect(names).toContain('response.function_call_arguments.delta');
    expect(names[names.length - 1]).toBe('response.completed');
    const done = events[events.length - 1][1].response;
    const call = done.output.find((o) => o.type === 'function_call');
    expect(call).toMatchObject({ name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"echo hi"}' });
    expect(done.output.find((o) => o.type === 'message').content[0].text).toBe('Running it.');
    expect(done.usage).toMatchObject({ input_tokens: 100, output_tokens: 10 });
  });

  it('sends the tool output back and returns the answer', async () => {
    const { events } = await post({ model: 'qwen3-coder', stream: true, tools: TOOLS, input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run echo' }] },
      { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"echo hi"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'hi\n' },
    ] });
    const last = seen[seen.length - 1];
    expect(last.messages.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'call_1' });
    const done = events[events.length - 1][1].response;
    expect(done.status).toBe('completed');
    expect(done.output[0].content[0].text).toBe('done');
  });

  it('answers a non-streaming request with one response object', async () => {
    const { status, text } = await post({ model: 'qwen3-coder', stream: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }] });
    expect(status).toBe(200);
    const r = JSON.parse(text);
    expect(r.object).toBe('response');
    expect(r.status).toBe('completed');
  });
});
