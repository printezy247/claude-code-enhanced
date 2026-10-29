// Harness reliability review (0.9.91): tool ids that repeat across turns, a
// steering message wiping the loop guard mid-turn, real errors hidden because
// their text says "aborted", and connector switching that stops at the first
// failure or gives up on recovery for the rest of a long session.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { uniqueToolId } = require('../src/main/toolcalls.js');
const { aggregateToAnthropic } = require('../src/main/proxy.js');
const ChatManager = require('../src/main/chats.js');

describe('tool ids are unique across turns', () => {
  it('keeps an id seen for the first time', () => {
    const id = 'first-' + Math.random();
    expect(uniqueToolId(id)).toBe(id);
  });

  it('mints a new id when the upstream reuses one', () => {
    const id = 'call_reused_' + Math.random();
    uniqueToolId(id);
    const again = uniqueToolId(id);
    expect(again).not.toBe(id);
    expect(again).toMatch(/^toolu_[a-f0-9]{24}$/);
  });

  it('mints an id when there is none', () => {
    expect(uniqueToolId('')).toMatch(/^toolu_[a-f0-9]{24}$/);
    expect(uniqueToolId(undefined)).toMatch(/^toolu_/);
  });

  it('the same non-streamed reply twice gives two different tool ids', () => {
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
    const reply = () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] }, finish_reason: 'tool_calls' }], usage: {} });
    const a = aggregateToAnthropic(reply(), { model: 'm', tools }).content.find((b) => b.type === 'tool_use');
    const b = aggregateToAnthropic(reply(), { model: 'm', tools }).content.find((b) => b.type === 'tool_use');
    expect(a.id).not.toBe(b.id);
  });

  it('a call with no upstream id gets a unique id, not call_<n>', () => {
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }];
    const reply = () => ({ choices: [{ message: { content: '', tool_calls: [{ type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] }, finish_reason: 'tool_calls' }], usage: {} });
    const a = aggregateToAnthropic(reply(), { model: 'm', tools }).content.find((b) => b.type === 'tool_use');
    const b = aggregateToAnthropic(reply(), { model: 'm', tools }).content.find((b) => b.type === 'tool_use');
    expect(a.id).toMatch(/^toolu_/);
    expect(a.id).not.toBe(b.id);
  });
});

/* ---------------- ChatManager with a fake engine ---------------- */

let frames = [];
let ctrl = null;
const fakeSdk = {
  query: () => {
    ctrl = {
      interrupt: vi.fn(async () => ({ still_queued: [] })),
      mcpServerStatus: vi.fn(async () => []),
      toggleMcpServer: vi.fn(async () => ({})),
      reconnectMcpServer: vi.fn(async () => ({})),
    };
    const gen = (async function* () {
      for (const f of frames) {
        if (f === 'WAIT') await new Promise(() => {});
        else if (f instanceof Error) throw f;
        else yield f;
      }
    })();
    return Object.assign(gen, ctrl);
  },
};

const until = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
};

let mgr;
let events;
beforeEach(() => {
  frames = ['WAIT'];
  ctrl = null;
  mgr = new ChatManager({ proxyToken: 't', sdk: fakeSdk });
  events = [];
  mgr.on('event', (id, evt) => events.push({ id, ...evt }));
});

describe('steering keeps the loop guard', () => {
  it('a message sent while the turn runs does not clear the loop history', async () => {
    const { id } = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {} });
    const chat = mgr.chats.get(id);
    chat.push = () => true;
    const reset = vi.spyOn(chat.guard, 'reset');
    chat.busy = true;
    mgr.send(id, 'also check the README');
    expect(reset).not.toHaveBeenCalled();
  });

  it('a new message on an idle chat still starts a fresh history', async () => {
    const { id } = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {} });
    const chat = mgr.chats.get(id);
    chat.push = () => true;
    const reset = vi.spyOn(chat.guard, 'reset');
    chat.busy = false;
    mgr.send(id, 'next task');
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('engine errors are not hidden by their wording', () => {
  it('an error whose text says "aborted" is shown when the user did not stop the chat', async () => {
    frames = [new Error('The operation was aborted due to timeout')];
    const { id } = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {} });
    expect(await until(() => events.some((e) => e.id === id && e.kind === 'exit'))).toBe(true);
    expect(events.some((e) => e.id === id && e.kind === 'error' && /aborted due to timeout/.test(e.error))).toBe(true);
  });
});

describe('connector switching', () => {
  it('one connector that fails to toggle does not stop the others', async () => {
    const { id } = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: { connectorModes: { global: { a: 'off', b: 'off' } } } });
    ctrl.mcpServerStatus.mockResolvedValue([
      { name: 'a', status: 'connected', tools: [{ name: 'mcp__a__x' }] },
      { name: 'b', status: 'connected', tools: [{ name: 'mcp__b__y' }] },
    ]);
    ctrl.toggleMcpServer.mockImplementation(async (name) => { if (name === 'a') throw new Error('boom'); return {}; });
    const changes = await mgr._connectorTick(id, 'hello');
    expect(ctrl.toggleMcpServer).toHaveBeenCalledWith('b', false);
    expect(changes.map((c) => c.name)).toEqual(['b']);
  });

  it('a connector that fails later in the session is retried again', async () => {
    vi.useFakeTimers();
    try {
      const { id } = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {} });
      const chat = mgr.chats.get(id);
      chat.recoverTimer = null;   // the first recovery round ran out long ago
      ctrl.mcpServerStatus.mockResolvedValue([{ name: 'gh', status: 'failed', tools: [] }]);
      await mgr._connectorTick(id, 'open a PR');
      expect(chat.recoverTimer).toBeTruthy();
      await vi.advanceTimersByTimeAsync(5000);
      expect(ctrl.reconnectMcpServer).toHaveBeenCalledWith('gh');
    } finally { vi.useRealTimers(); }
  });
});
