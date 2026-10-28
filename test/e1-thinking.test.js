// E1: a turn that reasoned must show its reasoning. It showed only a
// "Thought for Xs" pill over an empty block: the finished message replaced the
// streamed thought with an empty one, the proxy missed some providers'
// reasoning fields, and the engine asked Claude to omit its thinking.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const { loadRenderer, flush } = require('./helpers/renderer.js');
const { startProxy } = require('../src/main/proxy.js');
const ChatManager = require('../src/main/chats.js');

async function openChat() {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false, autoOpenWelcomeChat: true }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
    },
  });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  const ev = (event) => send({ type: 'stream_event', event });
  return { h, chat, send, ev };
}

const thoughts = (chat) => [...chat.msgs.querySelectorAll('details.thinking-block')];

describe('E1 renderer: streamed thinking', () => {
  it('a thinking_delta renders into .think-body', async () => {
    const { chat, ev } = await openChat();
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the lock ' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'file first.' } });
    const [t] = thoughts(chat);
    expect(t.querySelector('.think-body').textContent).toBe('Check the lock file first.');
  });

  it('stays open after the thought ends, until the first answer token', async () => {
    const { chat, ev } = await openChat();
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check the lock file first.' } });
    ev({ type: 'content_block_stop', index: 0 });
    const [t] = thoughts(chat);
    expect(t.open).toBe(true);
    expect(t.querySelector('.think-pill').textContent).toContain('Check the lock file first.');
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    expect(t.open).toBe(false);
  });

  it('keeps the streamed text when the finished message carries an empty thought', async () => {
    const { chat, ev, send } = await openChat();
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weigh both options.' } });
    ev({ type: 'content_block_stop', index: 0 });
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Use the second.' }] } });
    await flush();
    const ts = thoughts(chat);
    expect(ts).toHaveLength(1);
    expect(ts[0].querySelector('.think-body').textContent).toBe('Weigh both options.');
  });

  it('says so when the provider shared no reasoning at all', async () => {
    const { chat, send } = await openChat();
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Done.' }] } });
    await flush();
    const [t] = thoughts(chat);
    expect(t).toBeTruthy();
    expect(t.querySelector('.think-pill').textContent).toMatch(/not shared/i);
  });
});

/* ---------------- proxy ---------------- */

const open = [];
let rigs = 0;
afterEach(async () => { for (const s of open.splice(0)) await new Promise(r => s.close(r)); });

async function rig(handler) {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => handler(req, res)); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const proxy = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKey: 'k' }), { port: 0 });
  open.push(proxy.server, upstream);
  return (body) => fetch('http://127.0.0.1:' + proxy.port + '/px/e1p' + (++rigs) + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'go' }], ...body }),
    signal: AbortSignal.timeout(10000),
  });
}

const stream = (...deltas) => (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const d of deltas) res.write('data: ' + JSON.stringify({ choices: [{ delta: d.finish ? {} : d, finish_reason: d.finish || null }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
};

function thinkingOf(sse) {
  let out = '';
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const j = JSON.parse(line.slice(6));
    if (j.type === 'content_block_delta' && j.delta.type === 'thinking_delta') out += j.delta.thinking;
  }
  return out;
}

describe('E1 proxy: every known reasoning field is captured', () => {
  for (const field of ['reasoning', 'reasoning_content', 'reasoning_text', 'thinking']) {
    it('streamed: ' + field, async () => {
      const call = await rig(stream({ [field]: 'plan ' }, { [field]: 'it' }, { content: 'ok' }, { finish: 'stop' }));
      expect(thinkingOf(await (await call()).text())).toBe('plan it');
    });

    it('aggregate: ' + field, async () => {
      const call = await rig((_q, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok', [field]: 'plan it' }, finish_reason: 'stop' }] }));
      });
      const j = await (await call({ stream: false })).json();
      expect(j.content[0]).toEqual({ type: 'thinking', thinking: 'plan it' });
    });
  }

  it('streamed: OpenRouter reasoning_details', async () => {
    const call = await rig(stream({ reasoning_details: [{ type: 'reasoning.text', text: 'plan it' }] }, { content: 'ok' }, { finish: 'stop' }));
    expect(thinkingOf(await (await call()).text())).toBe('plan it');
  });
});

/* ---------------- engine options ---------------- */

describe('E1 engine: Claude is asked to show its thinking', () => {
  let opts = null;
  const sdk = { query: ({ options }) => { opts = options; return Object.assign((async function* () {})(), { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn() }); } };
  const create = (settings) => new ChatManager({ proxyToken: 't', sdk }).create({ cwd: '/tmp', providerInstance: null, settings, model: 'claude-sonnet-4-5' });

  it('a thinking budget asks for summarized thinking', async () => {
    await create({ thinkingBudget: 4096 });
    expect(opts.thinking).toEqual({ type: 'enabled', budgetTokens: 4096, display: 'summarized' });
  });

  it('without a budget the engine is still asked for summaries', async () => {
    await create({});
    expect(opts.settings.showThinkingSummaries).toBe(true);
  });

  it('"Show thinking" off asks for neither', async () => {
    await create({ thinkingBudget: 4096, showThinking: false });
    expect(opts.thinking.display).toBeUndefined();
    expect(opts.settings.showThinkingSummaries).toBe(false);
  });
});
