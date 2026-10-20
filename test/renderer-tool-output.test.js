// @vitest-environment jsdom
// Tool cards show two things the raw engine stream does not carry:
//   1. the live tail of a running background task's output (#feat-live-output)
//   2. the unfiltered text behind a result the engine compacted for the model
//      (#feat-output-filter)
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const ipc = {
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, theme: 'dark' }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  'chats:index': { ok: true, sessions: [] },
  'usage:scan': { ok: true, days: [] },
};

let h;
beforeEach(() => { h = loadRenderer({ ipc }); });

const chat = () => h.window.Chat.chats.get('c1');
const card = () => chat().msgs.querySelector('.tool-card');
const body = () => card().querySelector('.tool-body');

/** A tool_use block: the card the live output and the result attach to. */
const toolUse = (id, name = 'Bash', input = { command: 'npm run build' }) => h.window.Chat.handleEvent({
  id: 'c1', kind: 'message',
  msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
});

/** The terminal tool_result frame. */
const toolResult = (id, content) => h.window.Chat.handleEvent({
  id: 'c1', kind: 'message',
  msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } },
});

/** A live output frame for a running task. */
const live = (id, text, done = false) => h.window.Chat.handleEvent({
  id: 'c1', kind: 'tool-output', toolUseId: id, text, done,
});

/** The unfiltered text of a result the engine compacted for the model. */
const original = (id, text) => h.window.Chat.handleEvent({
  id: 'c1', kind: 'tool-original', toolUseId: id, text,
});

describe('live tool output (#feat-live-output)', () => {
  it('writes the live tail into the card and expands the collapsed body', () => {
    toolUse('tu1');
    expect(body().classList.contains('hidden')).toBe(true);

    live('tu1', 'building...\ndone\n');

    const out = card().querySelector('.tool-output');
    expect(out).toBeTruthy();
    expect(out.textContent).toContain('building...');
    expect(body().classList.contains('hidden')).toBe(false);
  });

  it('buffers a live frame that beats its card and applies it on arrival', () => {
    live('tu2', 'early tail\n');
    expect(chat().pendingLive.get('tu2')).toContain('early tail');

    toolUse('tu2');

    expect(chat().pendingLive.has('tu2')).toBe(false);
    expect(card().querySelector('.tool-output').textContent).toContain('early tail');
  });

  it('ignores a live frame for a chat it does not know', () => {
    expect(() => h.window.Chat.handleEvent({
      id: 'no-such-chat', kind: 'tool-output', toolUseId: 'tu1', text: 'x', done: false,
    })).not.toThrow();
  });

  it('stops auto-expanding the card once the task is done', () => {
    toolUse('tu6');
    live('tu6', 'tail', true);
    // The user collapses the card again after the task finished.
    body().classList.add('hidden');

    live('tu6', 'more tail', false);

    expect(body().classList.contains('hidden')).toBe(true);
  });
});

describe('unfiltered tool output (#feat-output-filter)', () => {
  it('shows the original text, not the text the model was given', () => {
    toolUse('tu4');
    original('tu4', 'FULL OUTPUT LINE 1\nFULL OUTPUT LINE 2');
    toolResult('tu4', 'FULL OUTPUT LINE 1\n[... 418 lines omitted ...]');

    const out = card().querySelector('.tool-output').textContent;
    expect(out).toContain('FULL OUTPUT LINE 2');
    expect(out).not.toContain('omitted');
  });

  it('shows the result text unchanged when nothing was filtered', () => {
    toolUse('tu5');
    toolResult('tu5', 'plain result');

    expect(card().querySelector('.tool-output').textContent).toContain('plain result');
  });

  it('applies the original when it arrives before the card', () => {
    original('tu3', 'ORIGINAL FULL TEXT');
    toolUse('tu3');
    toolResult('tu3', 'COMPACTED');

    expect(card().querySelector('.tool-output').textContent).toContain('ORIGINAL FULL TEXT');
  });

  it('applies the original when it lands between the result and the card', () => {
    toolResult('tu7', 'COMPACTED');
    original('tu7', 'ORIGINAL FULL TEXT');
    toolUse('tu7');

    expect(card().querySelector('.tool-output').textContent).toContain('ORIGINAL FULL TEXT');
  });
});
