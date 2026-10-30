// Phase 4.7: @-mention a web address. It goes into the message as text
// (@https://…); the engine's own fetch tool reads it. The preview is plain text.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { urlMention } from '../src/renderer/chat/mentions.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

describe('urlMention', () => {
  it.each([
    ['https://example.com/docs?a=1', 'https://example.com/docs?a=1'],
    ['http://localhost:3000/x', 'http://localhost:3000/x'],
  ])('accepts %s', (q, out) => expect(urlMention(q)).toBe(out));
  it.each(['', 'file.js', 'ftp://x.com', 'javascript:alert(1)', 'https://', 'https://bad host/', 'data:text/html,hi', 'https://x.com/a b'])
    ('refuses %s', (q) => expect(urlMention(q)).toBe(null));
  it('refuses an address with credentials', () => expect(urlMention('https://user:pw@x.com/')).toBe(null));
});

const open = async () => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    'project:files': { ok: true, files: ['a.js'] },
  } });
  await flush(4);
  return { h, w: h.window, chat: h.window.Chat.chats.get('c1') };
};

describe('in the composer', () => {
  it('typing @https://… offers the address, and picking it inserts it as text', async () => {
    const { w, chat } = await open();
    chat.composer.value = 'read @https://example.com/guide';
    chat.composer.setSelectionRange(chat.composer.value.length, chat.composer.value.length);
    chat.composer.dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush(6);
    const items = [...chat.pane.querySelectorAll('.at-item')].map((n) => n.textContent.trim());
    expect(items[0]).toContain('https://example.com/guide');
    chat.composer.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush(4);
    expect(chat.composer.value).toBe('read @https://example.com/guide ');
  });
  it('the preview says the engine will fetch it and never uses innerHTML for the address', async () => {
    const { w, chat } = await open();
    chat.composer.value = '@https://example.com/<img src=x onerror=1>';
    chat.composer.setSelectionRange(chat.composer.value.length, chat.composer.value.length);
    chat.composer.dispatchEvent(new w.Event('input', { bubbles: true }));
    await flush(6);
    expect(chat.pane.querySelector('.at-item')).toBeNull();   // not a valid address, so not offered
    expect(chat.pane.querySelector('img')).toBeNull();
  });
});
