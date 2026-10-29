// Engine chats: Codex, Antigravity and OpenCode driven headless (one CLI run
// per turn) and translated into the Agent SDK message shapes the chat view
// already renders. Fixtures are trimmed from real CLI output.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const enginechat = require('../src/main/enginechat.js');

const lines = (arr) => arr.map((o) => JSON.stringify(o));
function run(engine, input, exit = { code: 0, stderr: '' }) {
  const t = enginechat.createTranslator(engine);
  const out = [];
  for (const l of input) out.push(...t.feed(l));
  out.push(...t.finish(exit));
  return { out, t };
}
const ofType = (out, type) => out.filter((m) => m.type === type);
const blocks = (out, type) => ofType(out, 'assistant').flatMap((m) => m.message.content).filter((b) => b.type === type);

describe('argsFor', () => {
  it('codex: first turn reads the prompt from stdin, sandboxed to the workspace', () => {
    const a = enginechat.argsFor('codex', { prompt: '-rm everything', sessionId: null, yolo: false });
    expect(a.args).toEqual(['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-']);
    expect(a.stdin).toBe('-rm everything');
  });

  it('codex: later turns resume the thread; yolo drops the sandbox; model passes through', () => {
    const a = enginechat.argsFor('codex', { prompt: 'hi', sessionId: 'abc-123', yolo: true, model: 'gpt-5' });
    expect(a.args).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5', 'abc-123', '-']);
  });

  it('antigravity: prompt is attached to -p so a leading dash is not read as a flag', () => {
    const a = enginechat.argsFor('antigravity', { prompt: '-x hi', sessionId: 'conv-1', yolo: true, model: 'm1' });
    expect(a.args).toEqual(['--output-format', 'stream-json', '--conversation', 'conv-1',
      '--dangerously-skip-permissions', '--model', 'm1', '-p=-x hi']);
    expect(a.stdin).toBeNull();
  });

  it('opencode: prompt after --, session and --auto when asked', () => {
    expect(enginechat.argsFor('opencode', { prompt: 'hi' }).args).toEqual(['run', '--format', 'json', '--', 'hi']);
    expect(enginechat.argsFor('opencode', { prompt: 'hi', sessionId: 'ses_1', yolo: true }).args)
      .toEqual(['run', '--format', 'json', '--session', 'ses_1', '--auto', '--', 'hi']);
  });

  it('rejects an unknown engine', () => {
    expect(() => enginechat.argsFor('gemini', { prompt: 'x' })).toThrow(/unknown engine/);
  });
});

describe('codex translator', () => {
  const sample = lines([
    { type: 'thread.started', thread_id: '01a18871-f6d4-7ef1-923a-1ddef61bb2b9' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Exceeded skills context budget.' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/bash -lc 'echo hi'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/bash -lc 'echo hi'", aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 45183, cached_input_tokens: 22400, output_tokens: 39 } },
  ]);

  it('maps a full turn to init, Bash tool card, result, text and a success result', () => {
    const { out, t } = run('codex', sample);
    const init = ofType(out, 'system')[0];
    expect(init.subtype).toBe('init');
    expect(init.session_id).toBe('01a18871-f6d4-7ef1-923a-1ddef61bb2b9');
    expect(t.sessionId).toBe('01a18871-f6d4-7ef1-923a-1ddef61bb2b9');
    const uses = blocks(out, 'tool_use');
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ id: 'item_1', name: 'Bash', input: { command: "/bin/bash -lc 'echo hi'" } });
    const res = ofType(out, 'user')[0].message.content[0];
    expect(res).toMatchObject({ type: 'tool_result', tool_use_id: 'item_1', content: 'hi\n', is_error: false });
    expect(blocks(out, 'text').map((b) => b.text)).toEqual(['done']);
    const result = ofType(out, 'result');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ subtype: 'success', is_error: false, result: 'done' });
    expect(result[0].usage).toMatchObject({ input_tokens: 45183, output_tokens: 39 });
  });

  it('a failed turn ends with an error result carrying the reason', () => {
    const { out } = run('codex', lines([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'error', message: 'stream disconnected' },
      { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } },
    ]), { code: 1, stderr: '' });
    const r = ofType(out, 'result');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ is_error: true });
    expect(r[0].result).toMatch(/401/);
  });

  it('a crash with no result frame still ends the turn, using stderr', () => {
    const { out } = run('codex', ['not json at all'], { code: 2, stderr: 'error: unexpected argument' });
    const r = ofType(out, 'result');
    expect(r).toHaveLength(1);
    expect(r[0].is_error).toBe(true);
    expect(r[0].result).toMatch(/unexpected argument/);
  });

  it('file changes, MCP calls and reasoning get cards too', () => {
    const { out } = run('codex', lines([
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking hard' } },
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: '/p/a.js', kind: 'update' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'github', tool: 'get_me', arguments: { a: 1 }, status: 'failed', error: { message: 'boom' } } },
      { type: 'turn.completed', usage: {} },
    ]));
    expect(blocks(out, 'thinking')[0].thinking).toBe('thinking hard');
    const uses = blocks(out, 'tool_use');
    expect(uses.map((u) => u.name)).toEqual(['Edit', 'mcp__github__get_me']);
    expect(uses[0].input.file_path).toBe('/p/a.js');
    const results = ofType(out, 'user').map((m) => m.message.content[0]);
    expect(results[1]).toMatchObject({ tool_use_id: 'm1', is_error: true, content: 'boom' });
  });
});

describe('antigravity translator', () => {
  it('streams text deltas into one message and reads the conversation id', () => {
    const { out, t } = run('antigravity', lines([
      { event: 'init', conversation_id: 'conv-9', init: { cwd: '/w', tools: ['run_command'] } },
      { event: 'step_update', step_update: { conversation_id: 'conv-9', step_index: 0, state: 'DONE', step_type: 'user_input' } },
      { event: 'step_update', step_update: { conversation_id: 'conv-9', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'do' } },
      { event: 'step_update', step_update: { conversation_id: 'conv-9', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'ne\n' } },
      { event: 'result', result: { conversation_id: 'conv-9', status: 'SUCCESS', response: 'done\n', usage: { input_tokens: 7577, output_tokens: 34 } } },
    ]));
    expect(t.sessionId).toBe('conv-9');
    expect(ofType(out, 'system')[0].session_id).toBe('conv-9');
    expect(blocks(out, 'text').map((b) => b.text)).toEqual(['done\n']);
    expect(ofType(out, 'result')[0]).toMatchObject({ subtype: 'success', is_error: false, usage: { input_tokens: 7577, output_tokens: 34 } });
  });

  it('tool steps become cards; a denied action is explained', () => {
    const { out } = run('antigravity', lines([
      { event: 'init', conversation_id: 'c', init: {} },
      { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } } } },
      { event: 'step_update', step_update: { step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, error: { type: 'TOOL_ERROR', message: 'user denied permission to run command' } } } },
      { event: 'result', result: { status: 'SUCCESS', response: '', usage: {}, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } },
    ]));
    const uses = blocks(out, 'tool_use');
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ name: 'Bash', input: { command: 'echo hi' } });
    const res = ofType(out, 'user')[0].message.content[0];
    expect(res).toMatchObject({ tool_use_id: uses[0].id, is_error: true });
    expect(blocks(out, 'text').map((b) => b.text).join(' ')).toMatch(/YOLO/);
  });

  it('a non-success status is an error result', () => {
    const { out } = run('antigravity', lines([
      { event: 'result', result: { status: 'ERROR', response: '', error: 'quota exhausted' } },
    ]));
    expect(ofType(out, 'result')[0]).toMatchObject({ is_error: true });
    expect(ofType(out, 'result')[0].result).toMatch(/quota/);
  });
});

describe('opencode translator', () => {
  it('maps text, tool calls and step usage', () => {
    const { out, t } = run('opencode', lines([
      { type: 'step_start', sessionID: 'ses_A', part: { type: 'step-start' } },
      { type: 'tool_use', sessionID: 'ses_A', part: { type: 'tool', callID: 'call_1', tool: 'shell', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n' } } },
      { type: 'step_finish', sessionID: 'ses_A', part: { type: 'step-finish', tokens: { input: 100, output: 5 } } },
      { type: 'text', sessionID: 'ses_A', part: { type: 'text', text: 'done' } },
      { type: 'step_finish', sessionID: 'ses_A', part: { type: 'step-finish', tokens: { input: 50, output: 2 } } },
    ]));
    expect(t.sessionId).toBe('ses_A');
    expect(ofType(out, 'system')).toHaveLength(1);
    expect(blocks(out, 'tool_use')[0]).toMatchObject({ id: 'call_1', name: 'Bash', input: { command: 'echo hi' } });
    expect(ofType(out, 'user')[0].message.content[0]).toMatchObject({ tool_use_id: 'call_1', content: 'hi\n', is_error: false });
    expect(blocks(out, 'text').map((b) => b.text)).toEqual(['done']);
    expect(ofType(out, 'result')[0]).toMatchObject({ is_error: false, result: 'done', usage: { input_tokens: 150, output_tokens: 7 } });
  });

  it('an error frame becomes the error result (free limit reached)', () => {
    const { out } = run('opencode', lines([
      { type: 'step_start', sessionID: 'ses_B', part: {} },
      { type: 'error', sessionID: 'ses_B', error: { type: 'provider.free-limit', message: 'Free usage limit reached.' } },
    ]), { code: 1, stderr: '' });
    const r = ofType(out, 'result');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ is_error: true });
    expect(r[0].result).toMatch(/Free usage limit/);
  });
});

describe('EngineChat runner', () => {
  function fakeBin(dir, name, script) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
    return p;
  }
  const waitFor = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('timed out');
  };

  it('runs one process per turn, resumes with the session id, and reports busy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-engchat-'));
    try {
      const log = path.join(dir, 'argv.log');
      const bin = fakeBin(dir, 'opencode',
        `echo "$@" >> ${log}\n` +
        `echo '{"type":"step_start","sessionID":"ses_Z","part":{}}'\n` +
        `echo '{"type":"text","sessionID":"ses_Z","part":{"text":"ok"}}'`);
      const events = [];
      const ec = new enginechat.EngineChat({ engine: 'opencode', command: bin, cwd: dir, env: process.env, emit: (e) => events.push(e) });
      ec.send('first');
      expect(ec.busy).toBe(true);
      await waitFor(() => events.some((e) => e.kind === 'status' && e.busy === false));
      ec.send('second');
      await waitFor(() => events.filter((e) => e.kind === 'status' && e.busy === false).length === 2);
      const argv = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(argv[0]).toBe('run --format json -- first');
      expect(argv[1]).toBe('run --format json --session ses_Z -- second');
      expect(ec.sessionId).toBe('ses_Z');
      const msgs = events.filter((e) => e.kind === 'message').map((e) => e.msg.type);
      expect(msgs.filter((t) => t === 'result')).toHaveLength(2);
      expect(msgs.filter((t) => t === 'system')).toHaveLength(1);   // init once per chat, not per turn
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('queues a message sent while busy and runs it next', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-engchat-'));
    try {
      const log = path.join(dir, 'argv.log');
      const bin = fakeBin(dir, 'opencode', `sleep 0.2\necho "$@" >> ${log}\necho '{"type":"text","sessionID":"s","part":{"text":"ok"}}'`);
      const events = [];
      const ec = new enginechat.EngineChat({ engine: 'opencode', command: bin, cwd: dir, env: process.env, emit: (e) => events.push(e) });
      ec.send('one');
      ec.send('two');
      await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim().split('\n').length === 2);
      expect(fs.readFileSync(log, 'utf8')).toMatch(/one[\s\S]*two/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('interrupt kills the running turn and clears the queue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-engchat-'));
    try {
      const bin = fakeBin(dir, 'agy', 'sleep 30');
      const events = [];
      const ec = new enginechat.EngineChat({ engine: 'antigravity', command: bin, cwd: dir, env: process.env, emit: (e) => events.push(e) });
      ec.send('long');
      ec.send('queued');
      await ec.interrupt();
      await waitFor(() => !ec.busy);
      expect(events.some((e) => e.kind === 'interrupted')).toBe(true);
      expect(events.filter((e) => e.kind === 'message' && e.msg.type === 'result')).toHaveLength(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('images are refused with a clear error instead of being dropped', () => {
    const ec = new enginechat.EngineChat({ engine: 'codex', command: '/bin/true', cwd: os.tmpdir(), env: process.env, emit: () => {} });
    const r = ec.send('', [{ type: 'image', source: {} }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/text only/i);
  });

  it('the stand-in query object answers the chat panels harmlessly', async () => {
    const ec = new enginechat.EngineChat({ engine: 'codex', command: '/bin/true', cwd: os.tmpdir(), env: process.env, emit: () => {} });
    expect(await ec.q.supportedCommands()).toEqual([]);
    expect(await ec.q.supportedModels()).toEqual([]);
    expect(await ec.q.getContextUsage()).toMatchObject({ totalTokens: 0 });
    await expect(ec.q.setModel('x')).rejects.toThrow(/Codex chats/);
  });
});

describe('ChatManager engine chats', () => {
  const ChatManager = require('../src/main/chats.js');

  it('createEngine registers a chat that send/interrupt/close/context reach', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-engmgr-'));
    try {
      const bin = path.join(dir, 'codex');
      fs.writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\n'
        + `echo '{"type":"thread.started","thread_id":"th-1"}'\n`
        + `echo '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hey"}}'\n`
        + `echo '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}'\n`, { mode: 0o755 });
      const mgr = new ChatManager({});
      const events = [];
      mgr.on('event', (id, e) => events.push({ id, ...e }));
      const created = mgr.createEngine({ engine: 'codex', command: bin, cwd: dir, env: process.env });
      expect(created).toMatchObject({ engine: 'codex', cwd: dir, model: 'Codex · CLI default' });
      expect(mgr.chats.get(created.id).engine).toBe('codex');
      expect(mgr.send(created.id, 'hello')).toMatchObject({ ok: true });
      const end = Date.now() + 4000;
      while (!events.some((e) => e.kind === 'status' && e.busy === false) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(events.every((e) => e.id === created.id)).toBe(true);
      expect(events.find((e) => e.kind === 'message' && e.msg.type === 'assistant').msg.message.content[0].text).toBe('hey');
      expect(mgr.chats.get(created.id).sessionId).toBe('th-1');
      expect(mgr.chats.get(created.id).busy).toBe(false);
      expect(await mgr.commands(created.id)).toEqual([]);
      const ctx = await mgr.context(created.id);
      expect(ctx.totalTokens).toBe(3);
      await mgr.interrupt(created.id);   // idle: no throw
      mgr.close(created.id);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
