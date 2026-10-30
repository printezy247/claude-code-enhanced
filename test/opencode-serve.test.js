// OpenCode chats over `opencode serve` (0.9.99): approvals become CCE's
// Allow / Deny card, images reach OpenCode, a session resumes with its
// history, and Stop aborts. Runs against a stand-in server with the real
// message shapes (test/fixtures/fake-opencode-serve.js); the real OpenCode
// 1.19.5 was checked by hand with the same steps.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { OpenCodeChat, toParts, splitModel, withPermissions, toolName } = require('../src/main/opencodechat.js');
const { argsFor } = require('../src/main/enginechat.js');
const ChatManager = require('../src/main/chats.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-opencode-serve.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-oc-'));
// One state file per test: a server from the previous test can still be shutting down.
let stateSeq = 0;
const newState = () => path.join(tmp, 'state-' + (++stateSeq) + '.json');
let STATE = newState();
beforeEach(() => { STATE = newState(); });
const live = [];
afterEach(() => { while (live.length) live.pop().close(); });

function chat({ answer = 'allow', sessionId = null, yolo = false, model = '', env = {} } = {}) {
  const events = []; const asks = []; let thread = null;
  const c = new OpenCodeChat({
    command: FAKE, cwd: tmp, env: { ...process.env, FAKE_OC_STATE: STATE, ...env }, sessionId, yolo, model,
    emit: (e) => events.push(e), ask: async (req) => { asks.push(req); return typeof answer === 'function' ? answer(req) : answer; },
    onThread: (id) => { thread = id; },
  });
  live.push(c);
  return { c, events, asks, get thread() { return thread; } };
}
const msgs = (events) => events.filter((e) => e.kind === 'message').map((e) => e.msg);
const result = (events) => msgs(events).find((m) => m.type === 'result');
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
}

describe('OpenCode helpers', () => {
  it('maps text and images to prompt parts', () => {
    expect(toParts('hi', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'file', mime: 'image/png', filename: 'image.png', url: 'data:image/png;base64,AAA' },
    ]);
  });
  it('splits a model id, empty means the CLI default', () => {
    expect(splitModel('cce/qwen/qwen3-coder')).toEqual({ providerID: 'cce', modelID: 'qwen/qwen3-coder' });
    expect(splitModel('')).toBeNull();
  });
  it('asks for commands and edits unless YOLO, keeping the provider config', () => {
    const cfg = JSON.parse(withPermissions('{"provider":{"cce":{}}}', false));
    expect(cfg.permission).toMatchObject({ bash: 'ask', edit: 'ask' });
    expect(cfg.permissions).toEqual(expect.arrayContaining([
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'edit', resource: '*', effect: 'ask' },
      { action: 'webfetch', resource: '*', effect: 'ask' },
    ]));
    expect(cfg.provider).toEqual({ cce: {} });
    const yoloCfg = JSON.parse(withPermissions('', true));
    expect(yoloCfg.permission).toMatchObject({ bash: 'allow', edit: 'allow' });
    expect(yoloCfg.permissions).toEqual([{ action: '*', resource: '*', effect: 'allow' }]);
  });
  it('names tools the way the chat view does', () => {
    expect(toolName('bash')).toBe('Bash');
    expect(toolName('somecustom')).toBe('somecustom');
  });
});

describe('OpenCode over serve', () => {
  it('asks before a command; Allow runs it', async () => {
    const h = chat({ answer: 'allow' });
    h.c.send('run something');
    await until(() => result(h.events));
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ toolName: 'Bash', input: { command: 'echo hi' } });
    const tr = msgs(h.events).find((m) => m.type === 'user' && m.message.content[0].type === 'tool_result');
    expect(tr.message.content[0]).toMatchObject({ content: 'hi\n', is_error: false });
    expect(msgs(h.events)[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(result(h.events)).toMatchObject({ subtype: 'success', usage: { input_tokens: 12, output_tokens: 3 } });
  });

  it('Deny: the tool does not run and the card result says so', async () => {
    const h = chat({ answer: 'deny' });
    h.c.send('run something');
    await until(() => result(h.events));
    const tr = msgs(h.events).find((m) => m.type === 'user' && m.message.content[0].type === 'tool_result');
    expect(tr.message.content[0]).toMatchObject({ content: 'Denied: the tool was not run.', is_error: true });
  });

  it('sends an image', async () => {
    const h = chat();
    h.c.send('look', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }]);
    await until(() => result(h.events));
    expect(result(h.events).result).toBe('saw image');
  });

  it('resumes a session and redraws its history', async () => {
    const a = chat();
    a.c.send('first message');
    await until(() => result(a.events));
    const sid = a.thread;
    expect(sid).toBeTruthy();
    a.c.close();
    const b = chat({ sessionId: sid });
    b.c.send('second message');
    await until(() => result(b.events));
    const replayed = msgs(b.events).filter((m) => m.type === 'user' && m.uuid);
    expect(replayed.map((m) => m.message.content[0].text)).toEqual(['first message']);
    expect(result(b.events).result).toMatch(/users 2/);
  });

  it('Stop aborts a turn that never answers', async () => {
    const h = chat();
    h.c.send('hang forever');
    await until(() => h.c.busy && h.c.child);
    await new Promise((r) => setTimeout(r, 300));
    await h.c.interrupt();
    await until(() => !h.c.busy);
    expect(h.events.some((e) => e.kind === 'interrupted')).toBe(true);
    expect(result(h.events).result).toBe('Interrupted');
  });

  const calls = async (c, suffix) => (await (await fetch(c.base + '/_calls', { headers: { authorization: c.auth } })).json())
    .filter((x) => x.path.endsWith(suffix));

  it('lists the login\'s models by provider, OpenCode Go and Zen first, and sets the session model', async () => {
    const h = chat();
    h.c.send('hello');
    await until(() => result(h.events));
    const models = await h.c.models();
    // Disabled and deprecated models are left out.
    expect(models.map((m) => [m.group, m.value])).toEqual([
      ['OpenCode Go', 'opencode-go/kimi'],
      ['OpenCode', 'opencode/zen-free'],
      ['Fake Cloud', 'fake/fake-coder'],
      ['Fake Cloud', 'fake/plain'],
    ]);
    // What the picker caption shows, from OpenCode rather than CCE's catalog.
    expect(models[2]).toMatchObject({ displayName: 'Fake Coder', context: 128000, vision: true, tools: true, reasoning: true, isDefault: true });
    expect(models[3]).toMatchObject({ vision: false, reasoning: false, isDefault: false });
    expect(await h.c.setModel('fake/plain')).toEqual({ model: 'fake/plain' });
    expect((await calls(h.c, '/model')).pop().body).toEqual({ model: { id: 'plain', providerID: 'fake' } });
  });

  it('waits out the empty model list a just-started server answers, without a message sent first', async () => {
    const h = chat({ env: { FAKE_OC_EMPTY_MODELS: '3' } });
    expect((await h.c.models()).length).toBe(4);
    expect(await h.c.effortLevels()).toEqual(['low', 'high']);
  });

  it('a chat started on a model sets it on the session; the prompt still goes through', async () => {
    const h = chat({ model: 'fake/plain' });
    h.c.send('hello');
    await until(() => result(h.events));
    expect(result(h.events).is_error).toBe(false);
    expect((await calls(h.c, '/model'))[0].body).toEqual({ model: { id: 'plain', providerID: 'fake' } });
  });

  it('effort lists the model variants and sets one on the session model', async () => {
    const h = chat();
    h.c.send('hello');
    await until(() => result(h.events));
    expect(await h.c.effortLevels()).toEqual(['low', 'high']);   // the default model
    await h.c.q.applyFlagSettings({ effort: 'high' });
    expect((await calls(h.c, '/model')).pop().body).toEqual({ model: { id: 'fake-coder', providerID: 'fake', variant: 'high' } });
    await h.c.setModel('fake/plain');
    expect(await h.c.effortLevels()).toEqual([]);
  });

  it('plan mode switches the session agent; yolo answers approvals without a card', async () => {
    const h = chat({ answer: 'deny' });
    h.c.send('hello');
    await until(() => result(h.events));
    expect(await h.c.q.setPermissionMode('plan')).toEqual({ permissionMode: 'plan' });
    expect((await calls(h.c, '/agent')).pop().body).toEqual({ agent: 'plan' });
    await h.c.q.setPermissionMode('bypassPermissions');
    expect((await calls(h.c, '/agent')).pop().body).toEqual({ agent: 'build' });
    h.events.length = 0;
    h.c.send('run something');
    await until(() => result(h.events));
    expect(h.asks).toHaveLength(0);
    expect(msgs(h.events).some((m) => m.type === 'user' && JSON.stringify(m).includes('hi\\n'))).toBe(true);
    await expect(h.c.q.setPermissionMode('acceptEdits')).rejects.toThrow(/no acceptEdits mode/);
  });

  it('/compact summarizes the session in place', async () => {
    const h = chat();
    h.c.send('hello');
    await until(() => result(h.events));
    h.events.length = 0;
    expect(h.c.send('/compact')).toEqual({ ok: true });
    await until(() => result(h.events));
    expect(msgs(h.events).some((m) => m.type === 'system' && m.subtype === 'compact_boundary')).toBe(true);
    expect(await calls(h.c, '/compact')).toHaveLength(1);
  });

  it('reports context use against the model window', async () => {
    const h = chat();
    h.c.send('hello');
    await until(() => result(h.events));
    const u = await h.c.q.getContextUsage();
    expect(u).toMatchObject({ totalTokens: 15, maxTokens: 128000 });
    expect(u.percentage).toBeCloseTo(15 / 1280, 5);
  });

  it('the server rejects a request without the password', async () => {
    const h = chat();
    h.c.send('hello');
    await until(() => result(h.events));
    const r = await fetch(h.c.base + '/session');
    expect(r.status).toBe(401);
  });
});

describe('ChatManager wiring', () => {
  it('an OpenCode approval is an ordinary permission card answered with chat:permission-answer', async () => {
    const mgr = new ChatManager({ proxyToken: 't' });
    const events = [];
    mgr.on('event', (cid, e) => events.push(e));
    const created = mgr.createEngine({ engine: 'opencode', command: FAKE, cwd: tmp, env: { ...process.env, FAKE_OC_STATE: STATE } });
    mgr.send(created.id, 'run something');
    await until(() => events.some((e) => e.kind === 'permission'));
    const card = events.find((e) => e.kind === 'permission');
    expect(card.toolName).toBe('Bash');
    expect(mgr.answer(created.id, card.requestId, 'allow')).toEqual({ ok: true });
    await until(() => events.some((e) => e.kind === 'message' && e.msg.type === 'result'));
    mgr.close(created.id);
  });

  it('Antigravity and the exec-based engines pass a resume id as their session', () => {
    expect(argsFor('antigravity', { prompt: 'hi', sessionId: 'conv-1' }).args).toContain('conv-1');
  });
});

describe('Antigravity resume', () => {
  it('reports its conversation id so the next chat can continue it', async () => {
    const { EngineChat } = require('../src/main/enginechat.js');
    const bin = path.join(tmp, 'agy');
    fs.writeFileSync(bin, '#!/bin/sh\n'
      + `echo '{"event":"init","conversation_id":"conv-42","init":{"cwd":"/tmp"}}'\n`
      + `echo '{"event":"step_update","step_update":{"conversation_id":"conv-42","step_type":"agent_response","step_index":1,"state":"DONE","text_delta":"hi"}}'\n`, { mode: 0o755 });
    const seen = []; const events = [];
    const c = new EngineChat({ engine: 'antigravity', command: bin, cwd: tmp, env: process.env, onThread: (id) => seen.push(id), emit: (e) => events.push(e) });
    c.send('hello');
    await until(() => events.some((e) => e.kind === 'status' && e.busy === false));
    expect(seen).toEqual(['conv-42']);
    expect(c.sessionId).toBe('conv-42');
  });
});
