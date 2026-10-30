// Pasted or attached images show as thumbnails in the composer, with copy,
// save and delete, and a click opens a larger view.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h, chat;
const doc = () => h.window.document;

beforeEach(async () => {
  h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
    'image:copy': { ok: true },
    'image:save': { ok: true, path: '/home/test/Pictures/image.png' },
  } });
  await flush(4);
  chat = h.window.Chat.chats.get('c1');
  chat.pendingImages.push({ media_type: 'image/png', data: 'QUJD' }, { media_type: 'image/jpeg', data: 'REVG' });
  h.window.Chat.renderImageChips(chat);
});

const thumbs = () => [...doc().querySelectorAll('.chat-imgs .img-thumb')];

describe('composer image thumbnails', () => {
  it('shows a real preview per image, inside the allowed data: scheme', () => {
    expect(thumbs().length).toBe(2);
    expect(thumbs()[0].querySelector('img').getAttribute('src')).toBe('data:image/png;base64,QUJD');
    expect(thumbs()[0].querySelector('img').getAttribute('alt')).toMatch(/image 1/i);
  });
  it('copy and save send the image to the main process', async () => {
    thumbs()[1].querySelector('.img-copy').click();
    await flush(4);
    expect(h.calls.find((c) => c.channel === 'image:copy').payload).toEqual({ media_type: 'image/jpeg', data: 'REVG' });
    thumbs()[0].querySelector('.img-save').click();
    await flush(4);
    expect(h.calls.find((c) => c.channel === 'image:save').payload).toEqual({ media_type: 'image/png', data: 'QUJD' });
  });
  it('delete removes that image only', () => {
    thumbs()[0].querySelector('.img-del').click();
    expect(chat.pendingImages.map((i) => i.data)).toEqual(['REVG']);
    expect(thumbs().length).toBe(1);
  });
  it('every button has a name for screen readers', () => {
    for (const b of doc().querySelectorAll('.chat-imgs button')) expect(b.getAttribute('aria-label')).toBeTruthy();
  });
  it('clicking the preview opens a larger view that Escape closes', () => {
    thumbs()[0].querySelector('img').click();
    const box = doc().querySelector('.img-lightbox');
    expect(box).not.toBeNull();
    expect(box.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,QUJD');
    doc().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(doc().querySelector('.img-lightbox')).toBeNull();
  });
  it('no images: the strip is hidden', () => {
    chat.pendingImages.length = 0;
    h.window.Chat.renderImageChips(chat);
    expect(doc().querySelector('.chat-imgs').classList.contains('hidden')).toBe(true);
  });
});

describe('Shift+Enter continues a list in the composer', () => {
  const press = (shift) => chat.composer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true, cancelable: true }));
  it('adds the next bullet and the caret goes after it', () => {
    chat.composer.value = '- first';
    chat.composer.setSelectionRange(7, 7);
    const ev = press(true);
    expect(ev).toBe(false);   // preventDefault was called
    expect(chat.composer.value).toBe('- first\n- ');
    expect(chat.composer.selectionStart).toBe(10);
  });
  it('plain Shift+Enter on a normal line is left alone', () => {
    chat.composer.value = 'hello';
    chat.composer.setSelectionRange(5, 5);
    expect(press(true)).toBe(true);
    expect(chat.composer.value).toBe('hello');
  });
});
