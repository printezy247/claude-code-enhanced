// Codex chats over `codex app-server` (0.9.98): approvals become CCE's
// Allow / Deny card, images reach Codex, a thread resumes with its history,
// and Stop interrupts. Runs against a stand-in server with the real protocol
// shapes (test/fixtures/fake-codex-appserver.js); the real Codex 0.165 was
// checked by hand with the same steps.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CodexChat, toUserInput } = require('../src/main/codexchat.js');
const ChatManager = require('../src/main/chats.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-codex-appserver.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-codex-'));
const STATE = path.join(tmp, 'state.json');
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
    await until(() => events.some((e) => e.kind === 'permission'));
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
