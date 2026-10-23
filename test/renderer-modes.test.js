// Renderer: the four-mode picker, the stalled-turn nudge, and "raw input" actually showing.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const THIRD_PARTY = { uid: 'p1', name: 'Alibaba', baseUrl: 'https://dashscope.example/v1' };

const ipcFor = ({ provider = null, mode = 'default', settings = {}, extra = {} } = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: provider ? [provider] : [], defaultUid: provider ? provider.uid : null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, ...settings }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: mode, provider },
  ...extra,
});

async function open(opts) {
  const h = loadRenderer({ ipc: ipcFor(opts) });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  return { h, chat, send };
}

const options = (sel) => [...sel.options].map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled }));

describe('permission mode picker', () => {
  it('offers exactly auto, accept edits, plan and yolo', async () => {
    const { chat } = await open();
    expect(options(chat.modeSel).map(o => o.value)).toEqual(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);
    expect(options(chat.modeSel).map(o => o.text)).toEqual(['auto', 'accept edits', 'plan', 'yolo']);
  });

  it('shows a legacy "normal" chat as accept edits', async () => {
    const { chat } = await open({ mode: 'default' });
    expect(chat.mode).toBe('acceptEdits');
    expect(chat.modeSel.value).toBe('acceptEdits');
  });

  it('explains each mode in the tooltip', async () => {
    const { chat } = await open();
    expect(chat.modeSel.title).toMatch(/Safe actions run without asking/);
    expect(chat.modeSel.title).toMatch(/second model/);
    expect(chat.modeSel.title).toMatch(/shell commands/i);
    expect(chat.modeSel.title).toMatch(/Read-only/);
  });

  it('offers auto on a third-party provider (CCE applies its own policy there)', async () => {
    const { chat } = await open({ provider: THIRD_PARTY, mode: 'acceptEdits' });
    const auto = options(chat.modeSel).find(o => o.value === 'auto');
    expect(auto.disabled).toBe(false);
    expect(auto.text).toBe('auto');
  });

  it('shows auto for a third-party chat running CCE\'s auto policy, though the engine reports accept edits', async () => {
    const created = { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', autoPolicy: true, provider: THIRD_PARTY };
    const { chat, send } = await open({ provider: THIRD_PARTY, mode: 'acceptEdits', extra: { 'chat:create': created } });
    expect(chat.mode).toBe('auto');
    expect(chat.modeSel.value).toBe('auto');
    send({ type: 'system', subtype: 'session_state_changed', state: { permission_mode: 'acceptEdits' } });
    expect(chat.mode).toBe('auto');
  });

  it('picking auto on a third-party chat keeps it on auto when the main process answers accept-edits + autoPolicy', async () => {
    const { h, chat } = await open({ provider: THIRD_PARTY, mode: 'acceptEdits', extra: { 'chat:set-mode': { ok: true, permissionMode: 'acceptEdits', autoPolicy: true, changed: false } } });
    chat.modeSel.value = 'auto';
    chat.modeSel.dispatchEvent(new h.window.Event('change'));
    await flush();
    expect(chat.autoPolicy).toBe(true);
    expect(chat.mode).toBe('auto');
    expect(chat.modeSel.value).toBe('auto');
  });

  it('sends the chosen mode and shows what the main process actually applied', async () => {
    const { h, chat } = await open({ extra: { 'chat:set-mode': { ok: true, permissionMode: 'plan', changed: false } } });
    chat.modeSel.value = 'plan';
    chat.modeSel.dispatchEvent(new h.window.Event('change'));
    await flush();
    expect(h.calls.find(c => c.channel === 'chat:set-mode').payload).toEqual({ id: 'c1', mode: 'plan' });
    expect(chat.mode).toBe('plan');
  });

  it('reverts the picker when the main process falls back', async () => {
    const { h, chat } = await open({ extra: { 'chat:set-mode': { ok: true, permissionMode: 'acceptEdits', changed: true } } });
    chat.modeSel.value = 'plan';
    chat.modeSel.dispatchEvent(new h.window.Event('change'));
    await flush();
    expect(chat.mode).toBe('acceptEdits');
    expect(chat.modeSel.value).toBe('acceptEdits');
  });

  it('plan approval offers accept edits and auto on every provider', async () => {
    const approve = async (provider) => {
      const { h, send } = await open({ provider, mode: 'plan' });
      send({ type: 'system', subtype: 'noop' });
      h.window.Chat.handleEvent({
        id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'ExitPlanMode',
        input: { plan: 'do it' }, toolUseID: 't1',
      });
      await flush();
      return [...h.window.document.querySelectorAll('.perm-actions button')].map(b => b.textContent);
    };
    const own = await approve(null);
    expect(own).toContain('✓ approve + accept edits');
    expect(own).toContain('✓ approve + auto');
    const other = await approve(THIRD_PARTY);
    expect(other).toContain('✓ approve + accept edits');
    expect(other).toContain('✓ approve + auto');
  });
});

describe('stalled-turn nudge', () => {
  const NUDGE = /Do that step now/;
  const result = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 3, duration_ms: 1000, usage: {} });
  const sent = (h) => h.calls.filter(c => c.channel === 'chat:send');

  it('re-prompts once when a turn ends on "Let me …" with no tool call', async () => {
    const { h, send } = await open();
    send(result('I understand now. Let me properly set it up by cloning the repo fresh so we can perform the code review.'));
    await flush();
    expect(sent(h)).toHaveLength(1);
    expect(sent(h)[0].payload.text).toMatch(NUDGE);
    expect(h.window.document.querySelector('.chat-msgs').textContent).toMatch(/nudging it to continue/);
  });

  it('does not nudge twice in a row', async () => {
    const { h, send } = await open();
    send(result('Now I will run the tests:'));
    send(result('Now I will run the tests:'));
    await flush();
    expect(sent(h)).toHaveLength(1);
  });

  it('re-arms after a real prompt from the user', async () => {
    const { h, chat, send } = await open();
    send(result('Let me fix that:'));
    await flush();
    chat.composer.value = 'ok go on';
    chat.send();
    send(result('Let me fix that:'));
    await flush();
    expect(sent(h).map(c => c.payload.text).filter(t => NUDGE.test(t))).toHaveLength(2);
  });

  it('leaves finished answers, questions and long reports alone', async () => {
    const { h, send } = await open();
    send(result('All done. The suite is green.'));
    send(result('I can set this up for you. Shall I go ahead?'));
    send(result('Here is what I found. ' + 'x'.repeat(1600) + ' Let me know.'));
    send(result('Summary: the config is unchanged and nothing else needs doing.'));
    await flush();
    expect(sent(h)).toHaveLength(0);
  });

  it('can be switched off in Settings', async () => {
    const { h, send } = await open({ settings: { autoNudge: false } });
    send(result('Let me do the next step:'));
    await flush();
    expect(sent(h)).toHaveLength(0);
  });

  it('does not nudge a failed turn', async () => {
    const { h, send } = await open();
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Let me try again:' });
    await flush();
    expect(sent(h)).toHaveLength(0);
  });

  it('does not nudge while a background task is live', async () => {
    const { h, chat, send } = await open();
    chat.bgTasks.set('t1', { id: 't1', title: 'build' });
    send(result('I will report back when it completes. Let me check the log:'));
    await flush();
    expect(sent(h)).toHaveLength(0);
  });

  it('does not nudge when the result says it is waiting for CI/merge', async () => {
    const { h, send } = await open();
    send(result("I'll merge once the CI goes green. Let me watch the pipeline:"));
    await flush();
    expect(sent(h)).toHaveLength(0);
  });

  it('does not nudge while a permission prompt is open', async () => {
    const { h, chat, send } = await open();
    chat.permCount = 1;
    send(result('Running the migration. Let me apply the SQL:'));
    await flush();
    expect(sent(h)).toHaveLength(0);
  });

  it('still nudges plain next-step text', async () => {
    const { h, send } = await open();
    send(result('I understand now. Let me properly set it up by cloning the repo fresh.'));
    await flush();
    expect(sent(h)).toHaveLength(1);
  });
});

describe('raw input', () => {
  it('shows the tool input as readable text, not an empty box', async () => {
    const { h, send } = await open();
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi', description: 'say hi' } }] } });
    await flush();
    const card = h.window.document.querySelector('.tool-card');
    card.querySelector('.tool-head').click();
    const pre = card.querySelector('.tool-json pre');
    expect(pre.textContent).toContain('"command": "echo hi"');
  });

  it('copes with a tool call that has no input at all', async () => {
    const { h, send } = await open();
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash' }] } });
    await flush();
    const card = h.window.document.querySelector('.tool-card');
    card.querySelector('.tool-head').click();
    expect(card.querySelector('.tool-json pre').textContent).toBe('{}');
  });

  it('is not hidden by the stylesheet (it was display:none for many versions)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
    const rule = css.match(/\.tool-io\s*\{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule[1]).not.toMatch(/display\s*:\s*none/);
  });
});
