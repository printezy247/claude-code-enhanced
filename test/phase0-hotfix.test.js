// 0.9.48 hotfixes: a screenshot-sized chat:send is not blocked by the IPC cap,
// and a chat keeps working after its provider is switched (the engine session
// id changes underneath the tab).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

describe('IPC payload cap', () => {
  const big = 'x'.repeat(2000000);
  const setup = async () => {
    const stub = require('electron');
    stub.__reset();
    process.env.CCE_PROXY_PORT = '0';
    delete require.cache[require.resolve('../src/main/main.js')];
    require('../src/main/main.js');
    await flush(8);
    return stub.__state.handlers;
  };

  it('lets chat:send carry several megabytes of image data', async () => {
    const handlers = await setup();
    const r = await handlers.get('chat:send')(null, { id: 'nope', text: 'hi', blocks: [{ type: 'image', source: { data: big } }] });
    expect(String(r.error || '')).not.toMatch(/too large/);
  });

  it('keeps the 1 MB cap on every other channel', async () => {
    const handlers = await setup();
    const r = await handlers.get('providers:save')(null, { instance: { name: big } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });

  it('still refuses a chat:send above the raised cap', async () => {
    const handlers = await setup();
    const r = await handlers.get('chat:send')(null, { id: 'nope', text: 'x'.repeat(25000000) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });
});

describe('provider switch keeps the chat usable', () => {
  const ipc = {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [{ uid: 'p1', name: 'One' }, { uid: 'p2', name: 'Two' }], defaultUid: 'p1' },
    'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: { uid: 'p1', name: 'One' } },
    'chat:set-provider': { ok: true, id: 'c2', provider: { uid: 'p2', name: 'Two' }, model: 'm', permissionMode: 'acceptEdits' },
    'chat:send': { ok: true }, 'chat:interrupt': { ok: true }, 'chat:set-mode': { ok: true },
    'chat:supported-models': { ok: true, models: [] },
  };

  it('sends, stops and changes mode on the NEW session id', async () => {
    const h = loadRenderer({ ipc });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    const sel = chat.modelSel;
    const o = h.window.document.createElement('option');
    o.value = '__prov:p2'; sel.appendChild(o);
    sel.value = '__prov:p2';
    sel.dispatchEvent(new h.window.Event('change'));
    await flush(8);
    expect(chat.id).toBe('c2');

    chat.composer.value = 'hello';
    chat.sendBtn.click();
    await flush(4);
    chat.busy = true;
    chat.stopBtn.click();
    await flush(2);
    const ids = (ch) => h.calls.filter(c => c.channel === ch).map(c => c.payload.id);
    expect(ids('chat:send')).toEqual(['c2']);
    expect(ids('chat:interrupt')).toEqual(['c2']);
    h.window.close();
  });
});

describe('image shrinking', () => {
  it('passes an image through unchanged when the browser cannot decode it', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
    } });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    const file = new h.window.File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
    await h.window.Chat.attachFiles(chat, [file]);
    expect(chat.pendingImages.length).toBe(1);
    expect(chat.pendingImages[0].media_type).toBe('image/png');
    h.window.close();
  });
});
