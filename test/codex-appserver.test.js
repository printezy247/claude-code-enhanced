// Codex chats over `codex app-server` (0.9.98): approvals become CCE's
// Allow / Deny card, images reach Codex, a thread resumes with its history,
// and Stop interrupts. Runs against a stand-in server with the real protocol
// shapes (test/fixtures/fake-codex-appserver.js); the real Codex 0.165 was
// checked by hand with the same steps.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CodexChat, toUserInput } = require('../src/main/codexchat.js');
const ChatManager = require('../src/main/chats.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-codex-appserver.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-codex-'));
// One state file per test: a server from the previous test can still be shutting down.
let stateSeq = 0;
const newState = () => path.join(tmp, 'state-' + (++stateSeq) + '.json');
let STATE = newState();
beforeEach(() => { STATE = newState(); });
const live = [];
afterEach(() => { while (live.length) live.pop().close(); });

function chat({ answer = 'allow', sessionId = null } = {}) {
  const events = []; const asks = []; let thread = null;
  const c = new CodexChat({
    command: FAKE, cwd: tmp, env: { ...process.env, FAKE_CODEX_STATE: STATE }, sessionId,
    emit: (e) => events.push(e), ask: async (req) => { asks.push(req); return typeof answer === 'function' ? answer(req) : answer; },
    onThread: (id) => { thread = id; },
  });
  live.push(c);
  return { c, events, asks, get thread() { return thread; } };
}
const msgs = (events) => events.filter((e) => e.kind === 'message').map((e) => e.msg);
const result = (events) => msgs(events).find((m) => m.type === 'result');
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
}

describe('Codex over app-server', () => {
  it('maps text and base64 images to app-server input', () => {
    expect(toUserInput('hi', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }])).toEqual([
      { type: 'text', text: 'hi', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AAA' },
    ]);
  });

  it('asks before a command; Allow runs it', async () => {
    const h = chat({ answer: 'allow' });
    h.c.send('run something');
    await until(() => result(h.events));
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ toolName: 'Bash', input: { command: "/bin/bash -lc 'echo hi'" } });
    const tr = msgs(h.events).find((m) => m.type === 'user' && m.message.content[0].type === 'tool_result');
    expect(tr.message.content[0]).toMatchObject({ content: 'hi\n', is_error: false });
    expect(result(h.events)).toMatchObject({ subtype: 'success' });
    expect(msgs(h.events)[0]).toMatchObject({ type: 'system', subtype: 'init' });
  });

  it('Deny: the command is not run and the card result says so', async () => {
    const h = chat({ answer: 'deny' });
    h.c.send('run something');
    await until(() => result(h.events));
    const tr = msgs(h.events).find((m) => m.type === 'user' && m.message.content[0].type === 'tool_result');
    expect(tr.message.content[0]).toMatchObject({ content: 'Denied: the command was not run.', is_error: true });
  });

  it('sends an image', async () => {
    const h = chat();
    h.c.send('look', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }]);
    await until(() => result(h.events));
    expect(result(h.events).result).toBe('saw image');
  });

  it('resumes a thread and redraws its history', async () => {
    const a = chat();
    a.c.send('first message');
    await until(() => result(a.events));
    const tid = a.thread;
    expect(tid).toBeTruthy();
    a.c.close();
    const b = chat({ sessionId: tid });
    b.c.send('second message');
    await until(() => result(b.events));
    const replayed = msgs(b.events).filter((m) => m.type === 'user' && m.uuid);
    expect(replayed.map((m) => m.message.content[0].text)).toEqual(['first message']);
    expect(result(b.events).result).toMatch(/history 2/);
  });

  it('Stop interrupts a turn waiting on approval', async () => {
    const h = chat({ answer: () => new Promise(() => {}) });   // never answered
    h.c.send('run something');
    await until(() => h.asks.length === 1);
    await h.c.interrupt();
    await until(() => !h.c.busy);
    expect(h.events.some((e) => e.kind === 'interrupted')).toBe(true);
    expect(result(h.events).result).toBe('Interrupted');
  });
});

describe('ChatManager wiring', () => {
  it('a Codex approval is an ordinary permission card answered with chat:permission-answer', async () => {
    const mgr = new ChatManager({ proxyToken: 't' });
    const events = [];
    mgr.on('event', (cid, e) => events.push(e));
    const created = mgr.createEngine({ engine: 'codex', command: FAKE, cwd: tmp, env: { ...process.env, FAKE_CODEX_STATE: STATE } });
    mgr.send(created.id, 'run something');
    try { await until(() => events.some((e) => e.kind === 'permission')); }
    catch (err) { throw new Error(err.message + ' — events so far: ' + JSON.stringify(events.map((e) => e.kind + (e.msg ? ':' + e.msg.type + ':' + (e.msg.result || e.msg.subtype || '') : '')))); }
    const card = events.find((e) => e.kind === 'permission');
    expect(card.toolName).toBe('Bash');
    expect(card.suggestions.length).toBe(1);   // offers "Allow for this session"
    expect(mgr.answer(created.id, card.requestId, 'always')).toEqual({ ok: true });
    await until(() => events.some((e) => e.kind === 'message' && e.msg.type === 'result'));
    const tr = events.find((e) => e.kind === 'message' && e.msg.type === 'user');
    expect(tr.msg.message.content[0]).toMatchObject({ content: 'hi\n', is_error: false });
    mgr.close(created.id);
  });
});

describe('Codex footbar controls', () => {
  const logFile = () => path.join(tmp, 'turns-' + (++stateSeq) + '.log');
  const turns = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  function withLog() {
    const f = logFile();
    const events = []; const asks = [];
    const c = new CodexChat({
      command: FAKE, cwd: tmp, env: { ...process.env, FAKE_CODEX_STATE: STATE, FAKE_CODEX_LOG: f },
      emit: (e) => events.push(e), ask: async (r) => { asks.push(r); return 'allow'; }, onThread: () => {},
    });
    live.push(c);
    return { c, f, events };
  }

  it('lists the models Codex reports, without the hidden ones', async () => {
    const h = withLog();
    expect((await h.c.q.supportedModels()).map((m) => m.id)).toEqual(['m-fast', 'm-plain']);
  });

  it('offers the effort levels of the chosen model, and none for a model without any', async () => {
    const h = withLog();
    expect(await h.c.effortLevels()).toEqual(['low', 'high']);   // the default model
    await h.c.q.setModel('m-plain');
    expect(await h.c.effortLevels()).toEqual([]);
  });

  it('sends the chosen model, effort and mode with the next turn', async () => {
    const h = withLog();
    await h.c.q.setModel('m-fast');
    await h.c.q.applyFlagSettings({ effort: 'high' });
    await h.c.q.setPermissionMode('plan');
    h.c.send('hello');
    await until(() => result(h.events));
    expect(turns(h.f)[0]).toEqual({ model: 'm-fast', effort: 'high', approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } });
  });

  it('yolo lifts the sandbox and never asks; ask mode keeps the workspace sandbox', async () => {
    const h = withLog();
    h.c.send('one');
    await until(() => result(h.events));
    await h.c.q.setPermissionMode('bypassPermissions');
    h.c.send('two');
    await until(() => msgs(h.events).filter((m) => m.type === 'result').length === 2);
    const [a, b] = turns(h.f);
    expect(a).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite' } });
    expect(b).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    await expect(h.c.q.setPermissionMode('nonsense')).rejects.toThrow(/no nonsense mode/);
  });

  it('/compact summarizes the thread in place and ends with a result', async () => {
    const h = withLog();
    h.c.send('start');
    await until(() => result(h.events));
    const before = msgs(h.events).filter((m) => m.type === 'result').length;
    expect(h.c.send('/compact')).toEqual({ ok: true });
    await until(() => msgs(h.events).filter((m) => m.type === 'result').length === before + 1);
    expect(msgs(h.events).some((m) => m.type === 'system' && m.subtype === 'compact_boundary')).toBe(true);
    expect(h.c.busy).toBe(false);
  });
});
