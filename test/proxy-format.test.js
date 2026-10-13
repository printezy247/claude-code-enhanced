// Translator proxy: what a reply looks like to the engine, and how a failed
// request is reported. Every case here was seen in real chats against an
// OpenAI-format provider: reasoning printed into the answer, a missing model
// retried ten times, an error swallowed into an empty reply.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const { startProxy, mapError } = require('../src/main/proxy.js');
const adapters = require('../src/main/adapters.js');

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', r));
const close = (server) => new Promise(r => server.close(r));

let open = [];
let rigs = 0;   // each rig is its own provider: the proxy remembers the last model per provider
afterEach(async () => { for (const s of open.splice(0)) await close(s); });

/** A proxy in front of a fake provider. `handler(req, res, body, n)`. */
async function rig(handler, prov = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push(body);
      handler(req, res, body, seen.length);
    });
  });
  await listen(upstream);
  const proxy = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKey: 'k', ...prov }), { port: 0 });
  open.push(proxy.server, upstream);
  const uid = 'p' + (++rigs);
  const call = (body) => fetch('http://127.0.0.1:' + proxy.port + '/px/' + uid + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }], ...body }),
    signal: AbortSignal.timeout(10000),
  });
  return { call, seen };
}

/** Reply with OpenAI stream chunks. */
const stream = (...deltas) => (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const d of deltas) res.write('data: ' + JSON.stringify(d.raw || { choices: [{ delta: d.finish ? {} : d, finish_reason: d.finish || null }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
};

/** Fold Anthropic SSE into [{type, text|thinking|name}] plus stop reason and errors. */
function read(text) {
  const blocks = [];
  let stop = null;
  const errors = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const j = JSON.parse(line.slice(6));
    if (j.type === 'content_block_start') blocks[j.index] = { type: j.content_block.type, name: j.content_block.name, body: '' };
    else if (j.type === 'content_block_delta') blocks[j.index].body += j.delta.text || j.delta.thinking || j.delta.partial_json || '';
    else if (j.type === 'message_delta') stop = j.delta.stop_reason;
    else if (j.type === 'error') errors.push(j.error);
  }
  return { blocks, stop, errors, done: text.includes('event: message_stop') };
}

describe('reasoning is shown as thinking, not as the answer', () => {
  it('streams the reasoning field into a thinking block ahead of the text', async () => {
    const h = await rig(stream({ reasoning_content: 'First I ' }, { reasoning_content: 'check the file.' }, { content: 'Done.' }, { finish: 'stop' }));
    const out = read(await (await h.call()).text());
    expect(out.blocks.map(b => b.type)).toEqual(['thinking', 'text']);
    expect(out.blocks[0].body).toBe('First I check the file.');
    expect(out.blocks[1].body).toBe('Done.');
  });

  it('moves an opening <think>…</think> out of the text, even split across chunks', async () => {
    const h = await rig(stream({ content: '<thi' }, { content: 'nk>plan the ' }, { content: 'edit</th' }, { content: 'ink>\n\nHere is the fix.' }, { finish: 'stop' }));
    const out = read(await (await h.call()).text());
    expect(out.blocks.map(b => b.type)).toEqual(['thinking', 'text']);
    expect(out.blocks[0].body).toBe('plan the edit');
    expect(out.blocks[1].body).toBe('Here is the fix.');
  });

  it('leaves a <think> tag that is only mentioned in the answer alone', async () => {
    const h = await rig(stream({ content: 'Models wrap reasoning in <think> tags.' }, { finish: 'stop' }));
    const out = read(await (await h.call()).text());
    expect(out.blocks).toEqual([{ type: 'text', name: undefined, body: 'Models wrap reasoning in <think> tags.' }]);
  });

  it('keeps short replies that merely start with "<"', async () => {
    const h = await rig(stream({ content: '<' }, { content: 'b>ok</b>' }, { finish: 'stop' }));
    const out = read(await (await h.call()).text());
    expect(out.blocks.map(b => b.body).join('')).toBe('<b>ok</b>');
  });

  it('answers with the reasoning when the model thought and then said nothing', async () => {
    const h = await rig(stream({ reasoning_content: 'Summary: the lock fix is committed.' }, { finish: 'stop' }));
    const out = read(await (await h.call()).text());
    expect(out.blocks.map(b => b.type)).toEqual(['thinking', 'text']);
    expect(out.blocks[1].body).toBe('Summary: the lock fix is committed.');
  });

  it('does not repeat the reasoning when a tool call follows it', async () => {
    const h = await rig(stream(
      { reasoning_content: 'need the file' },
      { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] },
      { finish: 'tool_calls' },
    ));
    const out = read(await (await h.call()).text());
    expect(out.blocks.map(b => b.type)).toEqual(['thinking', 'tool_use']);
    expect(out.stop).toBe('tool_use');
  });

  it('non-streamed: splits a leaked closing tag and never returns an empty answer', async () => {
    const reply = (message) => (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] })); };
    let h = await rig(reply({ content: 'weigh both options</think>Use the second one.' }));
    let j = await (await h.call({ stream: false })).json();
    expect(j.content).toEqual([{ type: 'thinking', thinking: 'weigh both options' }, { type: 'text', text: 'Use the second one.' }]);
    h = await rig(reply({ content: '', reasoning_content: 'The summary is X.' }));
    j = await (await h.call({ stream: false })).json();
    expect(j.content.find(b => b.type === 'text').text).toBe('The summary is X.');
  });
});

describe('a failed request is reported as what it is', () => {
  it('reports an error sent inside a 200 stream instead of an empty reply', async () => {
    const h = await rig(stream({ raw: { error: { message: 'This model\'s maximum context length is 131072 tokens', code: 400 } } }));
    const out = read(await (await h.call()).text());
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].type).toBe('invalid_request_error');
    expect(out.errors[0].message).toMatch(/^prompt is too long: /);
    expect(out.done).toBe(false);
  });

  it('reports an error sent as a 200 JSON body to a streaming request', async () => {
    const h = await rig((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'quota exceeded', code: 429 } })); });
    const res = await h.call();
    expect(res.status).toBe(429);
    expect((await res.json()).error.type).toBe('rate_limit_error');
  });

  it('replays a whole JSON reply as a stream when the provider ignores stream:true', async () => {
    const h = await rig((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'all at once' }, finish_reason: 'stop' }] })); });
    const out = read(await (await h.call()).text());
    expect(out.blocks[0].body).toBe('all at once');
    expect(out.done).toBe(true);
  });

  it('passes a 4xx on as a 4xx so the engine does not retry it', async () => {
    const h = await rig((_q, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'tool_choice is not supported' } })); });
    const res = await h.call();
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe('invalid_request_error');
  });

  it('maps upstream failures onto the statuses the engine acts on', () => {
    expect(mapError(400, 'The requested model does not exist.')).toMatchObject({ status: 404, type: 'not_found_error' });
    expect(mapError(413, 'Request too large: input too long for this model')).toMatchObject({ status: 400, type: 'invalid_request_error' });
    expect(mapError(429, 'You exceeded your tokens per minute; context window untouched').type).toBe('rate_limit_error');
    expect(mapError(403, 'no credit').type).toBe('permission_error');
    expect(mapError(500, 'boom')).toMatchObject({ status: 502, type: 'api_error' });
    expect(mapError(502, '').message).toBe('HTTP 502');
  });
});

describe('a model the provider does not have', () => {
  const missingThenOk = (_q, res, body) => {
    if (/^claude/.test(body.model)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'The requested model does not exist.' } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'title' }, finish_reason: 'stop' }] }));
  };

  it('is retried once with the provider\'s own model', async () => {
    const h = await rig(missingThenOk, { model: 'laguna-s-2.1' });
    const res = await h.call({ model: 'claude-haiku-4-5', stream: false });
    expect(res.status).toBe(200);
    expect((await res.json()).content[0].text).toBe('title');
    expect(h.seen.map(b => b.model)).toEqual(['claude-haiku-4-5', 'laguna-s-2.1']);
  });

  it('prefers the small/fast model, then the model the chat last used', async () => {
    let h = await rig(missingThenOk, { model: 'big', smallFastModel: 'small' });
    await h.call({ model: 'claude-haiku-4-5', stream: false });
    expect(h.seen[1].model).toBe('small');
    h = await rig(missingThenOk, {});
    await h.call({ model: 'picked-in-chat', stream: false });
    await h.call({ model: 'claude-haiku-4-5', stream: false });
    expect(h.seen.map(b => b.model)).toEqual(['picked-in-chat', 'claude-haiku-4-5', 'picked-in-chat']);
  });

  it('fails once, as not-found, when there is nothing to fall back to', async () => {
    const h = await rig(missingThenOk, { model: 'claude-x' });
    const res = await h.call({ model: 'claude-x', stream: false });
    expect(res.status).toBe(404);
    expect((await res.json()).error.type).toBe('not_found_error');
    expect(h.seen).toHaveLength(1);
  });
});

describe('request sent to an OpenAI-format provider', () => {
  const build = (messages, extra = {}) => adapters.buildOpenAIBody({ model: 'm', max_tokens: 16, messages, ...extra }, true);

  it('puts tool results directly after the call, before any other text', () => {
    const out = build([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'text', text: 'reminder' }, { type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] },
    ]);
    expect(out.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect(out.messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'a.txt' });
  });

  it('never sends an empty tool result or an empty assistant message', () => {
    const out = build([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'image', source: {} }] }] },
    ]);
    expect(out.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(out.messages[1].content).toBe('(no output)');
    expect(out.messages[3].content).toBe('[image]');
  });

  it('keeps system text at the start, where every provider accepts it', () => {
    const out = build([
      { role: 'user', content: 'hi' },
      { role: 'system', content: '# Environment\ncwd: /x' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [{ type: 'text', text: 'late note' }] },
    ], { system: 'You are helpful.' });
    expect(out.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out.messages[0].content).toBe('You are helpful.\n\n# Environment\ncwd: /x\n\nlate note');
    const bare = build([{ role: 'user', content: 'hi' }, { role: 'system', content: 'env' }]);
    expect(bare.messages.map(m => m.role)).toEqual(['system', 'user']);
  });

  it('does not replay leaked reasoning as something the model said', () => {
    const out = build([{ role: 'assistant', content: [{ type: 'text', text: 'weigh it up</think>Use B.' }] }]);
    expect(out.messages[0].content).toBe('Use B.');
  });

  it('asks for token usage and sends stop sequences on tool-less calls too', () => {
    const out = build([{ role: 'user', content: 'summarise' }], { stop_sequences: ['</summary>'] });
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.stop).toEqual(['</summary>']);
  });

  it('splitThink ignores tags inside code', () => {
    expect(adapters.splitThink('Strip `</think>` first.').thinking).toBe('');
    expect(adapters.splitThink('```\na</think>b\n```').text).toBe('```\na</think>b\n```');
    expect(adapters.splitThink('<think>still going')).toEqual({ thinking: 'still going', text: '' });
  });
});
