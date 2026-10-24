// The footbar's searchable model + provider picker (1.1) and the switch guards.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const P1 = { uid: 'p1', name: 'Provider One', presetId: 'a', baseUrl: 'https://one.example', models: ['m1', 'm1b'], model: 'm1' };
const P2 = { uid: 'p2', name: 'Provider Two', presetId: 'b', baseUrl: 'https://two.example', models: [], model: 'm2' };
const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [P1, P2], defaultUid: 'p1' },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: 'm1', permissionMode: 'acceptEdits', provider: P1 },
  ...extra,
});

async function boot(extra) {
  const h = loadRenderer({ ipc: ipc(extra) });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  // Rebuild once providers:all has loaded, as a real switch would.
  const o = h.window.document.createElement('option');
  o.value = '__prov:p1'; chat.modelSel.appendChild(o);
  chat.modelSel.value = '__prov:p1';
  chat.modelSel.dispatchEvent(new h.window.Event('change'));
  await flush();
  return { h, chat };
}

describe('model picker', () => {
  it('shows the current model on a button and keeps the select hidden', async () => {
    const { chat } = await boot();
    expect(chat.modelBtn.textContent).toContain('m1');
    expect(chat.modelSel.classList.contains('hidden')).toBe(true);
  });

  it('opens a searchable list; typing filters it and picking switches the model', async () => {
    const { h, chat } = await boot();
    chat.modelBtn.click();
    const doc = h.window.document;
    expect(doc.querySelector('.model-pop')).toBeTruthy();
    const q = doc.querySelector('.model-q');
    q.value = 'm1b';
    q.dispatchEvent(new h.window.Event('input'));
    const rows = [...doc.querySelectorAll('.model-row')];
    expect(rows).toHaveLength(1);
    rows[0].click();
    await flush(6);
    expect(doc.querySelector('.model-pop')).toBeNull();
    expect(h.calls.find((c) => c.channel === 'chat:set-model').payload).toEqual({ id: 'c1', model: 'm1b' });
  });

  it('can reach another provider\'s models from the same list', async () => {
    const { h, chat } = await boot();
    chat.modelBtn.click();
    const q = h.window.document.querySelector('.model-q');
    q.value = 'provider two';
    q.dispatchEvent(new h.window.Event('input'));
    expect(h.window.document.querySelectorAll('.model-row').length).toBe(1);
  });

  it('cancels a switch to a model that cannot read the images already in the chat', async () => {
    const { h, chat } = await boot({ 'chat:model-info': { ok: true, model: 'm1b', context: 0, vision: false, tools: null, reasoning: null, maxOutput: 0 } });
    chat.sentImages = true;
    h.window.confirm = () => false;
    chat.modelSel.value = 'm1b';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(6);
    expect(h.calls.some((c) => c.channel === 'chat:set-model')).toBe(false);
  });

  it('offers to compact first when the chat would not fit the new model', async () => {
    const { h, chat } = await boot({ 'chat:model-info': { ok: true, model: 'm1b', context: 50000, vision: null, tools: null, reasoning: null, maxOutput: 0 } });
    chat.ctxUsage = { totalTokens: 120000 };
    const asked = [];
    h.window.confirm = (m) => { asked.push(m); return false; };
    chat.modelSel.value = 'm1b';
    chat.modelSel.dispatchEvent(new h.window.Event('change'));
    await flush(6);
    expect(asked[0]).toMatch(/compact/i);
    expect(h.calls.some((c) => c.channel === 'chat:set-model')).toBe(false);
  });
});
