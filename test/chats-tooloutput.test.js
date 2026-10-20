// Live shell output in the tool card, and a compacted shell result for the
// model.
//
// The engine does not stream a tool's output: a Bash call ends with one
// tool_result frame. But a shell task the engine knows about can be read
// while it runs (get_task_output returns the tail it wrote so far), and a
// PostToolUse hook can replace the output the model is about to read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ChatManager = require('../src/main/chats.js');

/** Frames the fake engine yields. It waits for more, so a test can push one. */
const queue = [];
let wake = null;
let lastOptions = null;
let getTaskOutputCalls = 0;
let getTaskOutputFails = false;
let taskOutput = { output: 'building...\n', total_bytes: 12, truncated: false };

const fakeSdk = {
  query: ({ options }) => {
    lastOptions = options;
    const ctrl = {
      interrupt: vi.fn(async () => ({ still_queued: [] })),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100, percentage: 10 })),
      getTaskOutput: vi.fn(async () => {
        getTaskOutputCalls++;
        if (getTaskOutputFails) throw new Error('refused: not a shell task');
        return taskOutput;
      }),
    };
    const gen = (async function* () {
      for (;;) {
        if (!queue.length) { await new Promise((r) => { wake = r; }); continue; }
        yield queue.shift();
      }
    })();
    // The real query() returns ONE object that is both the AsyncGenerator and
    // the control interface; mirror that so chats.js can call both.
    return Object.assign(gen, ctrl);
  },
};

function pushFrame(frame) {
  queue.push(frame);
  if (wake) { const w = wake; wake = null; w(); }
}

/** A manager with one chat, and the events it emitted. */
async function boot(settings = {}) {
  const mgr = new ChatManager({ proxyToken: 't', sdk: fakeSdk });
  const events = [];
  mgr.on('event', (id, evt) => events.push({ id, ...evt }));
  const created = await mgr.create({ cwd: '/tmp', providerInstance: null, settings, model: 'm' });
  return { mgr, events, id: created.id };
}

beforeEach(() => {
  queue.length = 0;
  wake = null;
  lastOptions = null;
  getTaskOutputCalls = 0;
  getTaskOutputFails = false;
  taskOutput = { output: 'building...\n', total_bytes: 12, truncated: false };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the shell-output filter', () => {
  it('is installed by default', async () => {
    await boot();
    expect(lastOptions.hooks && lastOptions.hooks.PostToolUse).toBeTruthy();
  });

  it('is left out when the user turns it off', async () => {
    await boot({ outputFilter: 'off' });
    expect(!lastOptions.hooks || !lastOptions.hooks.PostToolUse).toBe(true);
  });

  it('compacts a large shell result for the model and ships the original to the card', async () => {
    const { events } = await boot({ outputFilter: 'on', outputFilterMaxChars: 1000 });
    const hook = lastOptions.hooks.PostToolUse[0].hooks[0];
    const big = 'x'.repeat(5000);
    const out = await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: big, stderr: '' },
      tool_use_id: 'tu1',
    });
    // The model reads the compacted text...
    expect(out.hookSpecificOutput.updatedToolOutput.length).toBeLessThan(big.length);
    expect(out.hookSpecificOutput.updatedToolOutput).toContain('npm test');
    // ...and the card still gets the whole thing.
    const orig = events.find((e) => e.kind === 'tool-original');
    expect(orig).toBeTruthy();
    expect(orig.toolUseId).toBe('tu1');
    expect(orig.text).toContain(big);
  });

  it('leaves a short result alone', async () => {
    const { events } = await boot({ outputFilter: 'on', outputFilterMaxChars: 8000 });
    const hook = lastOptions.hooks.PostToolUse[0].hooks[0];
    const out = await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { stdout: 'hi\n', stderr: '' },
      tool_use_id: 'tu2',
    });
    expect(!out.hookSpecificOutput).toBe(true);
    expect(events.find((e) => e.kind === 'tool-original')).toBeFalsy();
  });

  it('does not touch tools that are not shell commands', async () => {
    await boot({ outputFilter: 'on', outputFilterMaxChars: 1000 });
    const hook = lastOptions.hooks.PostToolUse[0].hooks[0];
    const out = await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/passwd' },
      tool_response: { stdout: 'x'.repeat(5000) },
      tool_use_id: 'tu3',
    });
    expect(!out.hookSpecificOutput).toBe(true);
  });
});

describe('live shell output', () => {
  it('pushes the tail of a running shell task into the card', async () => {
    const { events } = await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk1', tool_use_id: 'tu1', task_type: 'local_bash', description: 'npm test',
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    const live = events.find((e) => e.kind === 'tool-output');
    expect(live).toBeTruthy();
    expect(live.toolUseId).toBe('tu1');
    expect(live.text).toContain('building');
    expect(live.done).toBe(false);
  });

  it('stops asking when the engine refuses the task', async () => {
    getTaskOutputFails = true;
    const { events } = await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk2', tool_use_id: 'tu2', task_type: 'local_bash', description: 'npm test',
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    expect(getTaskOutputCalls).toBeGreaterThan(0);
    const after = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls).toBe(after);   // stopped, not looping on the failure
    expect(events.find((e) => e.kind === 'tool-output')).toBeFalsy();
  });

  it('stops polling once the task ends', async () => {
    const { events } = await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk3', tool_use_id: 'tu3', task_type: 'local_bash', description: 'npm test',
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    expect(getTaskOutputCalls).toBeGreaterThan(0);
    pushFrame({ type: 'system', subtype: 'task_notification', task_id: 'tk3', status: 'completed', output_file: '/tmp/x', summary: 'done' });
    await vi.advanceTimersByTimeAsync(20);
    const after = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls).toBe(after);
    const done = events.find((e) => e.kind === 'tool-output' && e.done === true);
    expect(done).toBeTruthy();
  });

  it('stops polling when the tool result arrives', async () => {
    const { mgr, events } = await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk4', tool_use_id: 'tu4', task_type: 'local_bash', description: 'npm test',
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    expect(getTaskOutputCalls).toBeGreaterThan(0);
    pushFrame({
      type: 'user', uuid: 'u1', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu4', content: 'done' }] },
    });
    await vi.advanceTimersByTimeAsync(20);
    const after = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls).toBe(after);
    expect(events.some((e) => e.kind === 'tool-output')).toBe(true);
  });
});
