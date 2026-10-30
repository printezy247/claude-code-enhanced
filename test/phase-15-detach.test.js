// @vitest-environment jsdom
// Move a chat to its own window: /detach closes it here and opens a window that resumes the same conversation.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');
const base = {
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
  'chat:close': { ok: true },
  'window:detach': { ok: true },
};

describe('a window opened by detach', () => {
  it('resumes the conversation it was given', async () => {
    const h = loadRenderer({ ipc: { ...base, 'app:info': { ...base['app:info'], detach: { sessionId: 'sess-1', cwd: '/work/proj' } } } });
    await flush(8);
    const create = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(create.payload).toMatchObject({ cwd: '/work/proj', resume: 'sess-1' });
  });
  it('does nothing special for an ordinary window', async () => {
    const h = loadRenderer({ ipc: base });
    await flush(8);
    expect(h.calls.some((c) => c.channel === 'chat:create' && c.payload && c.payload.resume)).toBe(false);
  });
});

describe('/detach', () => {
  const open = async () => {
    const h = loadRenderer({ ipc: base });
    await flush(6);
    const chat = h.window.Chat.chats.get('c1') || (await (async () => { await h.window.Chat.createSession({ cwd: '/work/proj' }); await flush(4); return h.window.Chat.chats.get('c1'); })());
    return { h, chat };
  };
  it('closes the chat here, then opens a window for its session', async () => {
    const { h, chat } = await open();
    chat.sessionId = 'sess-9';
    chat.composer.value = '/detach';
    chat.send();
    await flush(8);
    const order = h.calls.map((c) => c.channel).filter((c) => c === 'chat:close' || c === 'window:detach');
    expect(order).toEqual(['chat:close', 'window:detach']);
    expect(h.calls.filter((c) => c.channel === 'window:detach').pop().payload).toEqual({ sessionId: 'sess-9', cwd: '/work/proj' });
  });
  it('refuses while a turn is running, and when there is nothing saved yet', async () => {
    const { h, chat } = await open();
    chat.sessionId = 'sess-9';
    chat.busy = true;
    chat.composer.value = '/detach';
    chat.send();
    await flush(6);
    expect(h.calls.some((c) => c.channel === 'window:detach')).toBe(false);
    chat.busy = false;
    chat.sessionId = null;
    chat.composer.value = '/detach';
    chat.send();
    await flush(6);
    expect(h.calls.some((c) => c.channel === 'window:detach')).toBe(false);
  });
});
