// The audit could not drive the real app, so this renders it (stub main process),
// opens the new UI and checks every control has a name, plus the colours of the
// styles added in 0.19 to 0.22.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const css = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

const nameOf = (e) => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.title || e.textContent || '').trim();

describe('live UI: every control has a name', () => {
  let h;
  beforeEach(async () => {
    h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      'git:info': { ok: true, repo: 'me/p', branch: 'main', dirty: 1, files: ['a.js'] },
      'chat:context': { ok: true, usage: { totalTokens: 1, maxTokens: 100, percentage: 1 } },
      'chat:mcp': { ok: true, servers: [] },
      'lightpanda:status': { ok: true, ready: true },
      'dictation:status': { ok: true, ready: true },
    } });
    await flush(4);
  });

  it('chat, thumbnails, Sessions card, chat menu and overview', async () => {
    const w = h.window, d = w.document;
    const chat = w.Chat.chats.get('c1');
    chat.pendingImages.push({ media_type: 'image/png', data: 'QUJD' });
    w.Chat.renderImageChips(chat);
    w.__tabs.set('c2', { kind: 'chat', busy: true, needsYou: false, cwd: '/work/other', title: 'Other' });
    w.toggleSplit(true);
    await flush(6);
    d.querySelector('.hdr-more').click();
    await flush(4);
    const bad = [];
    for (const b of d.querySelectorAll('button,[role=button]')) if (!nameOf(b)) bad.push(b.outerHTML.slice(0, 100));
    for (const i of d.querySelectorAll('input:not([type=hidden]),select,textarea')) {
      if (i.getAttribute('aria-hidden') === 'true') continue;
      const ok = i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || i.title || i.placeholder
        || (i.id && d.querySelector('label[for="' + i.id + '"]')) || i.closest('label');
      if (!ok) bad.push(i.outerHTML.slice(0, 100));
    }
    for (const img of d.querySelectorAll('img:not([alt])')) bad.push(img.outerHTML.slice(0, 100));
    expect(bad).toEqual([]);
  });
});

describe('colours of the newer styles', () => {
  it('skip link text uses the on-accent colour, not a fixed black', () => {
    const rule = css.match(/\.skip-link \{[^}]*\}/)[0];
    expect(rule).toMatch(/color:\s*var\(--on-accent\)/);
  });
  it('no style relies on an undefined --err variable', () => {
    expect(css).not.toMatch(/var\(--err\b/);
  });
  it('thumbnail actions do not recolour an icon on a dark overlay', () => {
    expect(css).not.toMatch(/\.img-actions \.img-del:hover \{ color/);
  });
});
