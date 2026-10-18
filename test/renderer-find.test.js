// Find-in-transcript bar: Ctrl+F opens it, typing calls the engine's
// window.find, Escape hides. #feat-find
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
let h;
beforeEach(() => {
  h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  } });
});

describe('find in transcript (#feat-find)', () => {
  it('opens, searches via window.find, and reports the match count', async () => {
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    const findCalls = [];
    chat.msgs.textContent = 'alpha beta\nBeta gamma';
    h.window.find = (q, back, caseS, wrap) => { findCalls.push([q, back, caseS, wrap]); return true; };

    h.window.Chat.showFind(chat);
    const bar = chat.pane.querySelector('.chat-find');
    expect(bar && !bar.classList.contains('hidden')).toBe(true);

    const inp = bar.querySelector('input');
    inp.value = 'beta';
    inp.dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(findCalls[0][0]).toBe('beta');
    expect(bar.querySelector('.chat-find-count').textContent).toBe('2 matches');

    // Enter steps to the next match (backwards=false, wrapAround=true)
    inp.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(findCalls[1]).toEqual(['beta', false, false, true]);

    // Escape hides
    inp.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bar.classList.contains('hidden')).toBe(true);
  });
});
