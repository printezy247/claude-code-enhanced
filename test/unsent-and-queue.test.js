// A refused send gives the message back; the queue never writes images to disk;
// the preview frame cannot open popups; a provider switch says where the chat goes.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
  'providers:all': { ok: true, presets: [], instances: [{ uid: 'p1', name: 'One' }, { uid: 'p2', name: 'Two', baseUrl: 'https://two.example', model: 'm2' }], defaultUid: 'p1' },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: { uid: 'p1', name: 'One' } },
  ...extra,
});
const img = { media_type: 'image/png', data: 'QUFBQQ==' };

describe('a send the engine refuses', () => {
  it('puts the text and the images back in the composer', async () => {
    const h = loadRenderer({ ipc: ipc({ 'chat:send': { ok: false, error: 'IPC payload too large (9 bytes)' } }) });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = 'look at this';
    chat.pendingImages.push({ ...img });
    chat.send();
    await flush(6);
    expect(chat.composer.value).toBe('look at this');
    expect(chat.pendingImages).toEqual([img]);
    expect(h.window.document.querySelector('.chat-msgs').textContent).toMatch(/Not sent — IPC payload too large.*back in the box/);
  });

  it('also when the call itself throws, and does not overwrite what the user typed since', async () => {
    const h = loadRenderer({ ipc: ipc({ 'chat:send': () => { throw new Error('boom'); } }) });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = 'first';
    chat.send();
    chat.composer.value = 'something new';
    await flush(6);
    expect(chat.composer.value).toBe('something new');
    chat.composer.value = '';
    chat.composer.value = 'again';
    chat.send();
    await flush(6);
    expect(chat.composer.value).toBe('again');   // the failed 'again' came back
  });
});

describe('queued messages', () => {
  it('are remembered as text only, never with their images', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    chat.composer.value = 'after this turn';
    chat.pendingImages.push({ ...img });
    chat.send('queue');
    const stored = h.window.localStorage.getItem('cce:pending:/tmp');
    expect(JSON.parse(stored)).toEqual(['after this turn']);
    expect(stored).not.toContain(img.data);
  });

  it('reads an older object-shaped queue back as text', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush();
    h.window.localStorage.setItem('cce:pending:/tmp', JSON.stringify(['plain', { text: 'with image', blocks: [{ type: 'image' }] }]));
    // a second chat in the same folder restores it on creation
    await h.window.Chat.createSession({ cwd: '/tmp' });
    await flush(4);
    const chat = [...h.window.Chat.chats.values()].pop();
    expect(chat.pendingMsgs).toEqual(['plain', 'with image']);
  });
});

describe('preview frame', () => {
  it('cannot open popups', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush();
    const k = h.window.document.querySelector('#split-kind');
    k.value = 'preview';
    h.window.toggleSplit(true);
    await flush(4);
    const sandbox = h.window.document.querySelector('.preview-frame').getAttribute('sandbox');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-popups');
  });
});

describe('provider switch', () => {
  it('says the conversation now goes to the new provider', async () => {
    const h = loadRenderer({ ipc: ipc({ 'chat:set-provider': { ok: true, id: 'c2', provider: { uid: 'p2', name: 'Two' }, model: 'm2', permissionMode: 'acceptEdits' } }) });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    const o = h.window.document.createElement('option');
    o.value = '__pm:p2\u0001m2'; chat.modelSel.appendChild(o);
    chat.modelSel.value = o.value;
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(8);
    expect(h.window.document.querySelector('#toasts').textContent).toMatch(/this conversation now goes to that provider/);
  });
});
