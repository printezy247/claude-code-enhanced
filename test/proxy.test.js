// Translator proxy: auth, tool-call recovery, usage reporting, abort.
//
// These are the tests for the failing local-model tool-calling path (#1) and the
// unauthenticated-proxy hole (#8). Every upstream is a local fake server, so no
// API key or network access is needed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const { startProxy, isTokenValid, extractTextToolCalls, parseToolJson, openaiBase } = require('../src/main/proxy.js');

/** Listen on an ephemeral port. */
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', r));
const close = (server) => new Promise(r => server.close(r));

/** Collect Anthropic SSE frames into a flat array. */
function parseSse(text) {
  const frames = [];
  for (const m of text.matchAll(/event: (\w+)\ndata: (.*)\n/g)) {
    frames.push({ event: m[1], data: JSON.parse(m[2]) });
  }
  return frames;
}

/** Rebuild tool_use blocks (name + input JSON) from an SSE body. */
function toolsFromSse(text) {
  const out = new Map();
  let cur = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let j;
    try { j = JSON.parse(line.slice(6)); } catch { continue; }
    if (j.type === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') {
      cur = { id: j.content_block.id, name: j.content_block.name, args: '' };
      out.set(j.content_block.id, cur);
    } else if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'input_json_delta' && cur) {
      cur.args += j.delta.partial_json;
    }
  }
  return [...out.values()];
}

const TOKEN = 'test-token-abcdef0123456789';

/** Build a proxy in front of an upstream that replays `chunks` as SSE. */
async function withProxy(upstreamHandler, opts = {}) {
  const upstream = http.createServer(upstreamHandler);
  await listen(upstream);
  const upPort = upstream.address().port;
  const proxy = await startProxy(
    () => ({ baseUrl: 'http://127.0.0.1:' + upPort, apiKey: 'sk-upstream' }),
    { token: TOKEN, port: 0 },
  );
  const call = (path, body, headers = {}) => fetch(
    'http://127.0.0.1:' + proxy.port + '/px/t1' + path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    },
  );
  return {
    proxy, call,
    async close() { await close(proxy.server); await close(upstream); },
  };
}

describe('proxy auth (#8)', () => {
  let h;
  beforeAll(async () => {
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  afterAll(() => h.close());

  it('rejects a request with no token', async () => {
    const res = await fetch('http://127.0.0.1:' + h.proxy.port + '/px/t1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error.type).toBe('authentication_error');
  });

  it('rejects a wrong token', async () => {
    const res = await fetch('http://127.0.0.1:' + h.proxy.port + '/px/t1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'nope' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts the token via Authorization, x-api-key and x-cce-proxy-token', async () => {
    for (const key of ['authorization', 'x-api-key', 'x-cce-proxy-token']) {
      const value = key === 'authorization' ? 'Bearer ' + TOKEN : TOKEN;
      const res = await fetch('http://127.0.0.1:' + h.proxy.port + '/px/t1/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [key]: value },
        body: JSON.stringify({ model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
      });
      expect(res.status, 'header ' + key).toBe(200);
    }
  });

  it('isTokenValid rejects wrong-length and wrong-value tokens', () => {
    const req = (h) => ({ headers: h || {} });
    expect(isTokenValid(req({ authorization: 'Bearer ' + TOKEN }), TOKEN)).toBe(true);
    expect(isTokenValid(req({ authorization: 'Bearer short' }), TOKEN)).toBe(false);
    expect(isTokenValid(req({}), TOKEN)).toBe(false);
  });
});

describe('tool-call recovery from the text channel (#1)', () => {
  // Pure-function level: every shape a 3-4B model actually emitted.
  it('parses a fenced <tool_call> block', () => {
    const r = extractTextToolCalls('before <tool_call>{"name":"Read","arguments":{"file_path":"/a"}}</tool_call> after', '');
    expect(r.tools).toEqual([{ name: 'Read', args: { file_path: '/a' } }]);
    expect(r.text).toBe('before  after');
  });

  it('parses a bare JSON call with a dangling close tag (the screenshot case)', () => {
    const raw = '{"name": "mcp__supabase__get_project_url", "arguments": {"project_id": "x"}}</tool_call>';
    const r = extractTextToolCalls(raw, '');
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0].name).toBe('mcp__supabase__get_project_url');
    expect(r.tools[0].args).toEqual({ project_id: 'x' });
  });

  it('parses a bare JSON call with no tag at all', () => {
    const r = extractTextToolCalls('{"name":"Bash","arguments":{"command":"ls"}}', '');
    expect(r.tools[0].name).toBe('Bash');
  });

  it('holds an incomplete call back until it is complete', () => {
    const first = extractTextToolCalls('text {"name":"Rea', '');
    expect(first.tools).toHaveLength(0);
    expect(first.carry).toContain('Rea');
    const second = extractTextToolCalls('d","arguments":{"file_path":"/b"}}', first.carry);
    expect(second.tools[0].name).toBe('Read');
    expect(second.tools[0].args.file_path).toBe('/b');
  });

  it('leaves ordinary prose and code alone', () => {
    const prose = 'Here is the JSON you asked for: {"name": "not-a-call"} and some text.';
    const r = extractTextToolCalls(prose, '');
    expect(r.tools).toHaveLength(0);
    expect(r.text).toBe(prose);
  });

  it('leaves a JSON object without arguments as text', () => {
    const r = extractTextToolCalls('{"name":"config"}', '');
    expect(r.tools).toHaveLength(0);
  });

  it('tolerates a markdown-fenced payload and string arguments', () => {
    expect(parseToolJson('```json\n{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}\n```'))
      .toEqual({ name: 'Bash', args: { command: 'ls' } });
  });

  it('returns null for unparseable payloads instead of throwing', () => {
    expect(parseToolJson('not json')).toBeNull();
    expect(parseToolJson('{"arguments":{}}')).toBeNull();
  });
});

describe('streamed translation end to end (#1, #9)', () => {
  let h;
  afterAll(() => h && h.close());

  it('turns a text-channel tool call into a real tool_use block', async () => {
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const s = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      // Two chunks, the call split across them, plus surrounding prose.
      s({ choices: [{ delta: { content: 'Let me look. <tool_call>{"name":"Read",' } }] });
      s({ choices: [{ delta: { content: '"arguments":{"file_path":"/x/y.ts"}}</tool_call> done' } }] });
      s({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    });
    const body = { model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'read /x/y.ts' }] };
    const res = await h.call('/v1/messages', body);
    const text = await res.text();
    const tools = toolsFromSse(text);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Read');
    expect(JSON.parse(tools[0].args)).toEqual({ file_path: '/x/y.ts' });
    expect(text).toContain('"stop_reason":"tool_use"');
    // The prose around the call must survive as a text block.
    expect(text).toContain('Let me look');
  });

  it('reports non-zero input tokens so the context meter works (#9)', async () => {
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4242, completion_tokens: 7 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    const res = await h.call('/v1/messages', {
      model: 'm', max_tokens: 8, stream: true,
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
    });
    const text = await res.text();
    const frames = parseSse(text);
    const start = frames.find(f => f.event === 'message_start');
    const delta = frames.find(f => f.event === 'message_delta');
    expect(start.data.message.usage.input_tokens).toBeGreaterThan(0);
    expect(delta.data.usage.output_tokens).toBe(7);
  });

  it('estimates input tokens when the provider sends no usage', async () => {
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    const text = await (await h.call('/v1/messages', {
      model: 'm', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'x'.repeat(800) }],
    })).text();
    const start = parseSse(text).find(f => f.event === 'message_start');
    expect(start.data.message.usage.input_tokens).toBeGreaterThan(100);
  });

  it('keeps parallel structured tool calls intact (regression)', async () => {
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const s = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const tc = (i, id, name, args) => s({ choices: [{ delta: { tool_calls: [{ index: i, id, function: { name, arguments: args } }] } }] });
      tc(0, 'call_a', 'get_weather', '{"city":');
      tc(1, 'call_b', 'get_time', '{"zone":');
      tc(0, null, null, '"Berlin"}');
      tc(1, null, null, '"UTC"}');
      s({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      res.end('data: [DONE]\n\n');
    });
    const text = await (await h.call('/v1/messages', {
      model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'x' }],
    })).text();
    const names = toolsFromSse(text).map(t => t.name).sort();
    expect(names).toEqual(['get_time', 'get_weather']);
  });

  it('forwards a forced tool_choice (#plan mode)', async () => {
    let seen = null;
    h = await withProxy((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        seen = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
    await h.call('/v1/messages', {
      model: 'm', max_tokens: 8, stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'ExitPlanMode', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'ExitPlanMode' },
    });
    expect(seen.tool_choice).toEqual({ type: 'function', function: { name: 'ExitPlanMode' } });
  });

  it('aborts the upstream when the client disconnects (#10)', async () => {
    let upstreamClosed = false;
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) { clearInterval(timer); upstreamClosed = true; return; }
        n++;
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n');
      }, 10);
      res.on('close', () => { clearInterval(timer); upstreamClosed = true; });
    });
    const ac = new AbortController();
    const p = fetch('http://127.0.0.1:' + h.proxy.port + '/px/t1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ model: 'm', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'x' }] }),
      signal: ac.signal,
    }).then(r => r.body.getReader().read()).catch(() => null);
    await new Promise(r => setTimeout(r, 80));
    ac.abort();
    await p;
    await new Promise(r => setTimeout(r, 120));
    expect(upstreamClosed).toBe(true);
  });
});
describe('upstream URL building (bare Ollama roots)', () => {
  it('appends /v1 to a bare server root', () => {
    expect(openaiBase('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(openaiBase('http://localhost:11434/')).toBe('http://localhost:11434/v1');
    expect(openaiBase('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1');
  });

  it('leaves full OpenAI roots alone', () => {
    expect(openaiBase('https://api.mistral.ai/v1')).toBe('https://api.mistral.ai/v1');
    expect(openaiBase('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1');
    expect(openaiBase('https://generativelanguage.googleapis.com/v1beta/openai'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(openaiBase('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
  });

  it('normalises provider-style roots that omit /v1', () => {
    expect(openaiBase('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1');
  });

  it('forwards chat completions to the /v1 root', async () => {
    let seenPath = null;
    const upstream = http.createServer((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: {} }));
    });
    await listen(upstream);
    const upPort = upstream.address().port;
    // A bare root, exactly how the Ollama provider is configured.
    const proxy = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:' + upPort, apiKey: '' }), { port: 0 });
    const res = await fetch('http://127.0.0.1:' + proxy.port + '/px/t1/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(200);
    expect(seenPath).toBe('/v1/chat/completions');
    await close(proxy.server);
    await close(upstream);
  });

  it('fetches the model list from the /v1 root', async () => {
    let seenPath = null;
    const upstream = http.createServer((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    await listen(upstream);
    const upPort = upstream.address().port;
    const proxy = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:' + upPort, apiKey: '' }), { port: 0 });
    const res = await fetch('http://127.0.0.1:' + proxy.port + '/px/t1/v1/models');
    expect(res.status).toBe(200);
    expect(seenPath).toBe('/v1/models');
    await close(proxy.server);
    await close(upstream);
  });
});

describe('aggregate (non-streamed) translation', () => {
  /** POST a non-streamed turn and return the Anthropic body. */
  async function aggregate(upstreamBody) {
    const upstream = http.createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstreamBody));
    });
    await listen(upstream);
    const upPort = upstream.address().port;
    const proxy = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:' + upPort, apiKey: '' }), { port: 0 });
    const res = await fetch('http://127.0.0.1:' + proxy.port + '/px/t1/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 64, stream: false, messages: [{ role: 'user', content: 'x' }] }),
    });
    const j = await res.json();
    await close(proxy.server);
    await close(upstream);
    return j;
  }

  it('surfaces the reasoning field as a thinking block', async () => {
    const j = await aggregate({ choices: [{ message: { content: 'OK', reasoning: 'because reasons' } }], usage: {} });
    const thinking = (j.content || []).find(c => c.type === 'thinking');
    expect(thinking && thinking.thinking).toContain('because reasons');
    expect((j.content || []).find(c => c.type === 'text').text).toBe('OK');
  });

  it('omits the thinking block when reasoning is empty', async () => {
    const j = await aggregate({ choices: [{ message: { content: 'OK', reasoning: '' } }], usage: {} });
    expect((j.content || []).some(c => c.type === 'thinking')).toBe(false);
  });

  it('recovers a bare-JSON tool call from the content channel', async () => {
    const j = await aggregate({
      choices: [{ message: { content: '{"name":"Read","arguments":{"file_path":"/x"}}', finish_reason: 'stop' } }],
      usage: {},
    });
    const tool = (j.content || []).find(c => c.type === 'tool_use');
    expect(tool && tool.name).toBe('Read');
    expect(tool.input).toEqual({ file_path: '/x' });
    expect(j.stop_reason).toBe('tool_use');
  });

  it('recovers a tool call hidden in the reasoning channel', async () => {
    const j = await aggregate({
      choices: [{ message: { content: 'looking it up', reasoning: 'need the file <tool_call>{"name":"Read","arguments":{"file_path":"/y"}}</tool_call>' } }],
      usage: {},
    });
    const tool = (j.content || []).find(c => c.type === 'tool_use');
    expect(tool && tool.name).toBe('Read');
    expect(j.stop_reason).toBe('tool_use');
  });
});

describe('pathological input guards (#16, #17)', () => {
  it('bails out of brace-heavy prose instead of scanning quadratic', async () => {
    const { findBareToolStart } = require('../src/main/proxy.js');
    // 3000 braces: without the attempt cap this walks ~3000 balanced scans.
    const prose = ('log {key: 1} '.repeat(1500)).slice(0, 20000);
    const t0 = Date.now();
    const at = findBareToolStart(prose);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(at).toBe(-1);
  });

  it('exposes findBareToolStart for the guard test', async () => {
    const m = require('../src/main/proxy.js');
    expect(typeof m.findBareToolStart).toBe('function');
  });

  it('drops a call whose arguments are not JSON instead of inventing _raw', async () => {
    const { parseToolJson } = require('../src/main/proxy.js');
    expect(parseToolJson('{"name":"Bash","arguments":"just run it"}')).toBeNull();
    // Real JSON strings still parse.
    expect(parseToolJson('{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}'))
      .toEqual({ name: 'Bash', args: { command: 'ls' } });
    // Non-object args are rejected too.
    expect(parseToolJson('{"name":"Bash","arguments":42}')).toBeNull();
  });
});

describe('word-per-line regression: one text block for many chunks', () => {
  let h;
  afterAll(() => h && h.close());
  const body = { model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] };
  const textOf = (sse) => sse.filter(f => f.event === 'content_block_delta' && f.data.delta.type === 'text_delta').map(f => f.data.delta.text).join('');

  it('streams 50 one-word chunks into a single text block', async () => {
    const words = Array.from({ length: 50 }, (_, i) => 'w' + i + ' ');
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of words) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: w } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
    const sse = parseSse(await (await h.call('/v1/messages', body)).text());
    expect(sse.filter(f => f.event === 'content_block_start')).toHaveLength(1);
    expect(textOf(sse)).toBe(words.join(''));
  });

  it('keeps text held back near an unclosed brace and flushes it at the end', async () => {
    await h.close();
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'config is {"a":' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'hmm' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' 1' } }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    });
    const sse = parseSse(await (await h.call('/v1/messages', body)).text());
    expect(textOf(sse)).toBe('config is {"a": 1');
  });

  it('processes a final data line that has no trailing newline', async () => {
    await h.close();
    h = await withProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'one ' } }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'two' }, finish_reason: 'length' }] }));
    });
    const text = await (await h.call('/v1/messages', body)).text();
    const sse = parseSse(text);
    expect(textOf(sse)).toBe('one two');
    expect(text).toContain('"stop_reason":"max_tokens"');
  });
});

describe('anthropic pass-through repairs missing usage', () => {
  const TOKEN2 = 'tok-passthrough-0123456789';
  async function setup(upstreamHandler, extra = {}) {
    const upstream = http.createServer(upstreamHandler);
    await listen(upstream);
    const upPort = upstream.address().port;
    const proxy = await startProxy(
      () => ({ baseUrl: 'http://127.0.0.1:' + upPort, apiKey: 'sk-real', protocol: 'anthropic', keyHeader: 'x-api-key', headers: {}, ...extra }),
      { token: TOKEN2, port: 0 },
    );
    const call = (body, headers = {}) => fetch('http://127.0.0.1:' + proxy.port + '/px/t1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN2, ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    return { call, async close() { await close(proxy.server); await close(upstream); } };
  }
  const body = { model: 'deepseek-v4-flash', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };

  it('adds usage to a non-streamed reply that has none', async () => {
    const h = await setup((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })); });
    const j = await (await h.call(body)).json();
    expect(typeof j.usage.input_tokens).toBe('number');
    expect(typeof j.usage.output_tokens).toBe('number');
    expect(j.content[0].text).toBe('hi');
    await h.close();
  });

  it('keeps real usage numbers untouched', async () => {
    const h = await setup((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 7, output_tokens: 3 } })); });
    const j = await (await h.call(body)).json();
    expect(j.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
    await h.close();
  });

  it('repairs streamed message_start and message_delta without usage', async () => {
    const h = await setup((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"yo"}}\n\n');
      res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const text = await (await h.call({ ...body, stream: true })).text();
    const frames = parseSse(text);
    expect(typeof frames.find(f => f.event === 'message_start').data.message.usage.input_tokens).toBe('number');
    expect(typeof frames.find(f => f.event === 'message_delta').data.usage.output_tokens).toBe('number');
    expect(text).toContain('"text":"yo"');
    await h.close();
  });

  it('forwards the engine headers (client identity) and swaps in the provider key', async () => {
    let seen;
    const h = await setup((q, res) => { seen = q.headers; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"type":"message","content":[]}'); });
    await h.call(body, { 'user-agent': 'claude-cli/2.1.289 (external, cli)', 'x-app': 'cli', 'anthropic-beta': 'x-test' });
    expect(seen['user-agent']).toContain('claude-cli');
    expect(seen['x-app']).toBe('cli');
    expect(seen['anthropic-beta']).toBe('x-test');
    expect(seen['x-api-key']).toBe('sk-real');
    expect(seen.authorization).toBeUndefined();   // the proxy token never leaves the machine
    await h.close();
  });

  it('passes an upstream error through with its status', async () => {
    const h = await setup((_q, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"nope"}}'); });
    const r = await h.call(body);
    expect(r.status).toBe(401);
    expect(await r.text()).toContain('nope');
    await h.close();
  });
});
