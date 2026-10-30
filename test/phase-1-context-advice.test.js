// Phase 1.2 + 1.4: the Context card shows cache-read tokens and, when the
// window is filling up, a plain "compact soon" hint. Pure functions first.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { contextAdvice, cacheLine, SOON_PCT, NOW_PCT } from '../src/renderer/chat/ctxadvice.js';

describe('contextAdvice', () => {
  it('stays quiet below the soon threshold', () => {
    expect(contextAdvice(0)).toBe(null);
    expect(contextAdvice(SOON_PCT - 1)).toBe(null);
  });
  it('suggests compacting soon, then now', () => {
    expect(contextAdvice(SOON_PCT)).toMatchObject({ level: 'soon' });
    expect(contextAdvice(NOW_PCT - 1)).toMatchObject({ level: 'soon' });
    expect(contextAdvice(NOW_PCT)).toMatchObject({ level: 'now' });
    expect(contextAdvice(100)).toMatchObject({ level: 'now' });
  });
  it('carries readable text', () => {
    expect(contextAdvice(80).text).toMatch(/compact/i);
  });
  it('ignores junk', () => {
    expect(contextAdvice(NaN)).toBe(null);
    expect(contextAdvice(undefined)).toBe(null);
    expect(contextAdvice(-5)).toBe(null);
  });
});

describe('cacheLine', () => {
  it('is empty without cache reads', () => {
    expect(cacheLine(null)).toBe('');
    expect(cacheLine({ input_tokens: 100 })).toBe('');
    expect(cacheLine({ cache_read_input_tokens: 0 })).toBe('');
  });
  it('shows tokens and share of input', () => {
    const s = cacheLine({ input_tokens: 1000, cache_read_input_tokens: 3000 });
    expect(s).toContain('3k');
    expect(s).toContain('75%');
  });
  it('counts cache writes as input too', () => {
    const s = cacheLine({ input_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 });
    expect(s).toContain('50%');
  });
});

describe('Context card placement', () => {
  const require2 = createRequire(import.meta.url);
  const { loadRenderer, flush } = require2('./helpers/renderer.js');
  const mk = (pct) => loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 0, files: [] },
    'chat:context': { ok: true, usage: { totalTokens: pct * 1000, maxTokens: 100000, percentage: pct } },
  } });

  it('shows the advice and the cached line when the window is filling', async () => {
    const h = mk(80);
    await flush(4);
    const chat = h.window.Chat.chats.get('c1');
    chat.lastResult = { usage: { input_tokens: 1000, cache_read_input_tokens: 3000 } };
    h.window.toggleSplit(true);
    await flush(6);
    h.window.renderOverview();
    await flush(6);
    const doc = h.window.document;
    const adv = doc.querySelector('#overview-body .ctx-advice');
    expect(adv.hidden).toBe(false);
    expect(adv.textContent).toMatch(/compact/i);
    expect(doc.querySelector('#overview-body .ctx-cache').textContent).toContain('3k');
  });

  it('stays hidden when there is room', async () => {
    const h = mk(10);
    await flush(4);
    h.window.toggleSplit(true);
    await flush(6);
    expect(h.window.document.querySelector('#overview-body .ctx-advice').hidden).toBe(true);
  });
});
