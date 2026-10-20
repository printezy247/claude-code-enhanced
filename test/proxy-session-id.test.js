// End-to-end: the translator proxy must put the session id on the UPSTREAM
// request, not just on the engine-facing one.
//
// A Go provider answers "400 Request is missing x-opencode-session" without
// it, which is what the user hit. This drives the real proxy (handleTranslated
// through the HTTP server) against a fake upstream and inspects what arrived.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { startProxy, mapError } = require('../src/main/proxy.js');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

describe('proxy forwards the session id upstream', () => {
  it('sends x-opencode-session and the engine session id to the provider', async () => {
    const got = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 1 },
        }));
      });
    });
    const upstreamPort = await listen(upstream);

    const prov = {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'test-key',
      protocol: 'openai',
      keyHeader: 'bearer',
      headers: {},
    };

    const proxy = await startProxy(() => prov, { token: 'tok' });
    const body = JSON.stringify({
      model: 'm', stream: false, max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });

    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.port, method: 'POST',
        path: '/px/uid1/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok',
          'x-claude-code-session-id': 'session-abc',
        },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(body);
    });

    expect(got.length).toBe(1);
    expect(got[0].headers['x-opencode-session']).toBe('session-abc');
    expect(got[0].headers['x-claude-code-session-id']).toBe('session-abc');
    // The provider credential must still be the provider's, not the proxy's.
    expect(got[0].headers.authorization).toBe('Bearer test-key');

    proxy.server.close();
    upstream.close();
  });
});

describe('session-routed provider errors', () => {
  it('explains a missing session id instead of passing the raw 400 through', () => {
    const e = mapError(400, 'Request is missing x-opencode-session and cannot be routed efficiently.');
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/session id/i);
    expect(e.message).not.toMatch(/missing x-opencode-session/);
  });

  it('leaves other provider errors alone', () => {
    const e = mapError(401, 'Invalid credential');
    expect(e.status).toBe(401);
    expect(e.type).toBe('authentication_error');
  });
});
