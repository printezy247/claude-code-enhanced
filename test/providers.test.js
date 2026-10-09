// Provider catalog, auth store, models.dev and the direct HTTP adapters.
//
// Adapter coverage is end-to-end through the proxy (fake Gemini/Responses
// upstreams), because the value is that a non-OpenAI protocol still comes out
// as a working Anthropic stream.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';

const catalog = require('../src/main/catalog.js');
const modelsdev = require('../src/main/modelsdev.js');
const { AuthStore } = require('../src/main/authstore.js');
const oauthMod = require('../src/main/oauth.js');
const adapters = require('../src/main/adapters.js');
const { startProxy } = require('../src/main/proxy.js');

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', r));
const close = (s) => new Promise(r => s.close(r));

describe('provider catalog', () => {
  it('lists curated providers first with auth + protocol', () => {
    const list = catalog.build();
    expect(list.length).toBeGreaterThan(100);
    const ids = list.map(e => e.id);
    expect(ids.slice(0, 5)).toContain('anthropic');
    const anthropic = list.find(e => e.id === 'anthropic');
    expect(anthropic.protocol).toBe('anthropic');
    expect(anthropic.authKind).toBe('oauth+api');
    expect(anthropic.oauth.tokenUrl).toContain('anthropic.com');
  });

  it('derives providers from models.dev', () => {
    const list = catalog.build();
    const derived = list.find(e => e.derived);
    expect(derived).toBeTruthy();
    expect(derived.modelsDevId).toBeTruthy();
    expect(['anthropic', 'openai']).toContain(derived.protocol);
  });

  it('resolves placeholders in base URL templates', () => {
    expect(catalog.resolveTemplate('https://x/${ACCOUNT_ID}/v1', { ACCOUNT_ID: 'abc' }))
      .toBe('https://x/abc/v1');
    expect(catalog.resolveTemplate('https://x/${MISSING}/v1', {})).toBe('https://x/${MISSING}/v1');
    expect(catalog.placeholdersIn('a/${A}/b/${B}')).toEqual(['A', 'B']);
  });

  it('tags local runtimes', () => {
    const ollama = catalog.byId('ollama');
    expect(ollama.local).toBe(true);
    expect(ollama.baseUrl).toContain('11434');
  });

  it('ships the corrected NaraRouter endpoint', () => {
    const n = catalog.byId('nararouter');
    expect(n.baseUrl).toBe('https://router.bynara.id/v1');
    expect(n.protocol).toBe('openai');
  });

  it('ships both AgentRouter routes (OpenAI gateway + Anthropic/Claude)', () => {
    const openai = catalog.byId('agentrouter');
    const claude = catalog.byId('agentrouter-anthropic');
    expect(openai.protocol).toBe('openai');
    expect(openai.baseUrl).toBe('https://agentrouter.org/v1');
    expect(claude.protocol).toBe('anthropic');
    expect(claude.baseUrl).toBe('https://agentrouter.org');
    expect(claude.keyHeader).toBe('x-api-key');
  });
});

describe('models.dev catalog', () => {
  it('ships a bundled snapshot with providers and models', () => {
    const s = modelsdev.stat();
    expect(s.providers).toBeGreaterThan(100);
    expect(s.models).toBeGreaterThan(1000);
  });
  it('looks up models and picks a sensible default', () => {
    const m = modelsdev.model('anthropic', 'claude-sonnet-4-5-20250929');
    expect(m).toBeTruthy();
    expect(m.limit.context).toBeGreaterThan(100000);
    const best = modelsdev.bestModel('anthropic');
    expect(best).toBeTruthy();
    expect(best.tool_call).toBe(true);
  });
  it('searches models by substring', () => {
    const r = modelsdev.searchModels('claude', 5);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].provider).toBeTruthy();
  });
});

const bedrock = require('../src/main/bedrock.js');

describe('amazon bedrock', () => {
  it('recognises bedrock runtime/mantle urls and extracts the region', () => {
    expect(bedrock.isBedrockUrl('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1')).toBe(true);
    expect(bedrock.isBedrockUrl('https://bedrock-mantle.us-west-2.api.aws/v1')).toBe(true);
    expect(bedrock.isBedrockUrl('https://api.openai.com/v1')).toBe(false);
    expect(bedrock.regionFromUrl('https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1')).toBe('eu-west-1');
    expect(bedrock.chatUrl('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1'))
      .toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions');
  });

  it('ships a region-templated catalog entry with working defaults', () => {
    const b = catalog.byId('amazon-bedrock');
    expect(b.protocol).toBe('openai');
    expect(b.baseUrlTemplate).toContain('${REGION}');
    expect(catalog.resolveTemplate(b.baseUrlTemplate, { REGION: 'us-east-1' }))
      .toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
    const md = modelsdev.model('amazon-bedrock', b.defaultModel);
    expect(md).toBeTruthy();
    expect(md.limit.context).toBeGreaterThan(100000);
  });

  async function fakeBedrock(status, body) {
    const srv = http.createServer((_q, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await listen(srv);
    return { srv, base: 'http://127.0.0.1:' + srv.address().port };
  }

  it('probe: 200 means key and model are both valid', async () => {
    const { srv, base } = await fakeBedrock(200, { choices: [{ message: { content: 'hi' } }] });
    // point the prober at the fake server while keeping bedrock-shaped auth errors
    const r = await bedrock.probe(base, 'ABSK-test', 'm');
    expect(r.ok).toBe(true);
    expect(r.authOk).toBe(true);
    expect(r.modelOk).toBe(true);
    await close(srv);
  });

  it('probe: 400 unknown-model means auth passed, model wrong', async () => {
    const { srv, base } = await fakeBedrock(400, { message: "model 'nope' isn't supported on this route" });
    const r = await bedrock.probe(base, 'ABSK-test', 'nope');
    expect(r.ok).toBe(true);
    expect(r.authOk).toBe(true);
    expect(r.modelOk).toBe(false);
    await close(srv);
  });

  it('probe: 401/403 means the key is rejected', async () => {
    const { srv, base } = await fakeBedrock(401, { message: 'Unauthorized' });
    const r = await bedrock.probe(base, 'bad', 'm');
    expect(r.ok).toBe(false);
    expect(r.authOk).toBe(false);
    expect(r.error).toMatch(/ABSK/);
    await close(srv);
  });

  it('probe: unreachable host is a network error, not a key error', async () => {
    const r = await bedrock.probe('http://127.0.0.1:54321', 'ABSK-test', 'm', 3000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refused|timed out|resolve/i);
  });
});
describe('auth store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-auth-'));

  it('stores and resolves an API key', () => {
    const a = new AuthStore({ dir, safeStorage: null });
    a.init(dir);
    a.setApiKey('u1', 'sk-secret-123456');
    expect(a.has('u1')).toBe(true);
    expect(a.resolve('u1').apiKey).toBe('sk-secret-123456');
    expect(a.hint('u1')).toContain('sk-sec');
    expect(a.summary('u1').present).toBe(true);
    a.delete('u1');
    expect(a.has('u1')).toBe(false);
  });

  it('stores an oauth record and reports expiry', () => {
    const a = new AuthStore({ dir, safeStorage: null });
    a.init(dir);
    a.setOAuth('u2', { access: 'acc', refresh: 'ref', expires: Date.now() + 10000 });
    expect(a.resolve('u2').authToken).toBe('acc');
    expect(a.summary('u2').expired).toBe(false);
    a.setOAuth('u2', { access: 'acc', refresh: 'ref', expires: Date.now() - 1000 });
    expect(a.summary('u2').expired).toBe(true);
  });

  it('migrates secrets out of legacy config instances', () => {
    const a = new AuthStore({ dir, safeStorage: null });
    a.init(dir);
    const providers = [{ uid: 'legacy', apiKey: 'old-key', authToken: 'old-token' }];
    let saved = false;
    const n = a.migrateFromConfig(providers, () => { saved = true; });
    expect(n).toBe(1);
    expect(saved).toBe(true);
    expect(providers[0].apiKey).toBeUndefined();
    expect(a.resolve('legacy').apiKey).toBe('old-key');
  });
});

describe('oauth helpers', () => {
  it('builds a PKCE challenge from the verifier', () => {
    const { verifier, challenge } = oauthMod.makePkce();
    expect(verifier.length).toBeGreaterThan(20);
    const crypto = require('node:crypto');
    const expected = crypto.createHash('sha256').update(verifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
  it('splits the anthropic code#state form', () => {
    expect(oauthMod.codeFromInput('abc#xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(oauthMod.codeFromInput('abc')).toEqual({ code: 'abc', state: undefined });
  });
  it('normalises token payloads', () => {
    const t = oauthMod.normalizeTokens({ access_token: 'a', refresh_token: 'r', expires_in: 60 });
    expect(t.access).toBe('a');
    expect(t.expires).toBeGreaterThan(Date.now());
  });
  it('parses the redirect port', () => {
    expect(oauthMod.parseRedirectPort('http://localhost:1455/auth/callback')).toBe(1455);
    expect(oauthMod.parseRedirectPort('nonsense')).toBe(0);
  });
});

describe('adapters (pure translators)', () => {
  it('translates an Anthropic turn to OpenAI chat', () => {
    const out = adapters.buildOpenAIBody({
      model: 'm', max_tokens: 16,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'Read' },
    }, true);
    expect(out.messages[0].content).toBe('hi');
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'Read' } });
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it('translates a Responses payload and result', () => {
    const req = adapters.buildResponsesInput({ model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    expect(req.instructions).toBe('sys');
    expect(req.input[0].content[0].text).toBe('hi');
    const j = adapters.responsesToOpenAI({
      id: 'r1', output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/x"}' },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    }, 'm');
    expect(j.choices[0].message.content).toBe('hello');
    expect(j.choices[0].message.tool_calls[0].function.name).toBe('Read');
    expect(j.choices[0].finish_reason).toBe('tool_calls');
  });

  it('translates Gemini contents and results', () => {
    const req = adapters.buildGeminiBody({ model: 'gemini-x', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    expect(req.systemInstruction.parts[0].text).toBe('sys');
    expect(req.contents[0].parts[0].text).toBe('hi');
    const j = adapters.geminiToOpenAI({
      candidates: [{ content: { parts: [{ text: 'yo' }, { functionCall: { name: 'Bash', args: { command: 'ls' } } }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
    }, 'gemini-x');
    expect(j.choices[0].message.content).toBe('yo');
    expect(j.choices[0].message.tool_calls[0].function.name).toBe('Bash');
  });
});

describe('adapter routing through the proxy', () => {
  const TOKEN = 'adapters-token-abcdef';
  let h;

  /** Start a proxy in front of a fake upstream; return a caller. */
  async function withUpstream(handler, protocol) {
    const upstream = http.createServer(handler);
    await listen(upstream);
    const port = upstream.address().port;
    const proxy = await startProxy(
      () => ({ baseUrl: 'http://127.0.0.1:' + port, apiKey: 'k', protocol, keyHeader: 'query' }),
      { token: TOKEN, port: 0 },
    );
    const call = (body) => fetch('http://127.0.0.1:' + proxy.port + '/px/t1/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    return { proxy, upstream, call, async close() { await close(proxy.server); await close(upstream); } };
  }

  afterAll(() => h && h.close());

  it('routes a gemini-protocol provider and streams text back as Anthropic SSE', async () => {
    h = await withUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini says hi' }] } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } }) + '\n\n');
      res.end();
    }, 'gemini');
    const res = await h.call({ model: 'gemini-x', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('gemini says hi');
    expect(text).toContain('"stop_reason":"end_turn"');
    // The upstream received a Gemini-shaped request.
    expect(text).toContain('content_block_delta');
  });

  it('routes an openai-responses provider and recovers a function call', async () => {
    h = await withUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const s = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      s({ type: 'response.output_item.added', item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'Read' } });
      s({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"file_path":"/x"}' });
      s({ type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3 } } });
      res.end();
    }, 'openai-responses');
    const res = await h.call({ model: 'gpt-x', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'read /x' }] });
    const text = await res.text();
    expect(text).toContain('tool_use');
    expect(text).toContain('Read');
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});

describe('upstream fetch retry (broken-IPv6 hosts)', () => {
  const { fetchUpstream } = require('../src/main/adapters.js');

  it('succeeds on the second attempt after a connection failure', async () => {
    let n = 0;
    const srv = http.createServer((_q, res) => {
      n++;
      if (n === 1) { res.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await listen(srv);
    const r = await fetchUpstream('http://127.0.0.1:' + srv.address().port + '/x', { headers: {} }, AbortSignal.timeout(10000));
    expect(r.status).toBe(200);
    expect(n).toBe(2);
    await close(srv);
  });

  it('does not retry an aborted request', async () => {
    let n = 0;
    const srv = http.createServer((_q, res) => {
      n++;
      setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch { /* gone */ } }, 2000);
    });
    await listen(srv);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(fetchUpstream('http://127.0.0.1:' + srv.address().port + '/x', { headers: {} }, ac.signal))
      .rejects.toThrow();
    expect(n).toBe(1);
    await close(srv);
  });
});

describe('provider migrations', () => {
  const providers = require('../src/main/providers.js');
  const fakeStore = (list) => ({ providers: list, settings: {}, save() { this.saved = true; } });

  it('pins the 10 NaraRouter models once, then leaves them alone', () => {
    const store = fakeStore([{ uid: 'n1', presetId: 'nararouter', name: 'NaraRouter', baseUrl: 'https://router.bynara.id/v1', model: '', models: [], whitelist: [] }]);
    expect(providers.migrateModels(store)).toBe(true);
    const p = store.providers[0];
    expect(p.models).toHaveLength(10);
    expect(p.whitelist).toContain('jev');
    expect(p.whitelist).toContain('agnes-2.5-flash');
    expect(p.model).toBe('nemotron-3.5-lightning-free');
    expect(store.settings.appliedFixes.naraModels).toBe(true);
    // Second run: user removed one — not re-clobbered.
    p.models.pop();
    expect(providers.migrateModels(store)).toBe(false);
    expect(p.models).toHaveLength(9);
  });

  it('pins AgentRouter to deepseek-v4-flash only', () => {
    const store = fakeStore([{ uid: 'a1', presetId: 'agentrouter', protocol: 'anthropic', model: 'claude-opus-5', smallFastModel: 'claude-opus-5' }]);
    expect(providers.migrateModels(store)).toBe(true);
    expect(store.providers[0].model).toBe('deepseek-v4-flash');
    expect(store.providers[0].smallFastModel).toBe('deepseek-v4-flash');
  });

  it('repairs the dead NaraRouter domain', () => {
    const store = fakeStore([{ uid: 'n1', presetId: 'nararouter', baseUrl: 'https://api.nararouter.com/v1' }]);
    expect(providers.migrateUrls(store)).toBe(true);
    expect(store.providers[0].baseUrl).toBe('https://router.bynara.id/v1');
  });

  it('keeps a deepseek model on the AgentRouter OpenAI route across restarts', () => {
    const store = fakeStore([{ uid: 'a1', presetId: 'agentrouter', protocol: 'openai', baseUrl: 'https://agentrouter.org/v1', model: 'deepseek-v4-flash', smallFastModel: 'deepseek-v4-flash' }]);
    providers.migrateUrls(store); providers.migrateUrls(store);
    const p = store.providers[0];
    expect(p.protocol).toBe('openai');
    expect(p.baseUrl).toBe('https://agentrouter.org/v1');
    expect(p.model).toBe('deepseek-v4-flash');
  });

  it('still moves a Claude-model OpenAI-route AgentRouter instance to the Anthropic route', () => {
    const store = fakeStore([{ uid: 'a1', presetId: 'agentrouter', protocol: 'openai', model: 'claude-opus-5' }]);
    expect(providers.migrateUrls(store)).toBe(true);
    expect(store.providers[0].protocol).toBe('anthropic');
  });

  it('seeds every new NaraRouter instance with the free model list', () => {
    const a = providers.makeInstance(catalog.byId('nararouter'), {});
    const b = providers.makeInstance(catalog.byId('nararouter'), {});
    expect(a.models).toHaveLength(10);
    expect(b.models).toEqual(a.models);
    a.models.pop();
    expect(b.models).toHaveLength(10);   // not a shared array
  });

  it('repairs the exo-stealh typo and adds the missing free model once', () => {
    const store = fakeStore([{ uid: 'n1', presetId: 'nararouter', model: 'jev', models: ['jev', 'exo-stealh', 'mine'], whitelist: ['exo-stealh'] }]);
    store.settings.appliedFixes = { naraModels: true };
    expect(providers.migrateModels(store)).toBe(true);
    const p = store.providers[0];
    expect(p.models).toContain('exo-stealth');
    expect(p.models).not.toContain('exo-stealh');
    expect(p.models).toContain('mine');
    expect(p.models).toContain('ling-3.0-flash-fin-free');
    expect(providers.migrateModels(store)).toBe(false);
  });

  it('catalog carries the requested defaults', () => {
    expect(catalog.byId('nararouter').recommendedModels).toHaveLength(10);
    expect(catalog.byId('nararouter').defaultModel).toBe('nemotron-3.5-lightning-free');
    expect(catalog.byId('agentrouter').defaultModel).toBe('deepseek-v4-flash');
    expect(catalog.byId('agentrouter-anthropic').defaultModel).toBe('claude-opus-5');
  });
});

describe('stream truncation signals', () => {
  const { responsesChunks, geminiChunks } = require('../src/main/adapters.js');
  const body = (text) => ({ body: (async function* () { yield Buffer.from(text); })() });
  const collect = async (gen) => { const out = []; for await (const c of gen) out.push(c); return out; };

  it('maps response.incomplete to finish_reason length, even without a trailing newline', async () => {
    const out = await collect(responsesChunks(body('data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: {"type":"response.incomplete","response":{}}'), 'm'));
    expect(out.some(c => c.choices && c.choices[0] && c.choices[0].finish_reason === 'length')).toBe(true);
  });

  it('surfaces a non-STOP Gemini finish reason as visible text', async () => {
    const out = await collect(geminiChunks(body('data: {"candidates":[{"finishReason":"SAFETY","content":{"parts":[]}}]}'), 'm'));
    const txt = out.map(c => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content).filter(Boolean).join('');
    expect(txt).toContain('SAFETY');
  });
});

describe('fetchUpstream rate-limit retry', () => {
  const { fetchUpstream } = require('../src/main/adapters.js');
  const http = require('node:http');
  const serve = async (statuses) => {
    let n = 0;
    const srv = http.createServer((_q, res) => {
      const st = statuses[Math.min(n++, statuses.length - 1)];
      res.writeHead(st, { 'retry-after': '0' }); res.end('x');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    return { url: 'http://127.0.0.1:' + srv.address().port, hits: () => n, close: () => new Promise(r => srv.close(r)) };
  };

  it('retries a 429 and returns the later success', async () => {
    const s = await serve([429, 429, 200]);
    const res = await fetchUpstream(s.url, {});
    expect(res.status).toBe(200);
    expect(s.hits()).toBe(3);
    await s.close();
  });

  it('does not retry 503 (wrong model id on gateways)', async () => {
    const s = await serve([503, 200]);
    const res = await fetchUpstream(s.url, {});
    expect(res.status).toBe(503);
    expect(s.hits()).toBe(1);
    await s.close();
  });

  it('gives up after two waits and returns the 429', async () => {
    const s = await serve([429]);
    const res = await fetchUpstream(s.url, {});
    expect(res.status).toBe(429);
    expect(s.hits()).toBe(3);
    await s.close();
  });
});

describe('models.dev refresh', () => {
  it('compacts a live catalog without a shadowed-name crash', async () => {
    const md = require('../src/main/modelsdev.js');
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ acme: { id: 'acme', name: 'Acme', models: { m1: { id: 'm1', name: 'M1', limit: { context: 1000 } } } } }) });
    try {
      const r = await md.refresh();
      expect(r.source).toBe('live');
      expect(r.providers).toBeGreaterThan(0);
    } finally { globalThis.fetch = real; }
  });
});
