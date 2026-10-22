// The host-side MCP client: the wire protocol, not the CLI.
//
// Every test talks to a local node:http server on an ephemeral port — no
// network, no external service, no credentials. The server is a hand-written
// JSON-RPC peer, so the tests pin the protocol (ids, the initialized
// notification, the SSE framing) rather than a mock's idea of it.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { McpClient, McpAuthError, callTool, deviceCodeAuth } = require('../src/main/mcpclient.js');

const servers = [];

/** Start a local server; `handler` is a plain node:http request handler. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const entry = {
        server,
        port,
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      };
      servers.push(entry);
      resolve(entry);
    });
  });
}

afterEach(async () => {
  while (servers.length) await servers.pop().close();
});

/**
 * A JSON-RPC peer over plain HTTP.
 *
 * `handlers` maps a method to a result (or to a function of the request).
 * A handler may also return `{ error: { code, message } }` to answer with a
 * protocol error. Notifications get an empty 202, as the spec asks.
 * Every received message is recorded in `seen`.
 */
function serveMcp(handlers, seen = []) {
  return (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let msg = null;
      try { msg = JSON.parse(raw); } catch { /* not JSON */ }
      if (msg) seen.push(msg);
      const method = msg && msg.method;
      if (!method) { res.writeHead(400); res.end(); return; }
      if (method.startsWith('notifications/')) {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('');
        return;
      }
      const handler = handlers[method];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${method}` } }));
        return;
      }
      const value = typeof handler === 'function' ? handler(msg) : handler;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (value && value.error) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: value.error }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: value }));
    });
  };
}

const INIT_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true }, resources: {} },
  serverInfo: { name: 'test-server', version: '1.2.3' },
};

describe('initialize', () => {
  it('returns the server info and the capabilities', async () => {
    const s = await startServer(serveMcp({ initialize: INIT_RESULT }));
    const client = new McpClient({ url: s.url });
    const info = await client.initialize();
    expect(info.serverInfo).toEqual({ name: 'test-server', version: '1.2.3' });
    expect(info.capabilities).toEqual({ tools: { listChanged: true }, resources: {} });
    expect(info.protocolVersion).toBe('2025-06-18');
    await client.close();
  });

  it('sends the initialize request and then the initialized notification', async () => {
    const seen = [];
    const s = await startServer(serveMcp({ initialize: INIT_RESULT }, seen));
    const client = new McpClient({ url: s.url });
    await client.initialize();
    await client.close();

    const init = seen.find((m) => m.method === 'initialize');
    expect(init.jsonrpc).toBe('2.0');
    expect(init.id).toBeDefined();
    expect(init.params.protocolVersion).toBe('2025-06-18');
    expect(init.params.clientInfo.name).toBe('claude-code-enhanced');
    expect(init.params.clientInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    // No client capabilities are claimed — this client does not implement
    // sampling, elicitation or roots.
    expect(init.params.capabilities).toEqual({});

    const ready = seen.find((m) => m.method === 'notifications/initialized');
    expect(ready).toBeTruthy();
    // A notification has no id and expects no answer.
    expect(ready.id).toBeUndefined();
  });

  it('gives every request its own id', async () => {
    const seen = [];
    const s = await startServer(serveMcp({ initialize: INIT_RESULT, 'tools/list': { tools: [] } }, seen));
    const client = new McpClient({ url: s.url });
    await client.initialize();
    await client.listTools();
    await client.close();
    const ids = seen.filter((m) => m.id !== undefined).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('listTools', () => {
  it('normalises the tool list', async () => {
    const s = await startServer(serveMcp({
      initialize: INIT_RESULT,
      'tools/list': {
        tools: [
          { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          { name: 'ping' },
        ],
      },
    }));
    const client = new McpClient({ url: s.url });
    const tools = await client.listTools();
    expect(tools).toEqual([
      { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'ping', description: '', inputSchema: { type: 'object', properties: {} } },
    ]);
    await client.close();
  });
});

describe('callTool', () => {
  it('returns the content of a tool that worked', async () => {
    const s = await startServer(serveMcp({
      initialize: INIT_RESULT,
      'tools/call': { content: [{ type: 'text', text: 'found it' }] },
    }));
    const client = new McpClient({ url: s.url });
    const out = await client.callTool('search', { q: 'x' });
    expect(out.content).toEqual([{ type: 'text', text: 'found it' }]);
    expect(out.isError).toBe(false);
    await client.close();
  });

  it('marks a failed tool with isError instead of throwing', async () => {
    const s = await startServer(serveMcp({
      initialize: INIT_RESULT,
      'tools/call': { content: [{ type: 'text', text: 'the tool exploded' }], isError: true },
    }));
    const client = new McpClient({ url: s.url });
    const out = await client.callTool('boom', {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe('the tool exploded');
    await client.close();
  });
});

describe('errors', () => {
  it('throws with the message of a JSON-RPC error', async () => {
    const s = await startServer(serveMcp({
      initialize: INIT_RESULT,
      'tools/call': { error: { code: -32602, message: 'Unknown tool: nope' } },
    }));
    const client = new McpClient({ url: s.url });
    await expect(client.callTool('nope', {})).rejects.toThrow(/Unknown tool: nope/);
    await client.close();
  });

  it('throws with the message of a JSON-RPC error in a non-2xx body', async () => {
    const s = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Bad Request: no session' } }));
      });
    });
    const client = new McpClient({ url: s.url });
    await expect(client.initialize()).rejects.toThrow(/Bad Request: no session/);
    await client.close();
  });

  it('throws an McpAuthError on a 401', async () => {
    const s = await startServer((req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unauthorized' } }));
    });
    const client = new McpClient({ url: s.url });
    const err = await client.initialize().catch((e) => e);
    expect(err).toBeInstanceOf(McpAuthError);
    expect(err.status).toBe(401);
    expect(err.resourceMetadata).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
    await client.close();
  });

  it('times out with a message that says so', async () => {
    // The server takes the request and never answers.
    const s = await startServer(() => { /* silence */ });
    const client = new McpClient({ url: s.url, timeoutMs: 250 });
    await expect(client.initialize()).rejects.toThrow(/timed out|timeout/i);
    await client.close();
  });

  it('asks again after a 429, but not after a 502', async () => {
    let hits = 0;
    const s = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (JSON.parse(raw).method !== 'initialize') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end('');
          return;
        }
        hits++;
        if (hits === 1) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'slow down' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: INIT_RESULT }));
      });
    });
    const client = new McpClient({ url: s.url });
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe('test-server');
    expect(hits).toBe(2);
    await client.close();
  });

  it('never repeats a call that may already have run', async () => {
    let hits = 0;
    const s = await startServer((req, res) => {
      hits++;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'bad gateway' } }));
    });
    const client = new McpClient({ url: s.url });
    await expect(client.initialize()).rejects.toThrow(/bad gateway/);
    // A 502 may hide a tool call that already ran, so it is not repeated.
    expect(hits).toBe(1);
    await client.close();
  });
});

describe('event-stream answers', () => {
  it('parses a response that arrives as text/event-stream', async () => {
    const s = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('event: message\n');
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT })}\n\n`);
        res.end();
      });
    });
    const client = new McpClient({ url: s.url });
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe('test-server');
    await client.close();
  });

  it('answers the legacy HTTP+SSE transport over the event stream', async () => {
    const writers = [];
    const s = await startServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        // The endpoint event names where the client must POST its messages.
        res.write('event: endpoint\ndata: /messages?sessionId=abc\n\n');
        writers.push((msg) => res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('');
        const answer = msg.method === 'initialize'
          ? { jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }
          : { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search' }] } };
        for (const write of writers) write(answer);
      });
    });
    const client = new McpClient({ url: s.url, transport: 'sse' });
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe('test-server');
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'search', description: '', inputSchema: { type: 'object', properties: {} } }]);
    await client.close();
  });

  it('hands a server notification to the host', async () => {
    const s = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // The tool list changed — a notification, then the answer.
        res.write('event: message\n');
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
        res.write('event: message\n');
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT })}\n\n`);
        res.end();
      });
    });
    const seen = [];
    const client = new McpClient({ url: s.url, onNotification: (m) => seen.push(m) });
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe('test-server');
    expect(seen.map((m) => m.method)).toEqual(['notifications/tools/list_changed']);
    await client.close();
  });

  it('sends the session id the server handed out back to it', async () => {
    const seen = [];
    const s = await startServer((req, res) => {
      seen.push(req.headers);
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-42' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }));
      });
    });
    const client = new McpClient({ url: s.url });
    await client.initialize();
    await client.close();
    expect(seen[0]['mcp-session-id']).toBeUndefined();   // not known yet
    expect(seen[1]['mcp-session-id']).toBe('sess-42');    // the notification carries it
  });
});

describe('the credential stays on the configured host', () => {
  it('does not send the Authorization header to another host', async () => {
    const seenAt = [];
    // The other host: a second server, so a different host:port pair.
    const other = await startServer((req, res) => {
      seenAt.push(req.headers);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('');
    });
    const s = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // The endpoint points somewhere else entirely.
      res.write(`event: endpoint\ndata: ${other.url}/messages\n\n`);
    });
    const client = new McpClient({
      url: s.url,
      transport: 'sse',
      headers: { Authorization: 'Bearer super-secret' },
      timeoutMs: 500,
    });
    // The other server never answers, so the call itself fails — the point of
    // the test is which headers it saw.
    await expect(client.initialize()).rejects.toThrow();
    await client.close();

    expect(seenAt.length).toBeGreaterThan(0);
    for (const headers of seenAt) expect(headers.authorization).toBeUndefined();
  });

  it('does send it to the configured host', async () => {
    const seen = [];
    const s = await startServer((req, res) => {
      seen.push(req.headers);
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: INIT_RESULT }));
      });
    });
    const client = new McpClient({ url: s.url, headers: { Authorization: 'Bearer super-secret' } });
    await client.initialize();
    await client.close();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].authorization).toBe('Bearer super-secret');
  });
});

describe('the one-shot helper', () => {
  it('initializes, calls the tool and closes', async () => {
    const seen = [];
    const s = await startServer(serveMcp({
      initialize: INIT_RESULT,
      'tools/call': { content: [{ type: 'text', text: 'one shot' }] },
    }, seen));
    const out = await callTool({ url: s.url, name: 'search', args: { q: 'x' } });
    expect(out).toEqual({ content: [{ type: 'text', text: 'one shot' }], isError: false });
    expect(seen.map((m) => m.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  });

  it('uses the fetch implementation it was given', async () => {
    const s = await startServer(serveMcp({
      initialize: INIT_RESULT,
      'tools/call': { content: [{ type: 'text', text: 'injected' }] },
    }));
    let calls = 0;
    const fetchImpl = (url, init) => { calls++; return globalThis.fetch(url, init); };
    const out = await callTool({ url: s.url, name: 'search', args: {}, fetchImpl });
    expect(out.content[0].text).toBe('injected');
    expect(calls).toBe(3);   // initialize, the notification, the call
  });
});

describe('resources', () => {
  it('lists and reads resources', async () => {
    const s = await startServer(serveMcp({
      initialize: INIT_RESULT,
      'resources/list': { resources: [{ uri: 'file:///a.txt', name: 'a', description: 'a file', mimeType: 'text/plain' }] },
      'resources/read': { contents: [{ uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' }] },
    }));
    const client = new McpClient({ url: s.url });
    const resources = await client.listResources();
    expect(resources).toEqual([{ uri: 'file:///a.txt', name: 'a', description: 'a file', mimeType: 'text/plain' }]);
    const read = await client.readResource('file:///a.txt');
    expect(read.contents[0].text).toBe('hello');
    await client.close();
  });
});

describe('OAuth 2.1 device code', () => {
  it('discovers the endpoints, shows the code and polls for the token', async () => {
    const polls = [];
    const s = await startServer((req, res) => {
      const base = `http://127.0.0.1:${s.port}`;
      if (req.url === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // The server names its authorization server (RFC 9728).
        res.end(JSON.stringify({ resource: 'https://mcp.example.com/mcp', authorization_servers: [base] }));
        return;
      }
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          device_authorization_endpoint: `${base}/device`,
          token_endpoint: `${base}/token`,
        }));
        return;
      }
      if (req.url === '/device') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          device_code: 'dev-123',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://auth.example.com/device',
          expires_in: 600,
          interval: 0,
        }));
        return;
      }
      if (req.url === '/token') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          polls.push(Object.fromEntries(new URLSearchParams(raw)));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'at-secret', token_type: 'Bearer', expires_in: 3600 }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const out = await deviceCodeAuth({ url: s.url, oauth: { clientId: 'cce-test' } });
    expect(out.accessToken).toBe('at-secret');
    expect(out.tokenType).toBe('Bearer');
    expect(out.expiresIn).toBe(3600);
    // The caller needs the code to show the user.
    expect(out.userCode).toBe('WXYZ-1234');
    expect(out.verificationUri).toBe('https://auth.example.com/device');
    // The poll carries the device-code grant.
    expect(polls[0].grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(polls[0].device_code).toBe('dev-123');
    expect(polls[0].client_id).toBe('cce-test');
  });

  it('keeps polling while the user has not approved the code yet', async () => {
    let polls = 0;
    const s = await startServer((req, res) => {
      if (req.url === '/device') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ device_code: 'dev-123', user_code: 'ABCD', verification_uri: 'https://auth.example.com/device', interval: 0 }));
        return;
      }
      if (req.url === '/token') {
        polls++;
        res.writeHead(polls < 2 ? 400 : 200, { 'content-type': 'application/json' });
        if (polls < 2) {
          res.end(JSON.stringify({ error: 'authorization_pending', error_description: 'the user has not approved it yet' }));
          return;
        }
        res.end(JSON.stringify({ access_token: 'at-secret', token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const out = await deviceCodeAuth({
      url: s.url,
      oauth: { deviceUrl: `http://127.0.0.1:${s.port}/device`, tokenUrl: `http://127.0.0.1:${s.port}/token` },
    });
    expect(polls).toBe(2);
    expect(out.accessToken).toBe('at-secret');
  });

  it('never puts a credential in an error message', async () => {
    const s = await startServer((req, res) => {
      if (req.url === '/device') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ device_code: 'dev-123', user_code: 'ABCD', verification_uri: 'https://auth.example.com/device', interval: 0 }));
        return;
      }
      if (req.url === '/token') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'access_denied', error_description: 'the user refused' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const err = await deviceCodeAuth({
      url: s.url,
      oauth: { deviceUrl: `http://127.0.0.1:${s.port}/device`, tokenUrl: `http://127.0.0.1:${s.port}/token` },
    }).catch((e) => e);
    expect(String(err.message)).toContain('the user refused');
    expect(String(err.message)).not.toContain('dev-123');
    expect(String(err.message)).not.toContain('at-secret');
  });
});
