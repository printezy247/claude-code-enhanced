// The host-owned MCP broker: the model names a connector and a tool; URLs,
// headers and OAuth tokens never leave the main process.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBroker, HOST_CALL_TOOL, policyNameFor } = require('../src/main/hostmcp.js');
const { McpAuthError } = require('../src/main/mcpclient.js');

const SECRET = 'ghp_supersecrettoken123';

/** A fake client that records how it was built and what it was asked. */
function fakeFactory(behaviour = {}) {
  const built = [];
  const factory = (opts) => {
    const client = {
      opts, closed: false,
      initialize: vi.fn(async () => {}),
      listTools: vi.fn(async () => behaviour.tools || [
        { name: 'read_issue', description: 'Read', inputSchema: { type: 'object' } },
        { name: 'delete_issue', description: 'Del', inputSchema: { type: 'object' } },
      ]),
      callTool: vi.fn(async (tool, args) => {
        if (behaviour.callTool) return behaviour.callTool(tool, args, opts);
        return { content: [{ type: 'text', text: 'ok ' + tool }], isError: false };
      }),
      close: vi.fn(async () => { client.closed = true; }),
    };
    built.push(client);
    return client;
  };
  factory.built = built;
  return factory;
}

function makeBroker(over = {}) {
  const clientFactory = over.clientFactory || fakeFactory();
  const tokens = over.tokens || new Map();
  const broker = createBroker({
    resolveServer: async (name) => (name === 'github'
      ? { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer ' + SECRET } }
      : name === 'local' ? { type: 'stdio', command: 'x' } : null),
    getToken: (name) => tokens.get(name),
    clearToken: (name) => tokens.delete(name),
    isToolActive: over.isToolActive || (() => true),
    clientFactory,
    now: over.now || (() => 1000),
  });
  return { broker, clientFactory, tokens };
}

describe('host MCP broker', () => {
  it('lists only the tools the session selected, without connection details', async () => {
    const { broker } = makeBroker({ isToolActive: (_s, _c, t) => t === 'read_issue' });
    const out = await broker.listTools('s1', 'github');
    expect(out.map((t) => t.name)).toEqual(['read_issue']);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('api.example.com');
  });

  it('calls an active tool with the configured auth header held in the host', async () => {
    const { broker, clientFactory } = makeBroker();
    const res = await broker.callTool('s1', 'github', 'read_issue', { n: 1 });
    expect(res.isError).toBe(false);
    expect(clientFactory.built[0].opts.headers.Authorization).toBe('Bearer ' + SECRET);
    expect(clientFactory.built[0].callTool).toHaveBeenCalledWith('read_issue', { n: 1 });
    expect(clientFactory.built[0].closed).toBe(true);
  });

  it('denies a tool the session did not enable, without contacting the server', async () => {
    const { broker, clientFactory } = makeBroker({ isToolActive: () => false });
    const res = await broker.callTool('s1', 'github', 'delete_issue', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not enabled/i);
    expect(clientFactory.built).toHaveLength(0);
  });

  it('denies an unknown connector and a non-HTTP connector', async () => {
    const { broker } = makeBroker();
    expect((await broker.callTool('s1', 'nope', 't', {})).content[0].text).toMatch(/no connector/i);
    expect((await broker.callTool('s1', 'local', 't', {})).content[0].text).toMatch(/http|sse/i);
  });

  it('prefers a live OAuth token over the configured header', async () => {
    const tokens = new Map([['github', { accessToken: 'fresh', tokenType: 'Bearer', expiresAt: 5000 }]]);
    const { broker, clientFactory } = makeBroker({ tokens });
    await broker.callTool('s1', 'github', 'read_issue', {});
    expect(clientFactory.built[0].opts.headers.Authorization).toBe('Bearer fresh');
  });

  it('drops an expired token and falls back to the configured header', async () => {
    const tokens = new Map([['github', { accessToken: 'stale', tokenType: 'Bearer', expiresAt: 999 }]]);
    const { broker, clientFactory } = makeBroker({ tokens });
    await broker.callTool('s1', 'github', 'read_issue', {});
    expect(clientFactory.built[0].opts.headers.Authorization).toBe('Bearer ' + SECRET);
    expect(tokens.has('github')).toBe(false);
  });

  it('turns a 401 into a sign-in message and forgets the rejected token', async () => {
    const tokens = new Map([['github', { accessToken: 'rejected', expiresAt: null }]]);
    const clientFactory = fakeFactory({ callTool: () => { throw new McpAuthError('401 from server', {}); } });
    const { broker } = makeBroker({ tokens, clientFactory });
    const res = await broker.callTool('s1', 'github', 'read_issue', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/sign in|authenticate/i);
    expect(tokens.has('github')).toBe(false);
  });

  it('masks secrets in results and in error text', async () => {
    const leaky = fakeFactory({
      callTool: () => ({ content: [{ type: 'text', text: 'echo Bearer ' + SECRET + ' at https://api.example.com/mcp' }], isError: false }),
    });
    const a = await makeBroker({ clientFactory: leaky }).broker.callTool('s1', 'github', 'read_issue', {});
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(JSON.stringify(a)).not.toContain('api.example.com');

    const failing = fakeFactory({ callTool: () => { throw new Error('connect failed to https://api.example.com/mcp with ' + SECRET); } });
    const b = await makeBroker({ clientFactory: failing }).broker.callTool('s1', 'github', 'read_issue', {});
    expect(b.isError).toBe(true);
    expect(JSON.stringify(b)).not.toContain(SECRET);
    expect(JSON.stringify(b)).not.toContain('api.example.com');
  });

  it('maps a host call to the policy name the permission layer already knows', () => {
    expect(HOST_CALL_TOOL).toMatch(/^mcp__/);
    expect(policyNameFor(HOST_CALL_TOOL, { server: 'github', tool: 'delete_issue' })).toBe('mcp__github__delete_issue');
    expect(policyNameFor('Bash', { server: 'github', tool: 'x' })).toBe('Bash');
    expect(policyNameFor(HOST_CALL_TOOL, {})).toBe(HOST_CALL_TOOL);
  });
});
