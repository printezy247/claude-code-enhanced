// Turn-lifecycle reliability (0.9.13, #48-#50): the SDK now reports *why* a turn
// ended, *which* tasks are alive, *which* prompts it answered, and where a big
// tool result was spilled. Each of those was previously guessed or ignored.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

async function open(extra = {}) {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
      ...extra,
    },
  });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  // Task frames are routed on their own channel by the main process (chats.js),
  // not through the generic message channel.
  const task = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'task', msg });
  return { h, chat, send, task };
}

describe('background_tasks_changed is a level, not an edge (#48)', () => {
  it('replaces the live set so a dropped edge cannot leave a task spinning', async () => {
    const { chat, task } = await open();
    const sys = (subtype, extra) => task({ type: 'system', subtype, ...extra });

    sys('task_started', { task_id: 't1', description: 'build the thing', is_backgrounded: true });
    sys('task_started', { task_id: 't2', description: 'watch the logs', is_backgrounded: true });
    expect(chat.bgTasks.size).toBe(2);

    // t2 finishes and the level says so, with no task_notification at all.
    sys('background_tasks_changed', { tasks: [{ task_id: 't1', task_type: 'subagent', description: 'build the thing', status: 'running' }] });
    expect(chat.bgTasks.size).toBe(1);
    expect(chat.bgTasks.has('t2')).toBe(false);

    // The card for the finished one is marked done, not left running.
    const cards = [...chat.msgs.querySelectorAll('.bg-task')];
    const done = cards.find(c => c.textContent.includes('watch the logs'));
    expect(done.querySelector('.tool-dot').className).toContain('done');
    expect(done.textContent).toContain('✓');
    // Still-running one keeps its dot.
    const live = cards.find(c => c.textContent.includes('build the thing'));
    expect(live.querySelector('.tool-dot').className).toContain('running');
  });

  it('clears every card when the level goes empty', async () => {
    const { chat, task } = await open();
    const sys = (subtype, extra) => task({ type: 'system', subtype, ...extra });
    sys('task_started', { task_id: 'a', description: 'one', is_backgrounded: true });
    sys('background_tasks_changed', { tasks: [] });
    expect(chat.bgTasks.size).toBe(0);
    for (const c of chat.msgs.querySelectorAll('.bg-task')) expect(c.querySelector('.tool-dot').className).toContain('done');
  });

  it('labels a task with the subagent type the level carries', async () => {
    const { chat, task } = await open();
    task({
      type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'x', task_type: 'subagent', subagent_type: 'code-reviewer', description: 'review the diff', status: 'running' }],
    });
    const card = chat.msgs.querySelector('.bg-task');
    expect(card.querySelector('.chip').textContent).toBe('code-reviewer');
    expect(card.querySelector('.tool-title').textContent).toContain('review the diff');
  });

  it('does not duplicate a card when both the edge and the level report it', async () => {
    const { chat, task } = await open();
    task({ type: 'system', subtype: 'task_started', task_id: 'dup', description: 'once', is_backgrounded: true });
    task({
      type: 'system', subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'dup', task_type: 'subagent', description: 'once', status: 'running' }],
    });
    expect(chat.bgTasks.size).toBe(1);
    expect(chat.msgs.querySelectorAll('.bg-task').length).toBe(1);
  });
});

describe('terminal_reason classifies a dead turn (#49)', () => {
  it('names the cause instead of dumping the subtype', async () => {
    const { chat, send } = await open();
    send({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      terminal_reason: 'prompt_too_long', result: 'boom',
    });
    const pane = chat.pane.textContent;
    expect(pane).toContain('too long for the model');
    expect(pane).not.toContain('error_during_execution');
  });

  it('each distinct reason gets its own actionable message', async () => {
    const cases = [
      ['budget_exhausted', 'budget cap'],
      ['max_turns', 'turn limit'],
      ['malformed_tool_use_exhausted', 'valid tool call'],
      ['rapid_refill_breaker', 'too many rapid retries'],
    ];
    for (const [reason, needle] of cases) {
      const { chat, send } = await open();
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: reason, result: '' });
      expect(chat.pane.textContent).toContain(needle);
    }
  });

  it('falls back to the old wording for a reason it does not know', async () => {
    const { chat, send } = await open();
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'brand_new_reason', result: 'oops' });
    expect(chat.pane.textContent).toContain('Turn failed');
    expect(chat.pane.textContent).toContain('oops');
  });

  it('a completed turn is not reported as a failure', async () => {
    const { chat, send } = await open();
    send({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'all good' });
    expect(chat.pane.textContent).not.toContain('Turn failed');
  });
});

describe('plugin_errors are surfaced (#49)', () => {
  it('says which plugin failed to load', async () => {
    const { chat, send } = await open();
    send({
      type: 'system', subtype: 'init', model: 'test-model',
      plugin_errors: [
        { plugin: 'my-plugin@marketplace', type: 'dependency-unsatisfied', message: 'needs python3' },
        { plugin: 'inline[2]', type: 'path-not-found', message: 'no such directory' },
      ],
    });
    const pane = chat.pane.textContent;
    expect(pane).toContain('my-plugin@marketplace');
    expect(pane).toContain('needs python3');
    expect(pane).toContain('inline[2]');
  });

  it('a clean init shows nothing', async () => {
    const { chat, send } = await open();
    send({ type: 'system', subtype: 'init', model: 'test-model', plugins: [{ name: 'ok@mp' }] });
    expect(chat.pane.textContent).not.toContain('failed to load');
  });
});

describe('replayed prompts are matched by uuid, not text (#49)', () => {
  const userMsg = (text, uuid) => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });

  it('does not draw the same uuid twice after a reconnect replay', async () => {
    const { chat, send } = await open();
    send(userMsg('do the thing', 'u1'));
    send(userMsg('do the thing', 'u1'));   // engine replays the turn
    expect(chat.msgs.querySelectorAll('.msg.user-msg').length).toBe(1);
  });

  it('two identical prompts with different uuids are both kept', async () => {
    const { chat, send } = await open();
    send(userMsg('again', 'u1'));
    send(userMsg('again', 'u2'));
    const nodes = [...chat.msgs.querySelectorAll('.msg.user-msg')];
    expect(nodes.length).toBe(2);
    expect(nodes.map(n => n.dataset.uuid)).toEqual(['u1', 'u2']);
  });
});

describe('queued turns are visible (#49)', () => {
  it('reports how many messages are still coming', async () => {
    const { chat, send } = await open();
    send({ type: 'result', subtype: 'success', is_error: false, result: 'done', queued_turn_count: 2 });
    expect(chat.pane.textContent).toContain('2 messages queued');
    // One more turn finishes; the note shrinks rather than stacking up.
    send({ type: 'result', subtype: 'success', is_error: false, result: 'done', queued_turn_count: 1 });
    expect(chat.pane.textContent).toContain('1 message queued');
    expect(chat.pane.textContent).not.toContain('2 messages queued');
    send({ type: 'result', subtype: 'success', is_error: false, result: 'done', queued_turn_count: 0 });
    expect(chat.pane.textContent).not.toContain('queued');
  });
});

describe('spilled tool output offers the file (#50)', () => {
  it('detects the engine spill notice and offers to reveal it', async () => {
    const { h, chat, send } = await open();
    const tool = { type: 'tool_use', id: 'sp1', name: 'Bash', input: { command: 'cat big.log' } };
    send({ type: 'assistant', message: { content: [tool] } });
    send({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sp1', content: 'Output too large (73.0KB). Full output saved to: /home/test/.claude/tool-results/abc123.txt\n\npreview…' }] },
    });
    await flush();
    const spill = chat.msgs.querySelector('.tool-spill');
    expect(spill).toBeTruthy();
    expect(spill.textContent).toContain('/home/test/.claude/tool-results/abc123.txt');
    const btn = spill.querySelector('button');
    btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush();
    const call = h.calls.filter(c => c.channel === 'shell:reveal').pop();
    expect(call.payload.path).toBe('/home/test/.claude/tool-results/abc123.txt');
  });

  it('an ordinary short result shows no spill notice', async () => {
    const { chat, send } = await open();
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'sp2', name: 'Bash', input: { command: 'ls' } }] } });
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sp2', content: 'a\nb\nc' }] } });
    await flush();
    expect(chat.msgs.querySelector('.tool-spill')).toBeNull();
  });
});