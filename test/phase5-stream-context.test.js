// Phase 5 (0.9.72): streaming, context and cost.
//
// A slow model gets pings so the engine does not call it dead; the idle wait
// is a setting; prompt sizes are estimated by content type and corrected by
// real counts; Read, Grep and Glob results are compacted like shell output;
// and only a failure before the connection is retried.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
process.env.CCE_KEEPALIVE_MS = '40';
const { startProxy, inTokens } = require('../src/main/proxy.js');
const tokencount = require('../src/main/tokencount.js');
const { compactToolOutput, toolResultText, budgetFor, clampIdleSeconds, FILTERED_TOOLS } = require('../src/main/toolfilter.js');
const modelcontext = require('../src/main/modelcontext.js');
const { isPreConnectError, fetchUpstream } = require('../src/main/adapters.js');

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
const data = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

describe('keep-alive pings (#9)', () => {
  it('pings while the model is silent, and the reply still completes', async () => {
    const r = await viaProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();   // the connection is made; the model is still thinking
      setTimeout(() => {
        data(res, { choices: [{ delta: { content: 'done' } }] });
        data(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
        res.end('data: [DONE]\n\n');
      }, 300);
    }, { model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toContain('event: ping');
    expect((r.text.match(/event: ping/g) || []).length).toBeGreaterThan(2);
    expect(r.text).toContain('"text":"done"');
    expect(r.text).toContain('event: message_stop');
  });
  it('stops pinging once the stream has ended', async () => {
    const r = await viaProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      data(res, { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    }, { model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'x' }] });
    expect(r.text.trimEnd().endsWith('event: message_stop\ndata: {"type":"message_stop"}')).toBe(true);
  });
});

describe('idle timeout setting (#9)', () => {
  it('is clamped to 30…1800 seconds, default 180', () => {
    expect(clampIdleSeconds(undefined)).toBe(180);
    expect(clampIdleSeconds('abc')).toBe(180);
    expect(clampIdleSeconds(0)).toBe(180);
    expect(clampIdleSeconds(5)).toBe(30);
    expect(clampIdleSeconds(99999)).toBe(1800);
    expect(clampIdleSeconds(240)).toBe(240);
  });
});

describe('token estimates (#13)', () => {
  beforeEach(() => tokencount.resetCalibration());

  it('counts CJK near a token a character and prose near a quarter', () => {
    expect(tokencount.estimateText('你好世界你好世界')).toBeGreaterThanOrEqual(8);
    const prose = 'the quick brown fox jumps over the lazy dog '.repeat(10);
    expect(tokencount.estimateText(prose)).toBeLessThan(prose.length / 3.5);
  });
  it('counts code and JSON as denser than prose', () => {
    const code = 'if(a[i]!==b){x=(y||{}).z;}'.repeat(20);
    expect(tokencount.estimateText(code)).toBeGreaterThan(code.length / 4);
  });
  it('does not count a base64 image by its string length', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_000_000) } }, { type: 'text', text: 'what is this' }] }] };
    expect(tokencount.estimateBody(body)).toBeLessThan(3000);
  });
  it('walks tool calls and results, not just text', () => {
    const body = { messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x/y.js' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'x'.repeat(4000) }] }] },
    ] };
    expect(tokencount.estimateBody(body)).toBeGreaterThan(900);
  });
  it('learns from a real count and applies it to the next estimate of that model', () => {
    const body = { model: 'learn-m', messages: [{ role: 'user', content: 'word '.repeat(2000) }] };
    const raw = tokencount.estimateBody(body);
    expect(inTokens(body)).toBe(raw);
    tokencount.noteActual('learn-m', raw, raw * 2);
    expect(inTokens(body)).toBeGreaterThan(raw * 1.5);
    expect(inTokens({ ...body, model: 'other-m' })).toBe(raw);
  });
  it('ignores a count it cannot trust and keeps the correction bounded', () => {
    tokencount.noteActual('m', 10, 9999);
    expect(tokencount.factorFor('m')).toBe(1);
    tokencount.noteActual('m', 1000, 100000);
    expect(tokencount.factorFor('m')).toBeLessThanOrEqual(2);
  });
  it('reports the reply size from what was streamed when the provider gives none', async () => {
    const text = 'a considered answer that runs on for a while, '.repeat(12);
    const r = await viaProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      data(res, { choices: [{ delta: { content: text }, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    }, { model: 'm', max_tokens: 400, stream: true, messages: [{ role: 'user', content: 'x' }] });
    const m = /"output_tokens":(\d+)/.exec(r.text.slice(r.text.indexOf('message_delta')));
    expect(Number(m[1])).toBeGreaterThan(80);
  });
  it('prefers the provider\'s own counts', async () => {
    const r = await viaProxy((_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      data(res, { choices: [{ delta: { content: 'hello there' }, finish_reason: 'stop' }] });
      data(res, { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 7 } });
      res.end('data: [DONE]\n\n');
    }, { model: 'm', max_tokens: 40, stream: true, messages: [{ role: 'user', content: 'x' }] });
    const tail = r.text.slice(r.text.indexOf('event: message_delta'));
    expect(tail).toContain('"input_tokens":1234');
    expect(tail).toContain('"output_tokens":7');
  });
});

describe('Read, Grep and Glob output (#16)', () => {
  it('filters all four tools', () => {
    expect(FILTERED_TOOLS).toEqual(['Bash', 'Grep', 'Glob', 'Read']);
  });
  it('reads the text out of each tool\'s result shape', () => {
    expect(toolResultText({ file: { filePath: '/a', content: 'line1\nline2' } })).toBe('line1\nline2');
    expect(toolResultText({ mode: 'content', content: 'a.js:1:x', numLines: 1 })).toBe('a.js:1:x');
    expect(toolResultText({ filenames: ['a.js', 'b.js'], numFiles: 2 })).toBe('a.js\nb.js');
  });
  it('compacts a long Glob and says how much was left out', () => {
    const files = Array.from({ length: 3000 }, (_, i) => '/repo/src/deep/path/file' + i + '.js');
    const r = compactToolOutput({ output: { filenames: files }, toolName: 'Glob', detail: '**/*.js', maxChars: 4000 });
    expect(r.compacted).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.text).toContain('compacted Glob output');
    expect(r.text).toContain('characters elided');
  });
  it('gives Read a larger budget than a search, and never collapses a file\'s repeated lines', () => {
    expect(budgetFor('Read', 8000)).toBeGreaterThan(budgetFor('Grep', 8000));
    const file = ('}\n}\n}\n}\n' + 'const a = 1;\n').repeat(4000);
    const r = compactToolOutput({ output: { file: { content: file } }, toolName: 'Read', detail: '/repo/a.js', maxChars: 8000 });
    expect(r.compacted).toBe(true);
    expect(r.text).not.toContain('identical lines');
    expect(r.text).toContain('offset and limit');
  });
  it('leaves a small result alone', () => {
    const r = compactToolOutput({ output: { content: 'a.js:1:x' }, toolName: 'Grep', maxChars: 8000 });
    expect(r.compacted).toBe(false);
  });
});

describe('only a failure before the connection is retried (#17)', () => {
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
  it('recognises connect-time failures, including through a cause chain', () => {
    expect(isPreConnectError(refused())).toBe(true);
    expect(isPreConnectError(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))).toBe(true);
    expect(isPreConnectError(Object.assign(new Error('agg'), { errors: [{ code: 'ECONNREFUSED' }, { code: 'ENETUNREACH' }] }))).toBe(true);
  });
  it('does not treat a post-send failure as retryable', () => {
    expect(isPreConnectError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(false);
    expect(isPreConnectError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isPreConnectError(Object.assign(new Error('headers'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(false);
    expect(isPreConnectError(new Error('boom'))).toBe(false);
  });
  it('does not retry a 504, which means the model was already working', async () => {
    let n = 0;
    const srv = http.createServer((_q, res) => { n++; res.writeHead(504); res.end('slow'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const res = await fetchUpstream('http://127.0.0.1:' + srv.address().port + '/x', {});
    expect(res.status).toBe(504);
    expect(n).toBe(1);
    await new Promise((r) => srv.close(r));
  });
});

describe('model probe and names (#12)', () => {
  beforeEach(() => { modelcontext.contextCache.clear(); modelcontext.clearProbeFailures(); });
  const withFetch = async (impl, fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = real; }
  };

  it('sends the key the way each family expects', () => {
    const h = modelcontext.probeHeaders;
    expect(h({ apiKey: 'k' }, 'https://api.openai.com/v1').Authorization).toBe('Bearer k');
    const a = h({ apiKey: 'k' }, 'https://api.anthropic.com');
    expect(a['x-api-key']).toBe('k');
    expect(a['anthropic-version']).toBe('2023-06-01');
    expect(h({ apiKey: 'k' }, 'https://generativelanguage.googleapis.com/v1beta')['x-goog-api-key']).toBe('k');
    expect(h({ apiKey: 'k', keyHeader: 'bearer', protocol: 'anthropic' }, 'https://gw.example/v1').Authorization).toBe('Bearer k');
  });
  it('gives the request a timeout', async () => {
    let signal = null;
    await withFetch(async (_u, o) => { signal = o && o.signal; return { ok: false, status: 500 }; },
      () => modelcontext.probeContextWindow({ baseUrl: 'https://p.example/v1', id: 'p1' }, 'm1'));
    expect(signal).toBeTruthy();
  });
  it('does not remember a failure for good', async () => {
    let calls = 0;
    const provider = { baseUrl: 'https://p.example/v1', id: 'p2' };
    const impl = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 401 };
      return { ok: true, json: async () => ({ data: [{ id: 'm2', context_length: 64000 }] }) };
    };
    await withFetch(impl, async () => {
      expect(await modelcontext.probeContextWindow(provider, 'm2')).toBe(0);
      expect(await modelcontext.probeContextWindow(provider, 'm2')).toBe(0);   // inside the wait: no new request
      expect(calls).toBe(1);
      modelcontext.clearProbeFailures();                                       // the wait is over
      expect(await modelcontext.probeContextWindow(provider, 'm2')).toBe(64000);
      expect(await modelcontext.probeContextWindow(provider, 'm2')).toBe(64000);
      expect(calls).toBe(2);                                                   // a success is kept
    });
  });
  it('knows the current model families', () => {
    const ctx = (id) => modelcontext.modelContext({}, id);
    expect(ctx('gpt-4.1-mini')).toBe(1_047_576);
    expect(ctx('gpt-5')).toBe(400_000);
    expect(ctx('gemini-3-pro-preview')).toBe(1_000_000);
    expect(ctx('claude-sonnet-4-5')).toBe(200_000);
    expect(ctx('qwen3-coder-480b')).toBe(262_144);
    expect(ctx('kimi-k2-instruct')).toBe(131_072);
    expect(ctx('gpt-4o')).toBe(128_000);
  });
  it('does not read "o1" out of the middle of an unrelated name', () => {
    expect(modelcontext.modelContext({}, 'foo-bar-o1x')).toBe(0);
    expect(modelcontext.modelContext({}, 'o3-mini')).toBe(200_000);
    expect(modelcontext.modelContext({}, 'openai/o4-mini')).toBe(200_000);
  });
});
