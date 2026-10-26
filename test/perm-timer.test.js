// Answering a permission card must stop its auto-deny countdown. The timer used
// to run on after "Allow", so every answered card toasted "Permission request
// timed out" when its six minutes ran out, and the pending count dropped twice.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const P1 = { uid: 'p1', name: 'P', presetId: 'a', baseUrl: '', models: [], model: '' };
const ipc = {
  'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
  'providers:all': { ok: true, presets: [], instances: [P1], defaultUid: 'p1' },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: P1 },
  'chat:permission-answer': { ok: true },
};

describe('permission card countdown', () => {
  it('stops when the card is answered: no timeout toast, count stays right', async () => {
    const h = loadRenderer({ ipc });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    const evt = (n) => ({ id: 'c1', kind: 'permission', requestId: 'r' + n, toolName: 'Bash', input: { command: 'ls' }, expiresAt: Date.now() + 3000 });
    h.window.Chat.handleEvent(evt(1));
    h.window.Chat.handleEvent(evt(2));
    expect(chat.permCount).toBe(2);
    const allow = [...chat.permSlot.querySelector('.perm-card').querySelectorAll('button')].find((b) => /Allow once/.test(b.textContent));
    allow.click();
    await flush(6);
    expect(chat.permCount).toBe(1);
    const seen = [];
    const obs = new h.window.MutationObserver(() => seen.push(h.window.document.body.textContent));
    obs.observe(h.window.document.body, { childList: true, subtree: true, characterData: true });
    await new Promise((r) => setTimeout(r, 4200));
    // The card left alone times out once (its own toast); the answered one must not add a second.
    expect(chat.permCount).toBe(0);
    const toasts = h.window.document.body.textContent.match(/Permission request timed out/g) || [];
    expect(toasts.length).toBeLessThanOrEqual(1);
  }, 10000);
});
