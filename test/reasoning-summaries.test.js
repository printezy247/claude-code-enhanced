// Reasoning summaries from every provider protocol: the OpenAI Responses API
// (reasoning summary items), Gemini (thought parts) and engines that hand the
// summary back in a `summary` field on the thinking block. Earlier the chat
// said "reasoning not shared by the provider" while the summary sat right
// there in the payload, and Gemini thought text leaked into the answer.
// #feat-reasoning-summaries
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const { loadRenderer, flush } = require('./helpers/renderer.js');
const { startProxy } = require('../src/main/proxy.js');

/* ---------------- proxy rig ---------------- */

const open = [];
let rigs = 0;
afterEach(async () => { for (const s of open.splice(0)) await new Promise(r => s.close(r)); });

async function rig(handler, protocol = 'openai') {
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
      handler(req, res, body);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const proxy = await startProxy(() => ({
    baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKey: 'k', protocol,
  }), { port: 0 });
  open.push(proxy.server, upstream);
  return (body) => fetch('http://127.0.0.1:' + proxy.port + '/px/rs' + (++rigs) + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }], ...body }),
    signal: AbortSignal.timeout(10000),
  });
}

/** Translate the Anthropic SSE the proxy answers with into [{type, text}]. */
function blocksOf(sse) {
  const out = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const j = JSON.parse(line.slice(6));
    if (j.type === 'content_block_start') out.push({ type: j.content_block.type, text: '' });
    else if (j.type === 'content_block_delta') {
      const b = out[j.index];
      if (!b) continue;
      if (j.delta.type === 'thinking_delta') b.text += j.delta.thinking;
      else if (j.delta.type === 'text_delta') b.text += j.delta.text;
    }
  }
  return out;
}

const events = (list) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of list) res.write('data: ' + JSON.stringify(ev) + '\n\n');
  res.end();
};

const json = (payload) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

/* ---------------- OpenAI Responses API ---------------- */

describe('Responses API reasoning summaries', () => {
  it('streamed: the summary becomes one thought, not two', async () => {
    const call = await rig(events([
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'plan ' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'it' },
      // The finished item repeats the whole summary: it must not double.
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan it' }] } },
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ]), 'openai-responses');
    const blocks = blocksOf(await (await call()).text());
    expect(blocks.map(b => [b.type, b.text])).toEqual([['thinking', 'plan it'], ['text', 'ok']]);
  });

  it('streamed: a summary that only arrives on the finished item is still shown', async () => {
    const call = await rig(events([
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'weigh both' }] } },
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { usage: {} } },
    ]), 'openai-responses');
    const blocks = blocksOf(await (await call()).text());
    expect(blocks.map(b => [b.type, b.text])).toEqual([['thinking', 'weigh both'], ['text', 'ok']]);
  });

  it('not streamed: the reasoning item becomes a thought', async () => {
    const call = await rig(json({
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan it' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    }), 'openai-responses');
    const j = await (await call({ stream: false })).json();
    expect(j.content[0]).toEqual({ type: 'thinking', thinking: 'plan it' });
    expect(j.content[1]).toEqual({ type: 'text', text: 'ok' });
  });
});

/* ---------------- Gemini ---------------- */

describe('Gemini thought summaries', () => {
  it('streamed: a thought part is thinking, not the answer, and thoughts are requested', async () => {
    const seen = {};
    const call = await rig((req, res, body) => {
      seen.url = req.url;
      seen.body = body;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'let me think', thought: true }, { text: 'ok' }] }, finishReason: 'STOP' }],
      }) + '\n\n');
      res.end();
    }, 'gemini');
    const blocks = blocksOf(await (await call({ thinking: { budget_tokens: 1024 } })).text());
    expect(blocks.map(b => [b.type, b.text])).toEqual([['thinking', 'let me think'], ['text', 'ok']]);
    expect(seen.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true });
  });

  it('not streamed: thought parts become reasoning, the rest is the answer', async () => {
    const call = await rig(json({
      candidates: [{ content: { parts: [{ text: 'plan it', thought: true }, { text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    }), 'gemini');
    const j = await (await call({ stream: false })).json();
    expect(j.content[0]).toEqual({ type: 'thinking', thinking: 'plan it' });
    expect(j.content[1]).toEqual({ type: 'text', text: 'ok' });
  });
});

/* ---------------- renderer ---------------- */

const IPC = {
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
};

async function bootRenderer(settings) {
  const h = loadRenderer({
    ipc: {
      ...IPC,
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false, autoOpenWelcomeChat: true, ...settings }, claude: { found: true, path: '', version: '' } },
    },
  });
  await flush();
  return h;
}

const thoughts = (chat) => [...chat.msgs.querySelectorAll('details.thinking-block')];

describe('a thinking block that carries its summary in a summary field', () => {
  it('shows the summary instead of "reasoning not shared"', async () => {
    const h = await bootRenderer({});
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'thinking', summary: [{ type: 'summary_text', text: 'plan it' }] }, { type: 'text', text: 'Done.' }] } } });
    await flush();
    const [t] = thoughts(chat);
    expect(t).toBeTruthy();
    expect(t.querySelector('.think-pill').textContent).toContain('plan it');
  });
});

describe('Settings > "Show thinking" hides reasoning summaries', () => {
  it('adds the hide class when the box is off', async () => {
    const h = await bootRenderer({ showThinking: false });
    expect(h.window.document.body.classList.contains('hide-reasoning')).toBe(true);
  });

  it('shows them again when the box is on', async () => {
    const h = await bootRenderer({});
    expect(h.window.document.body.classList.contains('hide-reasoning')).toBe(false);
  });
});
