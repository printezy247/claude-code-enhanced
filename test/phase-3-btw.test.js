// @vitest-environment jsdom
// Phase 3.5: /btw <question> asks a side question in a throwaway read-only
// session while the main turn keeps running. The answer lands as its own card.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { parseBtw } from '../src/renderer/chat/loopgoal.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

describe('parseBtw', () => {
  it('needs a question', () => {
    expect(parseBtw('/btw')).toMatchObject({ error: expect.any(String) });
    expect(parseBtw('/btw   ')).toMatchObject({ error: expect.any(String) });
    expect(parseBtw('/btw what is a monad?')).toEqual({ question: 'what is a monad?' });
  });
});

const open = async () => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': (p) => ({ ok: true, id: p && p.btw ? 'k1' : (p && p.permissionMode === 'plan' ? 'k1' : 'c1'), cwd: '/work/proj', model: '', permissionMode: (p && p.permissionMode) || 'default', provider: null }),
    'chat:send': { ok: true },
    'chat:close': { ok: true },
  } });
  await flush(4);
  return { h, w: h.window, chat: h.window.Chat.chats.get('c1') };
};
const ev = (w, id, msg) => w.Chat.handleEvent({ id, kind: 'message', msg });

describe('/btw in a chat', () => {
  it('asks in a read-only child session, shows the answer as a card, closes the child', async () => {
    const { h, w, chat } = await open();
    chat.busy = true;                                   // the main turn is running
    chat.composer.value = '/btw what does this repo do?';
    chat.send();
    await flush(6);
    const made = h.calls.filter((c) => c.channel === 'chat:create');
    expect(made.length).toBe(2);
    expect(made[1].payload.permissionMode).toBe('plan');
    const sent = h.calls.filter((c) => c.channel === 'chat:send').pop();
    expect(sent.payload).toMatchObject({ id: 'k1', text: 'what does this repo do?' });
    const card = chat.msgs.querySelector('.btw-card');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('what does this repo do?');
    ev(w, 'k1', { type: 'assistant', message: { content: [{ type: 'text', text: 'It is an Electron harness.' }] } });
    ev(w, 'k1', { type: 'result', subtype: 'success', is_error: false, result: 'done', usage: {} });
    await flush(4);
    expect(card.textContent).toContain('It is an Electron harness.');
    expect(h.calls.some((c) => c.channel === 'chat:close' && c.payload.id === 'k1')).toBe(true);
    expect(chat.busy).toBe(true);                       // the main turn was not touched
    expect(h.calls.filter((c) => c.channel === 'chat:send' && c.payload.id === 'c1').length).toBe(0);
  });
  it('shows a failure on the card and still closes the child', async () => {
    const { h, w, chat } = await open();
    chat.composer.value = '/btw hi';
    chat.send();
    await flush(6);
    ev(w, 'k1', { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quota exceeded' });
    await flush(4);
    expect(chat.msgs.querySelector('.btw-card').textContent).toMatch(/quota exceeded|could not answer/i);
    expect(h.calls.some((c) => c.channel === 'chat:close' && c.payload.id === 'k1')).toBe(true);
  });
});
