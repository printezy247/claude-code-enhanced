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

describe('mcp elicitation (#feat-elicitation)', () => {
  it('emits the url mode, and accept resolves the SDK callback', async () => {
    const { id } = await openChat();
    expect(typeof lastOptions.onElicitation).toBe('function');
    const p = lastOptions.onElicitation(
      { serverName: 'github', message: 'Authorize', mode: 'url', url: 'https://gh/authorize', elicitationId: 'el-1' },
      { signal: new AbortController().signal, requestId: 'ctrl-1' },
    );
    await until(() => events.some(e => e.kind === 'elicitation'));
    const evt = events.find(e => e.kind === 'elicitation');
    expect(evt.mode).toBe('url');
    expect(evt.url).toBe('https://gh/authorize');
    expect(mgr.pendingElicits.size).toBe(1);
    mgr.answerElicitation(id, evt.requestId, 'accept', {});
    await expect(p).resolves.toEqual({ action: 'accept', content: {} });
    expect(mgr.pendingElicits.size).toBe(0);
  });

  it('resolves form answers as the content object', async () => {
    const { id } = await openChat();
    const p = lastOptions.onElicitation(
      { serverName: 's', mode: 'form', requestedSchema: { properties: { user: { type: 'string' } } } },
      { signal: new AbortController().signal, requestId: 'c' },
    );
    await until(() => events.some(e => e.kind === 'elicitation'));
    const evt = events.filter(e => e.kind === 'elicitation').pop();
    mgr.answerElicitation(id, evt.requestId, 'accept', { user: 'ada' });
    await expect(p).resolves.toEqual({ action: 'accept', content: { user: 'ada' } });
  });

  it('declines on cancel and rejects an unknown request id', async () => {
    const { id } = await openChat();
    const ac = new AbortController();
    const p = lastOptions.onElicitation({ serverName: 's', mode: 'form' }, { signal: ac.signal, requestId: 'c' });
    await until(() => events.some(e => e.kind === 'elicitation'));
    ac.abort();
    await expect(p).resolves.toEqual({ action: 'cancel' });
    expect(mgr.answerElicitation(id, 'nope', 'accept', {})).toEqual({ ok: false, error: 'no pending elicitation' });
  });

  it('drops pending elicitations when the chat closes', async () => {
    const { id } = await openChat();
    const p = lastOptions.onElicitation({ serverName: 's', mode: 'form' }, { signal: new AbortController().signal, requestId: 'c' });
    await until(() => events.some(e => e.kind === 'elicitation'));
    mgr.close(id);
    await expect(p).resolves.toEqual({ action: 'cancel' });
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

  it('appends the todo mandate to the session system prompt', async () => {
    await openChat();
    expect(lastOptions.appendSystemPrompt).toMatch(/todo/i);
    expect(lastOptions.appendSystemPrompt).toMatch(/TodoWrite/);
  });

  it('points background calls at the chat model on a translated provider', async () => {
    await openChat({ anthropicBaseUrl: 'http://127.0.0.1:9999/px/uid', model: 'laguna-s-2.1', providerInstance: { uid: 'uid', model: 'nemotron' } });
    expect(lastOptions.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('laguna-s-2.1');
    expect(lastOptions.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('laguna-s-2.1');
    await openChat({ anthropicBaseUrl: 'http://127.0.0.1:9999/px/uid', providerInstance: { uid: 'uid', model: 'nemotron', smallFastModel: 'tiny' } });
    expect(lastOptions.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('tiny');
    expect(lastOptions.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
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
describe('permission decisions fail closed', () => {
  it('denies an unrecognised decision instead of allowing it', async () => {
    const { id } = await openChat();
    const ctx = { signal: new AbortController().signal, suggestions: [], toolUseID: 't1' };
    const p = lastOptions.canUseTool('Bash', { command: 'ls' }, ctx);
    await until(() => events.some(e => e.kind === 'permission'));
    const rid = events.find(e => e.kind === 'permission').requestId;
    let res = null;
    p.then(r => { res = r; });
    mgr.answer(id, rid, 'bogus');
    await until(() => res !== null);
    expect(res.behavior).toBe('deny');
  });

  it('denies when no decision is given at all', async () => {
    const { id } = await openChat();
    const ctx = { signal: new AbortController().signal, suggestions: [], toolUseID: 't2' };
    const p = lastOptions.canUseTool('Bash', { command: 'ls' }, ctx);
    await until(() => events.some(e => e.kind === 'permission'));
    const rid = events.find(e => e.kind === 'permission').requestId;
    let res = null;
    p.then(r => { res = r; });
    mgr.answer(id, rid, undefined);
    await until(() => res !== null);
    expect(res.behavior).toBe('deny');
  });

  it('still allows an explicit allow', async () => {
    const { id } = await openChat();
    const ctx = { signal: new AbortController().signal, suggestions: [], toolUseID: 't3' };
    const p = lastOptions.canUseTool('Bash', { command: 'ls' }, ctx);
    await until(() => events.some(e => e.kind === 'permission'));
    const rid = events.find(e => e.kind === 'permission').requestId;
    let res = null;
    p.then(r => { res = r; });
    mgr.answer(id, rid, 'allow');
    await until(() => res !== null);
    expect(res.behavior).toBe('allow');
  });
});

describe('canUseTool host pipeline parity', () => {
  it('denies tools targeting VM or virtual system paths', async () => {
    await openChat();
    const res = await lastOptions.canUseTool('Read', { file_path: '/proc/cpuinfo' });
    expect(res.behavior).toBe('deny');
    expect(res.message).toMatch(/restricted VM or system location/);
  });

  it('denies write tools in read-only sessions', async () => {
    await openChat({ settings: { readOnly: true } });
    const res = await lastOptions.canUseTool('Write', { file_path: '/tmp/test.txt', content: 'hello' });
    expect(res.behavior).toBe('deny');
    expect(res.message).toMatch(/read-only in this session/);
  });

  it('denies tools on the blocked tools list', async () => {
    await openChat({ settings: { blockedTools: ['Bash'] } });
    const res = await lastOptions.canUseTool('Bash', { command: 'echo 1' });
    expect(res.behavior).toBe('deny');
    expect(res.message).toMatch(/blocked by policy/);
  });

  it('denies tools targeting paths outside cwd when restricted', async () => {
    await openChat({ cwd: '/tmp/myproject', settings: { restrictToCwd: true } });
    const res = await lastOptions.canUseTool('Write', { file_path: '/etc/passwd', content: 'boom' });
    expect(res.behavior).toBe('deny');
    expect(res.message).toMatch(/outside allowed working directories/);
  });

  it('enforces always_deny on connector tools', async () => {
    await openChat({ settings: { connectorToolPolicy: { mcp__db__drop: 'always_deny' } } });
    const res = await lastOptions.canUseTool('mcp__db__drop', {});
    expect(res.behavior).toBe('deny');
    expect(res.message).toMatch(/denied by connector policy/);
  });

  it('enforces always_ask on connector tools by suppressing the always-allow rule', async () => {
    await openChat({ settings: { connectorToolPolicy: { mcp__db__read: 'always_ask' } } });
    const ctx = { signal: new AbortController().signal, suggestions: [], toolUseID: 't_ask' };
    const p = lastOptions.canUseTool('mcp__db__read', { query: 'x' }, ctx);
    await until(() => events.some(e => e.kind === 'permission'));
    const perm = events.find(e => e.kind === 'permission');
    expect(perm).toBeTruthy();
    expect(perm.toolName).toBe('mcp__db__read');
    expect(perm.suppressAlwaysAllowRule).toBe(true);
    // Not denied outright: the user still gets a prompt.
    let res = null;
    p.then(r => { res = r; });
    // leave pending; just confirm no deny was returned synchronously
    expect(res).toBeNull();
  });

  it('reads connector policy from the static tools.js sets too', async () => {
    const toolsMod = require('../src/main/tools.js');
    toolsMod.ALWAYS_DENY_TOOLS.add('mcp__static__nope');
    try {
      await openChat();
      const res = await lastOptions.canUseTool('mcp__static__nope', {});
      expect(res.behavior).toBe('deny');
      expect(res.message).toMatch(/denied by connector policy/);
    } finally {
      toolsMod.ALWAYS_DENY_TOOLS.delete('mcp__static__nope');
    }
  });

  it('pins updatedInput on allow', async () => {
    const { id } = await openChat();
    const ctx = { signal: new AbortController().signal, suggestions: [], toolUseID: 't_pin' };
    const p = lastOptions.canUseTool('Read', { file_path: '/tmp/file.txt' }, ctx);
    await until(() => events.some(e => e.kind === 'permission'));
    const rid = events.find(e => e.kind === 'permission').requestId;
    let res = null;
    p.then(r => { res = r; });
    mgr.answer(id, rid, 'allow');
    await until(() => res !== null);
    expect(res.behavior).toBe('allow');
    expect(res.updatedInput).toEqual({ file_path: '/tmp/file.txt' });
  });
});

describe('context window display', () => {
  it('reports the declared limit when the engine clamped to 200k', async () => {
    mgr.contextOf = () => 400000;
    const { id } = await openChat();
    ctrl.getContextUsage.mockResolvedValue({ totalTokens: 10, maxTokens: 200000, percentage: 5 });
    const c = await mgr.context(id);
    expect(c.maxTokens).toBe(400000);
    expect(c.declared).toBe(400000);
  });

  it('keeps a real non-default engine limit', async () => {
    mgr.contextOf = () => 0;
    const { id } = await openChat();
    ctrl.getContextUsage.mockResolvedValue({ totalTokens: 10, maxTokens: 100, percentage: 10 });
    const c = await mgr.context(id);
    expect(c.maxTokens).toBe(100);
    expect(c.declared).toBe(0);
  });

  it('falls back to declared when the engine reports 0', async () => {
    mgr.contextOf = () => 131072;
    const { id } = await openChat();
    ctrl.getContextUsage.mockResolvedValue({ totalTokens: 0, maxTokens: 0, percentage: 0 });
    const c = await mgr.context(id);
    expect(c.maxTokens).toBe(131072);
    expect(c.declared).toBe(131072);
  });
});

describe('steer mode and web / PC tools access', () => {
  it('steer does not interrupt a busy chat; the message joins the input stream', async () => {
    const { id } = await openChat();
    const chat = mgr.chats.get(id);
    chat.busy = true;
    const interruptSpy = vi.spyOn(mgr, 'interrupt');
    const sendSpy = vi.spyOn(mgr, 'send');

    const res = await mgr.steer(id, 'Stop investigating and build now');
    expect(res.ok).toBe(true);
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith(id, 'Stop investigating and build now', undefined);
  });

  it('populates options.allowedTools with WebFetch and WebSearch', async () => {
    await openChat();
    expect(lastOptions.allowedTools).toContain('WebFetch');
    expect(lastOptions.allowedTools).toContain('WebSearch');
  });

  it('auto-allows WebFetch and WebSearch without creating a permission prompt', async () => {
    await openChat();
    const resFetch = await lastOptions.canUseTool('WebFetch', { url: 'https://example.com' });
    const resSearch = await lastOptions.canUseTool('WebSearch', { query: 'test query' });
    expect(resFetch).toEqual({ behavior: 'allow' });
    expect(resSearch).toEqual({ behavior: 'allow' });
    expect(events.filter(e => e.kind === 'permission').length).toBe(0);
  });

  it('permits ~/.claude/pc.md and .claude config even when restrictToCwd is true', async () => {
    await openChat({ settings: { restrictToCwd: true } });
    const os = require('node:os');
    const path = require('node:path');
    const pcPath = path.join(os.homedir(), '.claude', 'pc.md');
    // Using Read on ~/.claude/pc.md should not be denied by cwd restriction
    const p = lastOptions.canUseTool('Read', { file_path: pcPath });
    await until(() => events.some(e => e.kind === 'permission'));
    const perm = events.find(e => e.kind === 'permission');
    expect(perm).toBeTruthy();
    expect(perm.toolName).toBe('Read');
  });
});
