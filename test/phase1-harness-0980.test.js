// Phase 1 of the CCE review: tool calling on the translated path. Parallel
// calls from Qwen/GLM/Kimi interleave their chunks; vLLM's guided decoding
// rejects a schema whose $ref points at definitions that were stripped;
// Mistral only takes 9-character tool ids; and a big image must not ride
// along to a provider that will refuse the whole request.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const proxy = require('../src/main/proxy.js');
const { sanitizeSchema, buildOpenAIBody } = require('../src/main/adapters.js');

/** Feed tool_call deltas through pickToolSlot the way the stream loop does. */
function collect(deltas) {
  const buf = new Map();
  for (const tc of deltas) {
    const k = proxy.pickToolSlot(buf, tc);
    const cur = buf.get(k) || { id: tc.id || 'call_' + k, name: '', args: '' };
    if (tc.id) { cur.id = tc.id; cur.real = true; }
    if (tc.function && tc.function.name) cur.name = tc.function.name;
    if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
    buf.set(k, cur);
  }
  return [...buf.values()].map((c) => ({ id: c.id, name: c.name, args: JSON.parse(c.args) }));
}

describe('interleaved parallel tool calls', () => {
  it('Qwen (vLLM): index on every chunk, two calls interleaved', () => {
    const out = collect([
      { index: 0, id: 'chatcmpl-tool-a', function: { name: 'Read', arguments: '' } },
      { index: 1, id: 'chatcmpl-tool-b', function: { name: 'Glob', arguments: '' } },
      { index: 0, function: { arguments: '{"file_path":' } },
      { index: 1, function: { arguments: '{"pattern":' } },
      { index: 0, function: { arguments: '"/a"}' } },
      { index: 1, function: { arguments: '"*.js"}' } },
    ]);
    expect(out).toEqual([
      { id: 'chatcmpl-tool-a', name: 'Read', args: { file_path: '/a' } },
      { id: 'chatcmpl-tool-b', name: 'Glob', args: { pattern: '*.js' } },
    ]);
  });

  it('GLM: every call arrives whole, all at index 0, each with its own id', () => {
    const out = collect([
      { index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } },
      { index: 0, id: 'call_2', function: { name: 'Read', arguments: '{"file_path":"/b"}' } },
      { index: 0, id: 'call_3', function: { name: 'Grep', arguments: '{"pattern":"x"}' } },
    ]);
    expect(out.map((c) => c.id)).toEqual(['call_1', 'call_2', 'call_3']);
    expect(out[1].args).toEqual({ file_path: '/b' });
  });

  it('Kimi: ids repeated on continuation chunks, out of order', () => {
    const out = collect([
      { index: 0, id: 'functions.Read:0', function: { name: 'Read', arguments: '{"file_' } },
      { index: 1, id: 'functions.Bash:1', function: { name: 'Bash', arguments: '{"comm' } },
      { index: 1, id: 'functions.Bash:1', function: { arguments: 'and":"ls"}' } },
      { index: 0, id: 'functions.Read:0', function: { arguments: 'path":"/a"}' } },
    ]);
    expect(out).toEqual([
      { id: 'functions.Read:0', name: 'Read', args: { file_path: '/a' } },
      { id: 'functions.Bash:1', name: 'Bash', args: { command: 'ls' } },
    ]);
  });
});

describe('vLLM strict schemas', () => {
  const mcp = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      target: { $ref: '#/$defs/Target' },
      tags: { type: 'array', items: { $ref: '#/definitions/Tag' } },
      node: { $ref: '#/$defs/Node' },
      lost: { $ref: '#/$defs/Missing' },
    },
    required: ['target'],
    $defs: {
      Target: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } },
    },
    definitions: { Tag: { type: 'string', enum: ['a', 'b'] } },
  };

  it('inlines local $refs before the definitions are stripped', () => {
    const out = sanitizeSchema(mcp, 'openai');
    expect(JSON.stringify(out)).not.toContain('$ref');
    expect(JSON.stringify(out)).not.toContain('$defs');
    expect(out.properties.target).toEqual({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    expect(out.properties.tags.items).toEqual({ type: 'string', enum: ['a', 'b'] });
  });

  it('a recursive or dangling $ref becomes an open schema, not a dangling pointer', () => {
    const out = sanitizeSchema(mcp, 'openai');
    expect(out.properties.lost).toEqual({});
    let n = out.properties.node, depth = 0;
    while (n && n.properties && n.properties.child) { n = n.properties.child; depth++; }
    expect(depth).toBeLessThan(8);
  });

  it('leaves the input untouched', () => {
    const copy = JSON.parse(JSON.stringify(mcp));
    sanitizeSchema(mcp, 'openai');
    expect(mcp).toEqual(copy);
  });
});

describe('Mistral tool ids', () => {
  const mistral = { baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k', protocol: 'openai' };

  it('a 9-character id from Mistral survives the round trip unchanged', async () => {
    const up = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'aB3dE5fG7', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] }, finish_reason: 'tool_calls' }] }));
      });
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    const px = await proxy.startProxy(() => ({ ...mistral, baseUrl: 'http://127.0.0.1:' + up.address().port, presetId: 'mistral' }), { port: 0 });
    open.push(px.server, up);
    const j = await (await fetch('http://127.0.0.1:' + px.port + '/px/mi1/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-large', max_tokens: 64, messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'Read', input_schema: { type: 'object' } }] }),
    })).json();
    const call = j.content.find((b) => b.type === 'tool_use');
    expect(call.id).toBe('aB3dE5fG7');

    const next = buildOpenAIBody({
      model: 'mistral-large', max_tokens: 64,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [call] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] },
      ],
    }, false, mistral);
    expect(next.messages.find((m) => m.tool_calls).tool_calls[0].id).toBe('aB3dE5fG7');
    expect(next.messages.find((m) => m.role === 'tool').tool_call_id).toBe('aB3dE5fG7');
  });

  it('an engine id is shortened the same way on the call and on its result', () => {
    const out = buildOpenAIBody({
      model: 'mistral-large', max_tokens: 64,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01ABCDEFGHIJKLMNOP', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABCDEFGHIJKLMNOP', content: 'ok' }] },
      ],
    }, false, mistral);
    const id = out.messages.find((m) => m.tool_calls).tool_calls[0].id;
    expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(out.messages.find((m) => m.role === 'tool').tool_call_id).toBe(id);
  });
});

/* ---------------- big images ---------------- */

const open = [];
afterEach(async () => { for (const s of open.splice(0)) await new Promise((r) => s.close(r)); });

describe('images too big for the provider', () => {
  const prov = { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', protocol: 'openai' };
  const big = 'A'.repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3));   // ~6 MB decoded
  const small = 'iVBORw0KGgo=';

  it('a tool result image over 5 MB goes as a note, a small one as the image', () => {
    const out = buildOpenAIBody({
      model: 'gpt-4.1', max_tokens: 64,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] },
          { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: small } }] },
        ] },
      ],
    }, false, prov);
    const s = JSON.stringify(out);
    expect(s.length).toBeLessThan(100000);
    expect(s).toContain('image omitted');
    expect(s).toContain('data:image/png;base64,' + small);
  });

  it('the proxy refuses a request body over its cap with a 413, not a crash', async () => {
    const px = await proxy.startProxy(() => ({ ...prov, baseUrl: 'http://127.0.0.1:9' }), { port: 0, maxBodyBytes: 1024 });
    open.push(px.server);
    const r = await fetch('http://127.0.0.1:' + px.port + '/px/big1/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'x'.repeat(4096) }] }),
    });
    expect(r.status).toBe(413);
    expect((await r.json()).error.type).toBe('request_too_large');
  });
});
