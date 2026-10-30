// @vitest-environment jsdom
// Phase 4.4: a side chat branches from one turn into its own small card.
// Read-only, its own engine session, and nothing from it reaches the main thread.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

const open = async () => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': (p) => ({ ok: true, id: p && p.fork ? 'k1' : 'c1', cwd: '/work/proj', model: '', permissionMode: (p && p.permissionMode) || 'default', provider: null }),
    'chat:send': { ok: true }, 'chat:close': { ok: true },
  } });
  await flush(4);
  const w = h.window;
  const chat = w.Chat.chats.get('c1');
  chat.sessionId = 'sess-1';
  w.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'user', uuid: 'u1', message: { content: 'first question' } } });
  return { h, w, chat };
};
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const ev = (w, id, msg) => w.Chat.handleEvent({ id, kind: 'message', msg });

describe('side chat', () => {
  it('opens from a message, branches read-only from that turn, and answers in its own card', async () => {
    const { h, w, chat } = await open();
    const btn = chat.msgs.querySelector('.user-msg .side-open');
    expect(btn).toBeTruthy();
    click(w, btn);
    await flush(6);
    const made = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(made.payload).toMatchObject({ resume: 'sess-1', fork: true, resumeAt: 'u1', permissionMode: 'plan' });
    const card = chat.pane.querySelector('.side-card');
    expect(card).toBeTruthy();
    const input = card.querySelector('.side-input');
    input.value = 'why did you pick that?';
    click(w, card.querySelector('.side-send'));
    await flush(4);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload).toMatchObject({ id: 'k1', text: 'why did you pick that?' });
    ev(w, 'k1', { type: 'assistant', message: { content: [{ type: 'text', text: 'Because it is simplest.' }] } });
    ev(w, 'k1', { type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    await flush(4);
    expect(card.textContent).toContain('Because it is simplest.');
    expect(card.textContent).toContain('why did you pick that?');
    // the main thread got none of it
    expect(chat.msgs.textContent).not.toContain('Because it is simplest.');
    expect(chat.msgs.textContent).not.toContain('why did you pick that?');
  });
  it('a second turn goes to the same side session', async () => {
    const { h, w, chat } = await open();
    click(w, chat.msgs.querySelector('.side-open'));
    await flush(6);
    const card = chat.pane.querySelector('.side-card');
    for (const q of ['one', 'two']) {
      card.querySelector('.side-input').value = q;
      click(w, card.querySelector('.side-send'));
      await flush(4);
      ev(w, 'k1', { type: 'assistant', message: { content: [{ type: 'text', text: 'a-' + q }] } });
      ev(w, 'k1', { type: 'result', subtype: 'success', is_error: false, result: 'ok' });
      await flush(4);
    }
    const sends = h.calls.filter((c) => c.channel === 'chat:send' && c.payload.id === 'k1');
    expect(sends.map((s) => s.payload.text)).toEqual(['one', 'two']);
    expect(h.calls.filter((c) => c.channel === 'chat:create' && c.payload.fork).length).toBe(1);
  });
  it('Close removes the card and the session; closing the chat does too', async () => {
    const { h, w, chat } = await open();
    click(w, chat.msgs.querySelector('.side-open'));
    await flush(6);
    click(w, chat.pane.querySelector('.side-close'));
    await flush(4);
    expect(chat.pane.querySelector('.side-card')).toBeNull();
    expect(h.calls.some((c) => c.channel === 'chat:close' && c.payload.id === 'k1')).toBe(true);
  });
  it('closing the chat closes its side session', async () => {
    const { h, w, chat } = await open();
    click(w, chat.msgs.querySelector('.side-open'));
    await flush(6);
    await w.Chat.closeChat('c1');
    expect(h.calls.some((c) => c.channel === 'chat:close' && c.payload.id === 'k1')).toBe(true);
  });
});
