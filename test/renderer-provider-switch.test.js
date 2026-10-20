// Provider toggle in the chat's model dropdown: the dropdown gains a
// "switch provider" group, and picking another provider re-keys the tab onto
// the recreated engine session. #feat-provider-toggle
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const P1 = { uid: 'p1', name: 'Provider One', presetId: 'a', baseUrl: '', models: [], model: '' };
const P2 = { uid: 'p2', name: 'Provider Two', presetId: 'b', baseUrl: 'https://two.example', models: [], model: 'm2' };

const ipcFor = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [P1, P2], defaultUid: 'p1' },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: P1 },
  ...extra,
});

let h;
beforeEach(() => { h = null; });

describe('provider toggle in the model dropdown (#feat-provider-toggle)', () => {
  it('lists every saved provider as a switch option', async () => {
    h = loadRenderer({ ipc: ipcFor() });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    // The chat was created before providers:all resolved; re-picking the
    // current provider rebuilds the dropdown from the now-loaded list.
    chat.modelSel.value = '__prov:p1';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush();
    const vals = [...chat.modelSel.options].map(o => o.value);
    expect(vals).toContain('__prov:p1');
    expect(vals).toContain('__prov:p2');
  });

  it('re-keys the tab onto the new chat id after switching', async () => {
    h = loadRenderer({
      ipc: ipcFor({
        'chat:set-provider': () => ({
          ok: true, id: 'c9',
          provider: { ...P2, display: 'Provider Two', authKind: 'api-key' },
          model: 'm2', permissionMode: 'acceptEdits',
        }),
      }),
    });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    chat.modelSel.value = '__prov:p2';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(6);
    expect(h.window.Chat.chats.has('c1')).toBe(false);
    expect(h.window.Chat.chats.get('c9')).toBe(chat);
    expect(chat.id).toBe('c9');
    expect(chat.provider.uid).toBe('p2');
    expect(chat.model).toBe('m2');
    expect(chat.alive).toBe(true);
    expect(h.window.tabRegistry.has('c9')).toBe(true);
    expect(h.window.tabRegistry.has('c1')).toBe(false);
    // The new session's models arrive in the same dropdown.
    const calls = h.calls.filter(c => c.channel === 'provider:listModels');
    expect(calls.some(c => c.payload.uid === 'p2')).toBe(true);
  });

  it('keeps the tab on the old chat when the switch fails', async () => {
    h = loadRenderer({
      ipc: ipcFor({ 'chat:set-provider': () => ({ ok: false, error: 'nope' }) }),
    });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    chat.modelSel.value = '__prov:p2';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(6);
    expect(h.window.Chat.chats.get('c1')).toBe(chat);
    expect(chat.provider.uid).toBe('p1');
  });
});

describe('tab lifecycle after a provider switch (stale-closure fix)', () => {
  /** Run the rekey flow and return the surviving chat object. */
  async function switched() {
    h = loadRenderer({
      ipc: ipcFor({
        'chat:set-provider': () => ({
          ok: true, id: 'c9',
          provider: { ...P2, display: 'Provider Two', authKind: 'api-key' },
          model: 'm2', permissionMode: 'acceptEdits',
        }),
      }),
    });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    chat.modelSel.value = '__prov:p2';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(6);
    expect(chat.id).toBe('c9');
    return chat;
  }

  it('tab click activates the chat after a provider switch', async () => {
    const chat = await switched();
    // Deactivate first so the click has work to do.
    chat.pane.classList.remove('active');
    chat.tabEl.classList.remove('active');
    h.window.tabRegistry.get('c9').tabEl.click();
    expect(chat.pane.classList.contains('active')).toBe(true);
  });

  it('close button removes the chat after a provider switch', async () => {
    const chat = await switched();
    h.window.tabRegistry.get('c9').tabEl.querySelector('.close').click();
    await flush();
    expect(h.window.Chat.chats.has('c9')).toBe(false);
    expect(chat.pane.isConnected).toBe(false);
    expect(chat.tabEl.isConnected).toBe(false);
  });

  it('events for the pre-switch id are ignored after rekey', async () => {
    const chat = await switched();
    const before = chat.pane.querySelectorAll('.msg, .tool-card').length;
    expect(() => h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'late frame' }] } },
    })).not.toThrow();
    await flush();
    expect(chat.pane.querySelectorAll('.msg, .tool-card').length).toBe(before);
  });
});
