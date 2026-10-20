// The per-connector tool policy must not drop the other connectors.
//
// setMcpServers REPLACES the whole dynamic server set: a payload that omits
// a server removes it. Verified against a live session — a working 47-tool
// connector went to 0 tools after an unrelated call. So the manager always
// sends the complete accumulated set, and the policy rides on the server's
// own definition (a copy without the server's credentials fails and loses
// every tool).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let lastOptions = null;
let setMcpServers = vi.fn(async (servers) => ({ added: Object.keys(servers), removed: [], errors: {} }));

// The SDK override is the module itself: chats.js does `const { query } = await this.sdk()`.
const fakeSdk = {
  query: ({ options }) => {
    lastOptions = options;
    // The generator must stay open: when it ends, chats.js deletes the chat.
    return Object.assign((async function* () { await new Promise(() => {}); })(), {
      interrupt: vi.fn(async () => ({})),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      rewindFiles: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => ({ totalTokens: 1, maxTokens: 2, percentage: 50 })),
      mcpServerStatus: vi.fn(async () => []),
      toggleMcpServer: vi.fn(async () => ({})),
      reconnectMcpServer: vi.fn(async () => ({})),
      setMcpServers,
      supportedAgents: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      applyFlagSettings: vi.fn(async () => ({})),
      stopTask: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []),
      setMaxThinkingTokens: vi.fn(async () => {}),
      reinitialize: vi.fn(async () => ({})),
    });
  },
};

const ChatManager = require('../src/main/chats.js');

let mgr;
beforeEach(() => {
  lastOptions = null;
  setMcpServers = vi.fn(async (servers) => ({ added: Object.keys(servers), removed: [], errors: {} }));
  fakeSdk.query = ({ options }) => {
    lastOptions = options;
    // The generator must stay open: when it ends, chats.js deletes the chat.
    return Object.assign((async function* () { await new Promise(() => {}); })(), {
      interrupt: vi.fn(async () => ({})),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      rewindFiles: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => ({ totalTokens: 1, maxTokens: 2, percentage: 50 })),
      mcpServerStatus: vi.fn(async () => []),
      toggleMcpServer: vi.fn(async () => ({})),
      reconnectMcpServer: vi.fn(async () => ({})),
      setMcpServers,
      supportedAgents: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      applyFlagSettings: vi.fn(async () => ({})),
      stopTask: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []),
      setMaxThinkingTokens: vi.fn(async () => {}),
      reinitialize: vi.fn(async () => ({})),
    });
  };
  mgr = new ChatManager({ proxyToken: 'tok', sdk: fakeSdk });
});

const start = async () => {
  const res = await mgr.create({
    cwd: '/tmp', providerInstance: null, settings: {}, permissionMode: 'default',
  });
  return res.id;
};

describe('connector tool policy', () => {
  it('puts the always_ask policy on the named tools', async () => {
    const id = await start();
    await mgr.mcpSetPolicy(id, 'github', { type: 'http', url: 'https://x/mcp' }, ['create_repository'], 'always_ask');
    const payload = setMcpServers.mock.calls[0][0];
    expect(payload.github.tools).toEqual([{ name: 'create_repository', permission_policy: 'always_ask' }]);
    expect(payload.github.url).toBe('https://x/mcp');
  });

  it('keeps the server credentials on the re-registered copy', async () => {
    const id = await start();
    await mgr.mcpSetPolicy(id, 'github', { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }, ['a'], 'always_ask');
    const payload = setMcpServers.mock.calls[0][0];
    expect(payload.github.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('sends the complete set, so a second policy does not drop the first server', async () => {
    const id = await start();
    await mgr.mcpSetPolicy(id, 'github', { type: 'http', url: 'https://x/mcp' }, ['a'], 'always_ask');
    await mgr.mcpSetPolicy(id, 'linear', { type: 'http', url: 'https://y/mcp' }, ['b'], 'always_ask');
    const second = setMcpServers.mock.calls[1][0];
    expect(Object.keys(second).sort()).toEqual(['github', 'linear']);
  });

  it('refuses an empty tool list instead of registering a policy-free server', async () => {
    const id = await start();
    await expect(mgr.mcpSetPolicy(id, 'github', { type: 'http', url: 'https://x/mcp' }, [], 'always_ask'))
      .rejects.toThrow(/no tools/i);
    expect(setMcpServers).not.toHaveBeenCalled();
  });
});
