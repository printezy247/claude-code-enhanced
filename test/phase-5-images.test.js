// @vitest-environment jsdom
// Phase 5.4: pasted image bytes never sit in localStorage; they go to the main
// process (0600 files) and are emptied once the message is sent.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const { createDraftStore } = require('../src/main/drafts.js');

describe('draft images', () => {
  it('are written 0600 in a 0700 folder and cleared with an empty save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-drafts-'));
    const store = createDraftStore(path.join(dir, 'd'));
    store.save('k', [{ media_type: 'image/png', data: 'SECRETBYTES' }]);
    const files = fs.readdirSync(path.join(dir, 'd'));
    expect(files.length).toBe(1);
    expect(fs.statSync(path.join(dir, 'd', files[0])).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'd')).mode & 0o777).toBe(0o700);
    store.save('k', []);
    expect(store.load('k')).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('the renderer sends them to main and keeps the bytes out of localStorage', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'draft:images': { ok: true, images: [] }, 'chat:send': { ok: true },
    } });
    await flush(4);
    const w = h.window;
    const chat = w.Chat.chats.get('c1');
    chat.pendingImages.push({ media_type: 'image/png', data: 'SECRETBYTES' });
    chat.composer.value = 'look';
    chat.send();
    await flush(6);
    await new Promise((r) => setTimeout(r, 450));   // the save is debounced by 300 ms
    expect(JSON.stringify(Object.entries(w.localStorage))).not.toContain('SECRETBYTES');
    const saves = h.calls.filter((c) => c.channel === 'draft:images' && c.payload.op === 'save');
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.pop().payload.images).toEqual([]);   // emptied after the send
  });
});
