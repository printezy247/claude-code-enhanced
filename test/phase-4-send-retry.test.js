// Phase 4.8: a refused send says why, keeps the text and images, and can be
// sent again with one click. Same path for every engine.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

const open = async (engine) => {
  let n = 0;
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null, ...(engine ? { engine } : {}) },
    'chat:send': () => (++n === 1 ? { ok: false, error: 'quota exceeded: top up your plan' } : { ok: true }),
  } });
  await flush(4);
  return { h, w: h.window, chat: h.window.Chat.chats.get('c1') };
};

describe.each([[undefined], ['codex'], ['opencode']])('engine %s', (engine) => {
  it('shows the real cause, keeps the text and offers Send again', async () => {
    const { h, w, chat } = await open(engine);
    chat.composer.value = 'do the thing';
    chat.send();
    await flush(6);
    const err = chat.msgs.querySelector('.error-msg');
    expect(err.textContent).toContain('quota exceeded: top up your plan');
    expect(chat.composer.value).toBe('do the thing');
    const btn = err.querySelector('button');
    expect(btn.textContent).toBe('Send again');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(6);
    const sends = h.calls.filter((c) => c.channel === 'chat:send');
    expect(sends.length).toBe(2);
    expect(sends[1].payload.text).toBe('do the thing');
    expect(chat.msgs.querySelector('.error-msg')).toBeNull();
    expect(chat.composer.value).toBe('');
  });
  it('images survive the retry', async () => {
    const { h, w, chat } = await open(engine);
    chat.pendingImages.push({ media_type: 'image/png', data: 'AAAA' });
    chat.composer.value = 'look';
    chat.send();
    await flush(6);
    expect(chat.pendingImages.length).toBe(1);   // back in the tray
    chat.msgs.querySelector('.error-msg button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(6);
    const second = h.calls.filter((c) => c.channel === 'chat:send')[1];
    expect(second.payload.blocks.some((b) => b.type === 'image' && b.source.data === 'AAAA')).toBe(true);
  });
});
