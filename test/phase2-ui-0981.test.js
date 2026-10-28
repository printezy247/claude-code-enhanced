// Phase 2 of the CCE review: the conversations list says how to start when
// there is nothing in it yet, and every icon-only button has a name and a
// tooltip (a regression guard for the a11y audit).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

function boot(sessions, welcome = true) {
  return loadRenderer({
    welcome,
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      'chats:index': { ok: true, sessions },
      'dialog:pickDir': { canceled: true, path: null },
    },
  });
}

describe('conversations list, first run', () => {
  it('shows an illustrated empty state with an Open folder button', async () => {
    const h = boot([], false);
    await flush(10);
    const box = h.window.document.querySelector('.convo-empty-illus');
    expect(box).toBeTruthy();
    expect(box.querySelector('svg')).toBeTruthy();
    const btn = box.querySelector('button');
    expect(btn.textContent).toBe('Open folder…');
    btn.click();
    await flush();
    expect(h.calls.some((c) => c.channel === 'dialog:pickDir')).toBe(true);
  });

  it('is not shown once there are stored conversations', async () => {
    const h = boot([{ cwd: '/tmp/a', sessionId: 'a1', mtime: Date.now(), preview: 'x' }], false);
    await flush(10);
    expect(h.window.document.querySelector('.convo-empty-illus')).toBeNull();
  });
});

describe('icon-only buttons', () => {
  it('every button without visible text has an aria-label and a tooltip', async () => {
    const h = boot([]);
    await flush(10);
    for (const v of ['usage', 'providers', 'connectors', 'settings', 'conversations']) h.window.switchView(v);
    await flush(5);
    const bad = [];
    for (const b of h.window.document.querySelectorAll('button, [role=button]')) {
      if ((b.textContent || '').replace(/\s+/g, '')) continue;
      const named = b.getAttribute('aria-label') || b.getAttribute('aria-labelledby');
      if (!named || !b.getAttribute('title')) bad.push(b.outerHTML.slice(0, 120));
    }
    expect(bad).toEqual([]);
  });
});
