// @vitest-environment jsdom
// Phase 4.2: side sessions (/btw, side chat, scheduled prompts) fail closed:
// a permission request is denied, and leftovers are collected when the window goes.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

const open = async () => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': (p) => ({ ok: true, id: p && p.btw ? 'k1' : 'c1', cwd: '/work/proj', model: '', permissionMode: (p && p.permissionMode) || 'default', provider: null }),
    'chat:send': { ok: true }, 'chat:close': { ok: true }, 'chat:permission-answer': { ok: true },
  } });
  await flush(4);
  return { h, w: h.window, chat: h.window.Chat.chats.get('c1') };
};

describe('side sessions fail closed', () => {
  it('a permission request from a side session is denied, never shown', async () => {
    const { h, w, chat } = await open();
    chat.composer.value = '/btw edit a file for me';
    chat.send();
    await flush(6);
    w.Chat.handleEvent({ id: 'k1', kind: 'permission', requestId: 'r1', toolName: 'Edit', input: { file_path: '/x' } });
    await flush(4);
    const ans = h.calls.filter((c) => c.channel === 'chat:permission-answer').pop();
    expect(ans.payload).toMatchObject({ id: 'k1', requestId: 'r1', decision: 'deny' });
    expect(chat.permSlot.querySelector('.perm-card')).toBeNull();
  });
  it('a side session still open when the window closes is closed', async () => {
    const { h, w, chat } = await open();
    chat.composer.value = '/btw hold on';
    chat.send();
    await flush(6);
    w.dispatchEvent(new w.Event('beforeunload'));
    expect(h.calls.some((c) => c.channel === 'chat:close' && c.payload.id === 'k1')).toBe(true);
  });
});
