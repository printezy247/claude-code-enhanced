// A gateway that fingerprints the client (OpenCode Go) rejects a request with
// no User-Agent, and one with no session id. Both are things the upstream
// request must carry, so they are locked in here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { startProxy } = require('../src/main/proxy.js');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

describe('upstream request identity', () => {
  it('sends a client-identifying user-agent and the session id', async () => {
    const got = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.push({ url: req.url, headers: req.headers });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 1 },
        }));
      });
    });
    const upstreamPort = await listen(upstream);

    const proxy = await startProxy(() => ({
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'test-key',
      protocol: 'openai',
      keyHeader: 'bearer',
      headers: {},
      appVersion: '9.9.9',
    }), { token: 'tok' });

    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.port, method: 'POST',
        path: '/px/uid1/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok',
          'x-claude-code-session-id': 'sess-42',
        },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({
        model: 'm', stream: false, max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }));
    });

    expect(got.length).toBe(1);
    // A generic library name is what these gateways reject.
    expect(got[0].headers['user-agent']).toMatch(/claude-code-enhanced\//);
    expect(got[0].headers['user-agent']).not.toMatch(/^(node|undici)$/);
    expect(got[0].headers['x-opencode-session']).toBe('sess-42');
    expect(got[0].headers['x-claude-code-session-id']).toBe('sess-42');

    proxy.server.close();
    upstream.close();
  });

  it('lets the provider override the user-agent', async () => {
    const got = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.push(req.headers);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    const upstreamPort = await listen(upstream);

    const proxy = await startProxy(() => ({
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'k', protocol: 'openai', keyHeader: 'bearer',
      headers: { 'user-agent': 'my-agent/1.0' },
    }), { token: 'tok' });

    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.port, method: 'POST',
        path: '/px/uid1/v1/messages',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'm', stream: false, max_tokens: 4, messages: [] }));
    });

    expect(got[0]['user-agent']).toBe('my-agent/1.0');
    proxy.server.close();
    upstream.close();
  });
});
