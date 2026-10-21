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
// False makes the fake engine look like an SDK build that does not expose
// getTaskOutput at all. #F4
let engineHasGetTaskOutput = true;
let streamEnded = false;

const fakeSdk = {
  query: ({ options }) => {
    lastOptions = options;
    const ctrl = {
      interrupt: vi.fn(async () => ({ still_queued: [] })),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100, percentage: 10 })),
    };
    if (engineHasGetTaskOutput) {
      ctrl.getTaskOutput = vi.fn(async () => {
        getTaskOutputCalls++;
        if (getTaskOutputFails) throw new Error('refused: not a shell task');
        return taskOutput;
      });
    }
    const gen = (async function* () {
      for (;;) {
        if (!queue.length) {
          if (streamEnded) return;   // the engine's stream is over
          await new Promise((r) => { wake = r; });
          continue;
        }
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

/** End the engine's message stream, as an engine process exit does. */
function endStream() {
  streamEnded = true;
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
  engineHasGetTaskOutput = true;
  streamEnded = false;
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

  it('clamps the budget it reads out of the settings', async () => {
    await boot({ outputFilter: 'on', outputFilterMaxChars: 999999 });
    const hook = lastOptions.hooks.PostToolUse[0].hooks[0];
    const big = 'x'.repeat(200000);
    const out = await hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: big, stderr: '' },
      tool_use_id: 'tu4',
    });
    // 999999 is out of range (500…100000), so the main process must clamp it
    // before it hands the result to the model.
    expect(out.hookSpecificOutput).toBeTruthy();
    expect(out.hookSpecificOutput.updatedToolOutput.length).toBeLessThanOrEqual(100000);
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

  it('stops the live poll when the user interrupts the chat', async () => {
    // The Stop button: the card must not keep auto-expanding with a stale
    // tail, and the engine must not be polled every 700 ms for a turn the
    // user already ended.
    const { mgr, events, id } = await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk5', tool_use_id: 'tu5', task_type: 'local_bash', description: 'npm test',
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    expect(getTaskOutputCalls).toBeGreaterThan(0);
    await mgr.interrupt(id);
    const after = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls, 'the poll kept running after the interrupt').toBe(after);
    const done = events.find((e) => e.kind === 'tool-output' && e.done === true);
    expect(done, 'the card was never told the live stream ended').toBeTruthy();
    expect(done.toolUseId).toBe('tu5');
  });

  it('stops the live poll when the engine loop ends', async () => {
    // A poll that outlives its chat keeps a timer alive and keeps asking a
    // dead engine for output.
    await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk6', tool_use_id: 'tu6', task_type: 'local_bash', description: 'npm test',
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    expect(getTaskOutputCalls).toBeGreaterThan(0);
    endStream();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    const after = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls, 'the poll kept running after the chat ended').toBe(after);
  });

  it('keeps polling a backgrounded task after its placeholder tool result', async () => {
    // A backgrounded command's tool_result is only a placeholder; the real
    // result arrives later as a task_notification.
    const { events } = await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk7', tool_use_id: 'tu7', task_type: 'local_bash', description: 'npm test',
      is_backgrounded: true,
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    expect(getTaskOutputCalls).toBeGreaterThan(0);
    pushFrame({
      type: 'user', uuid: 'u7', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu7', content: 'Command running in background' }] },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(
      events.some((e) => e.kind === 'tool-output' && e.done === true),
      'the placeholder result ended the live tail of a backgrounded task',
    ).toBe(false);
    const after = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls, 'the poll stopped at the placeholder result').toBeGreaterThan(after);
    // The real result arrives as a task_notification: now the tail ends.
    pushFrame({ type: 'system', subtype: 'task_notification', task_id: 'tk7', status: 'completed', output_file: '/tmp/x', summary: 'done' });
    await vi.advanceTimersByTimeAsync(20);
    const stopped = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls).toBe(stopped);
    expect(events.some((e) => e.kind === 'tool-output' && e.done === true)).toBe(true);
  });

  it('keeps polling a task that moves to the background after it started', async () => {
    // The SDK documents a later move to the background:
    // SDKTaskUpdatedMessage.patch.is_backgrounded. From that moment the
    // tool_result is only a placeholder, so the live tail must keep running
    // until the task_notification ends it. #R2
    const { events } = await boot();
    pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk9', tool_use_id: 'tu9', task_type: 'local_bash', description: 'npm test',
    });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(800);
    expect(getTaskOutputCalls).toBeGreaterThan(0);

    // The task is moved to the background.
    pushFrame({
      type: 'system', subtype: 'task_updated', task_id: 'tk9',
      patch: { is_backgrounded: true },
    });
    await vi.advanceTimersByTimeAsync(20);

    // The placeholder result arrives: it must not end the live tail.
    pushFrame({
      type: 'user', uuid: 'u9', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'Command running in background' }] },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(
      events.some((e) => e.kind === 'tool-output' && e.done === true),
      'the placeholder result ended the live tail of a task moved to the background',
    ).toBe(false);
    const after = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls, 'the poll stopped at the placeholder result').toBeGreaterThan(after);

    // The real result arrives as a task_notification: now the tail ends.
    pushFrame({ type: 'system', subtype: 'task_notification', task_id: 'tk9', status: 'completed', output_file: '/tmp/x', summary: 'done' });
    await vi.advanceTimersByTimeAsync(20);
    const stopped = getTaskOutputCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(getTaskOutputCalls).toBe(stopped);
    expect(events.some((e) => e.kind === 'tool-output' && e.done === true)).toBe(true);
  });

  it('does nothing when the engine has no getTaskOutput', async () => {
    // An SDK build that does not expose the control request: the live tail
    // must fail soft, not throw and not emit a tool-output event.
    engineHasGetTaskOutput = false;
    const { events } = await boot();
    expect(() => pushFrame({
      type: 'system', subtype: 'task_started',
      task_id: 'tk8', tool_use_id: 'tu8', task_type: 'local_bash', description: 'npm test',
    })).not.toThrow();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.find((e) => e.kind === 'tool-output')).toBeFalsy();
    expect(events.find((e) => e.kind === 'error'), 'the frame killed the chat loop').toBeFalsy();
  });

  it('documents the undeclared SDK surface the live tail depends on', () => {
    // getTaskOutput exists at runtime (sdk.mjs sends a get_task_output control
    // request) but is NOT declared on the published Query interface, so a
    // rename upstream would silently kill the feature. The guard must say so.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'main', 'chats.js'), 'utf8');
    const guard = /typeof chat\.q\.getTaskOutput !== 'function'/.exec(src);
    expect(guard, 'the getTaskOutput guard is gone').toBeTruthy();
    const around = src.slice(Math.max(0, guard.index - 900), guard.index);
    expect(around, 'the guard names no upstream surface').toMatch(/get_task_output/);
    expect(around, 'the guard does not say the method is undeclared').toMatch(/not declared|not on the published|undeclared/i);
  });
});
