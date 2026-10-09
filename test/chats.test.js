// ChatManager permission + control surface.
//
// Covers the multi-permission queue (#2), suggestion-scoped "always allow" (#3),
// interrupt clearing (#11), chat-scoped answers (#20), and lean tools (#41).
// The Agent SDK is mocked so no engine process is spawned.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Frames the fake query() emits, in order. Replaceable per test. */
let frames = [];
/** Options the last query() call received. */
let lastOptions = null;
/** The fake control interface handed to the chat. */
let ctrl = null;

// Injected through the manager's constructor rather than vi.mock: the SDK is
// pulled in with a dynamic import from inside a CJS module, which vitest's
// mock registry does not cover.
const fakeSdk = {
  query: ({ options }) => {
    lastOptions = options;
    ctrl = {
      interrupt: vi.fn(async () => ({ still_queued: [] })),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      rewindFiles: vi.fn(async () => ({ canRewind: true, skippedLinks: 2 })),
      getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100, percentage: 10 })),
      mcpServerStatus: vi.fn(async () => []),
      toggleMcpServer: vi.fn(async () => ({})),
      reconnectMcpServer: vi.fn(async () => ({})),
      supportedAgents: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      applyFlagSettings: vi.fn(async () => ({})),
      stopTask: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []),
      setMaxThinkingTokens: vi.fn(async () => {}),
      reinitialize: vi.fn(async () => ({})),
    };
    const gen = (async function* () {
      for (const f of frames) {
        if (f === 'WAIT') await new Promise(() => {});
        else yield f;
      }
    })();
    // The real query() returns ONE object that is both the AsyncGenerator and
    // the control interface; mirror that so chats.js can call both.
    return Object.assign(gen, ctrl);
  },
};

const ChatManager = require('../src/main/chats.js');

/** Collect every event the manager emits. */
function record(mgr) {
  const events = [];
  mgr.on('event', (id, evt) => events.push({ id, ...evt }));
  return events;
}

/** Wait until `pred()` is true or the budget runs out. */
const until = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return pred();
};

let mgr;
let events;

beforeEach(() => {
  frames = [];
  lastOptions = null;
  ctrl = null;
  mgr = new ChatManager({ proxyToken: 'tok-123', sdk: fakeSdk });
  events = record(mgr);
});

/** Create a chat whose stream never yields (so it stays open). */
async function openChat(extra = {}) {
  frames = ['WAIT'];
  const res = await mgr.create({
    cwd: '/tmp', providerInstance: null, settings: {}, ...extra,
  });
  return res;
}

describe('permission requests', () => {
  it('keeps two concurrent requests pending instead of dropping one (#2)', async () => {
    const { id } = await openChat();
    const ctxA = { signal: new AbortController().signal, suggestions: [], toolUseID: 'tool_a' };
    const ctxB = { signal: new AbortController().signal, suggestions: [], toolUseID: 'tool_b' };
    const pA = lastOptions.canUseTool('Bash', { command: 'ls' }, ctxA);
    const pB = lastOptions.canUseTool('Bash', { command: 'rm -rf /tmp/x' }, ctxB);
    await until(() => events.filter(e => e.kind === 'permission').length === 2);

    const perms = events.filter(e => e.kind === 'permission');
    expect(perms).toHaveLength(2);
    // Distinct ids: the UI can now hold both cards.
    expect(perms[0].requestId).not.toBe(perms[1].requestId);
    expect(mgr.pendingPerms.size).toBe(2);

    // Answering one must not resolve the other.
    let a = null;
    pA.then(r => { a = r; });
    mgr.answer(id, perms[0].requestId, 'allow');
    await until(() => a !== null);
    expect(a.behavior).toBe('allow');
    expect(mgr.pendingPerms.size).toBe(1);

    let b = null;
    pB.then(r => { b = r; });
    mgr.answer(id, perms[1].requestId, 'deny');
    await until(() => b !== null);
    expect(b.behavior).toBe('deny');
  });

  it('"always allow" returns the engine suggestions, not a blanket tool rule (#3)', async () => {
    const { id } = await openChat();
    const suggestions = [{
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      behavior: 'allow',
      destination: 'session',
    }];
    const p = lastOptions.canUseTool('Bash', { command: 'npm test' }, {
      signal: new AbortController().signal, suggestions, toolUseID: 't1',
    });
    await until(() => events.some(e => e.kind === 'permission'));
    let out = null;
    p.then(r => { out = r; });
    mgr.answer(id, events.find(e => e.kind === 'permission').requestId, 'always');
    await until(() => out !== null);
    expect(out.updatedPermissions).toEqual(suggestions);
    // The dangerous case from the report: no rule without ruleContent, which is
    // what a bare { toolName } produced (approve `ls` -> approve everything).
    for (const upd of out.updatedPermissions) {
      for (const rule of upd.rules || []) {
        expect(rule.ruleContent, 'rule must be scoped, not bare toolName').toBeTruthy();
      }
    }
  });

  it('honours suppressAlwaysAllowRule by allowing only this call (#3)', async () => {
    const { id } = await openChat();
    const p = lastOptions.canUseTool('Bash', { command: 'ls' }, {
      signal: new AbortController().signal, suggestions: [{ type: 'addRules', rules: [] }],
      suppressAlwaysAllowRule: true,
    });
    await until(() => events.some(e => e.kind === 'permission'));
    let out = null;
    p.then(r => { out = r; });
    mgr.answer(id, events.find(e => e.kind === 'permission').requestId, 'always');
    await until(() => out !== null);
    expect(out.behavior).toBe('allow');
    expect(out.updatedPermissions).toBeUndefined();
  });

  it('falls back to a single allow when the engine offers no suggestions (#3)', async () => {
    const { id } = await openChat();
    const p = lastOptions.canUseTool('Read', {}, { signal: new AbortController().signal });
    await until(() => events.some(e => e.kind === 'permission'));
    let out = null;
    p.then(r => { out = r; });
    mgr.answer(id, events.find(e => e.kind === 'permission').requestId, 'always');
    await until(() => out !== null);
    expect(out.behavior).toBe('allow');
    expect(out.updatedPermissions).toBeUndefined();
  });

  it('passes the engine prompt metadata through to the UI (#28)', async () => {
    await openChat();
    lastOptions.canUseTool('Bash', { command: 'rm -rf /etc' }, {
      signal: new AbortController().signal,
      title: 'Claude wants to run a command',
      description: 'Claude will have read and write access to /etc',
      decisionReason: 'outside allowed directories',
      blockedPath: '/etc/passwd',
      displayName: 'Run command',
    });
    await until(() => events.some(e => e.kind === 'permission'));
    const p = events.find(e => e.kind === 'permission');
    expect(p.title).toBe('Claude wants to run a command');
    expect(p.decisionReason).toBe('outside allowed directories');
    expect(p.blockedPath).toBe('/etc/passwd');
  });

  it('clears a pending request when the turn is aborted (#11)', async () => {
    await openChat();
    const ac = new AbortController();
    const p = lastOptions.canUseTool('Bash', { command: 'sleep 100' }, { signal: ac.signal });
    await until(() => events.some(e => e.kind === 'permission'));
    ac.abort();
    let out = null;
    p.then(r => { out = r; });
    await until(() => out !== null);
    expect(out.behavior).toBe('deny');
    expect(out.message).toBe('Interrupted');
    // The UI is told, so no card lingers after an interrupt.
    expect(events.some(e => e.kind === 'permission-cleared' && e.reason === 'interrupted')).toBe(true);
    expect(mgr.pendingPerms.size).toBe(0);
  });

  it('denies and clears every pending request when the chat closes (#20)', async () => {
    const { id } = await openChat();
    const ps = [1, 2, 3].map(() =>
      lastOptions.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal }));
    await until(() => mgr.pendingPerms.size === 3);
    const outs = ps.map(p => p.then(r => r));
    mgr.close(id);
    const results = await Promise.all(outs);
    expect(results.every(r => r.behavior === 'deny')).toBe(true);
    expect(mgr.pendingPerms.size).toBe(0);
    expect(events.filter(e => e.kind === 'permission-cleared').length).toBe(3);
  });

  it('refuses to answer another chat request (#20)', async () => {
    const { id } = await openChat();
    lastOptions.canUseTool('Bash', {}, { signal: new AbortController().signal });
    await until(() => events.some(e => e.kind === 'permission'));
    const rid = events.find(e => e.kind === 'permission').requestId;
    const res = mgr.answer('some-other-chat', rid, 'allow');
    expect(res.ok).toBe(false);
    expect(mgr.pendingPerms.size).toBe(1);
    expect(id).toBeTruthy();
  });

  it('clears the timeout timer when answered', async () => {
    const { id } = await openChat();
    lastOptions.canUseTool('Read', {}, { signal: new AbortController().signal });
    await until(() => events.some(e => e.kind === 'permission'));
    const entry = mgr.pendingPerms.get(events.find(e => e.kind === 'permission').requestId);
    const timer = entry.timer;
    mgr.answer(id, entry.requestId, 'allow');
    expect(entry.timer).toBe(timer);
    expect(mgr.pendingPerms.size).toBe(0);
  });
});

describe('session options', () => {
  it('loads the local settings source so CLI allow-rules apply (#12)', async () => {
    await openChat();
    expect(lastOptions.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('applies a per-provider lean tool allowlist (#41)', async () => {
    await openChat({ settings: { leanTools: ['Read', 'Grep', 'Bash'] } });
    expect(lastOptions.tools).toEqual(['Read', 'Grep', 'Bash']);
    // Lean mode shrinks the base prompt, which is the point.
    expect(lastOptions.disallowedTools).toEqual([]);
  });

  it('leaves the full tool set when lean mode is off', async () => {
    await openChat({ settings: {} });
    expect(lastOptions.tools).toBeUndefined();
  });

  it('sets resumeSessionAt for edit-and-resubmit (#30)', async () => {
    await openChat({ resume: 'sess-abc', resumeAt: 'uuid-123' });
    expect(lastOptions.resume).toBe('sess-abc');
    expect(lastOptions.resumeSessionAt).toBe('uuid-123');
  });

  it('uses the proxy token, never the provider key, for proxied chats (#8)', async () => {
    await openChat({
      anthropicBaseUrl: 'http://127.0.0.1:9999/px/uid',
      providerInstance: { uid: 'uid', apiKey: 'sk-secret-provider-key' },
    });
    expect(lastOptions.env.ANTHROPIC_AUTH_TOKEN).toBe('tok-123');
    expect(lastOptions.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9999/px/uid');
    expect(JSON.stringify(lastOptions.env)).not.toContain('sk-secret-provider-key');
  });
});

describe('control surface', () => {
  it('reports skipped links from a rewind', async () => {
    const { id } = await openChat();
    const r = await mgr.rewind(id, 'a'.repeat(32));
    expect(r.rewound).toBe(true);
    expect(r.skipped).toBe(2);
  });

  it('rejects a malformed checkpoint id', async () => {
    const { id } = await openChat();
    await expect(mgr.rewind(id, '../../etc/passwd')).rejects.toThrow(/invalid checkpoint/);
  });

  it('rejects an invalid session id for transcript replay', () => {
    expect(() => mgr.transcript('/tmp', '../../etc/passwd')).toThrow(/invalid session id/);
  });

  it('tracks permission mode and model switches', async () => {
    const { id } = await openChat();
    await mgr.setMode(id, 'plan');
    expect(ctrl.setPermissionMode).toHaveBeenCalledWith('plan');
    await mgr.setModel(id, 'sonnet');
    expect(ctrl.setModel).toHaveBeenCalledWith('sonnet');
  });
});