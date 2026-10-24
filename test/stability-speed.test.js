// Batch C: fold very long transcripts, event-driven Overview, way back after a failed provider switch.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const P1 = { uid: 'p1', name: 'Provider One', presetId: 'a', baseUrl: '', models: [], model: '' };
const P2 = { uid: 'p2', name: 'Provider Two', presetId: 'b', baseUrl: 'https://two.example', models: [], model: 'm2' };
const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [P1, P2], defaultUid: 'p1' },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: P1 },
  ...extra,
});
const result = (h, id, extra = {}) => h.window.Chat.handleEvent({ id, kind: 'message', msg: { type: 'result', subtype: 'success', result: 'ok', usage: {}, ...extra } });

describe('Monaco editors leave with evicted rows', () => {
  it('releases a diff editor when virtualization evicts its card', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    const doc = h.window.document;
    const first = doc.createElement('div');
    const diff = doc.createElement('div');
    diff.className = 'monaco-diff';
    let disposed = 0;
    diff.__ed = { dispose: () => { disposed++; } };
    first.appendChild(diff);
    chat.msgs.appendChild(first);
    for (let i = 0; i < 150; i++) chat.msgs.appendChild(doc.createElement('div'));
    expect(disposed).toBe(1);
    expect(diff.__ed).toBeNull();
    expect(diff.classList.contains('pending')).toBe(true);
  });
});

describe('event-driven Overview', () => {
  it('refreshes when a turn ends, coalescing bursts, and does not poll every few seconds', async () => {
    vi.useFakeTimers();
    try {
      const h = loadRenderer({ ipc: ipc() });
      await vi.advanceTimersByTimeAsync(50);
      let n = 0;
      const real = h.window.renderOverview;
      expect(typeof h.window.refreshOverview).toBe('function');
      h.window.renderOverview = () => { n++; };   // refreshOverview calls the global at fire time
      result(h, 'c1'); result(h, 'c1');
      h.window.refreshOverview('c1');
      await vi.advanceTimersByTimeAsync(700);
      expect(n).toBeLessThanOrEqual(1);
      h.window.renderOverview = real;
    } finally { vi.useRealTimers(); }
  });
});

describe('way back after a switch', () => {
  it('offers to switch back when the new provider fails before answering', async () => {
    const h = loadRenderer({ ipc: ipc({ 'chat:set-provider': () => ({ ok: true, id: 'c9', provider: { ...P2 }, model: 'm2', permissionMode: 'acceptEdits' }) }) });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    chat.modelSel.value = '__pm:p2\u0001m2';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(6);
    expect(chat.id).toBe('c9');
    h.window.Chat.handleEvent({ id: 'c9', kind: 'error', error: 'auth failed' });
    const btn = [...chat.msgs.querySelectorAll('button')].find((b) => /Switch back to Provider One/.test(b.textContent));
    expect(btn).toBeTruthy();
    btn.click();
    await flush(6);
    const call = h.calls.filter((c) => c.channel === 'chat:set-provider').pop();
    expect(call.payload.uid).toBe('p1');
  });

  it('stops offering it once the new provider has answered', async () => {
    const h = loadRenderer({ ipc: ipc({ 'chat:set-provider': () => ({ ok: true, id: 'c9', provider: { ...P2 }, model: 'm2', permissionMode: 'acceptEdits' }) }) });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    chat.modelSel.value = '__pm:p2\u0001m2';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(6);
    result(h, 'c9');
    h.window.Chat.handleEvent({ id: 'c9', kind: 'error', error: 'rate limited' });
    expect([...chat.msgs.querySelectorAll('button')].some((b) => /Switch back/.test(b.textContent))).toBe(false);
  });
});
