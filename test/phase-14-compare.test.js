// @vitest-environment jsdom
// /compare: one prompt, several models, answers side by side.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { parseCompare, MAX_MODELS } from '../src/renderer/chat/comparecmd.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

describe('parseCompare', () => {
  it('reads models and the prompt', () => {
    expect(parseCompare('/compare opus,sonnet explain this bug')).toEqual({ models: ['opus', 'sonnet'], question: 'explain this bug' });
  });
  it('trims, drops repeats and blanks', () => {
    expect(parseCompare('/compare opus,sonnet,opus,,haiku hi').models).toEqual(['opus', 'sonnet', 'haiku']);
  });
  it('needs at least two models and a prompt, and caps the number', () => {
    expect(parseCompare('/compare opus hi').error).toMatch(/two models/);
    expect(parseCompare('/compare opus,sonnet').error).toMatch(/prompt/);
    expect(parseCompare('/compare').error).toMatch(/Use \/compare/);
    expect(parseCompare('/compare a,b,c,d,e,f go').error).toMatch(new RegExp(String(MAX_MODELS)));
  });
});

describe('/compare in a chat', () => {
  it('asks each model in its own read-only session and shows the answers in columns', async () => {
    const created = [];
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': (p) => { const id = 'side' + created.filter((c) => c.btw).length; created.push({ id, ...p }); return p.btw ? { ok: true, id } : { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null }; },
      'chat:send': { ok: true },
      'chat:close': { ok: true },
    } });
    await flush(4);
    const w = h.window;
    const chat = w.Chat.chats.get('c1');
    chat.composer.value = '/compare opus,haiku which is faster, a or b?';
    chat.send();
    await flush(6);
    expect(created.filter((c) => c.btw).map((c) => [c.model, c.permissionMode])).toEqual([['opus', 'plan'], ['haiku', 'plan']]);
    const sends = h.calls.filter((c) => c.channel === 'chat:send');
    expect(sends.map((c) => c.payload.text)).toEqual(['which is faster, a or b?', 'which is faster, a or b?']);
    const reply = (id, text) => h.window.Chat.handleEvent({ id, kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text }] } } });
    reply('side0', 'Opus says A');
    reply('side1', 'Haiku says B');
    for (const id of ['side0', 'side1']) h.window.Chat.handleEvent({ id, kind: 'message', msg: { type: 'result', is_error: false } });
    await flush(6);
    const cols = [...chat.msgs.querySelectorAll('.compare-card .compare-col')];
    expect(cols.map((c) => c.querySelector('.compare-model').textContent)).toEqual(['opus', 'haiku']);
    expect(cols[0].querySelector('.compare-ans').textContent).toBe('Opus says A');
    expect(cols[1].querySelector('.compare-ans').textContent).toBe('Haiku says B');
  });
});
