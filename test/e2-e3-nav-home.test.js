// E2: every non-chat view has a way back to Conversations, not only the
// sidebar. E3: the app starts on a blank home page with a folder picker, not
// inside a chat rooted at ~.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const NOW = Date.now();

function boot({ settings = {}, ipc = {} } = {}) {
  return loadRenderer({
    welcome: false,
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test/work', fontSize: 14, scrollback: 1000, autoNudge: false, ...settings }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': (p) => ({ ok: true, id: 'c1', cwd: (p && p.cwd) || '/x', model: '', permissionMode: 'default', provider: null }),
      'chats:index': { ok: true, sessions: [
        { cwd: '/home/test/alpha', sessionId: 'a1', mtime: NOW - 1000, preview: 'a' },
        { cwd: '/home/test/beta', sessionId: 'b1', mtime: NOW - 2000, preview: 'b' },
        { cwd: '/home/test/alpha', sessionId: 'a2', mtime: NOW - 3000, preview: 'a old' },
      ] },
      ...ipc,
    },
  });
}

const creates = (h) => h.calls.filter(c => c.channel === 'chat:create');

describe('E2: a way back to Conversations from every view', () => {
  for (const view of ['usage', 'providers', 'connectors', 'settings']) {
    it(view + ' has a labelled back button that returns to Conversations', async () => {
      const h = boot();
      await flush();
      h.window.switchView(view);
      const back = h.window.document.querySelector('#view-' + view + ' .back-home');
      expect(back, view).toBeTruthy();
      expect(back.getAttribute('aria-label')).toBe('Back to Conversations');
      expect(back.getAttribute('title')).toBeTruthy();
      back.click();
      expect(h.window.document.body.dataset.view).toBe('conversations');
      expect(h.window.document.querySelector('#view-conversations').classList.contains('active')).toBe(true);
    });
  }

  it('connectors shows a breadcrumb under Home', async () => {
    const h = boot();
    await flush();
    const crumb = h.window.document.querySelector('#view-connectors nav.crumbs');
    expect(crumb.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(crumb.textContent.replace(/\s+/g, ' ')).toMatch(/Home.*Connectors/);
  });
});

describe('E3: blank home page on start', () => {
  it('opens no chat on boot and shows the home page', async () => {
    const h = boot();
    await flush(8);
    expect(creates(h)).toHaveLength(0);
    const home = h.window.document.querySelector('#home-blank');
    expect(home).toBeTruthy();
    expect(home.hidden).toBe(false);
  });

  it('lists recent folders once each, newest first', async () => {
    const h = boot();
    await flush(8);
    const rows = [...h.window.document.querySelectorAll('#home-recent .home-folder')].map(b => b.dataset.cwd);
    expect(rows).toEqual(['/home/test/alpha', '/home/test/beta']);
  });

  it('a recent folder starts a chat there and hides the home page', async () => {
    const h = boot();
    await flush(8);
    h.window.document.querySelector('#home-recent .home-folder[data-cwd="/home/test/beta"]').click();
    await flush(8);
    expect(creates(h).map(c => c.payload.cwd)).toEqual(['/home/test/beta']);
    expect(h.window.document.querySelector('#home-blank').hidden).toBe(true);
  });

  it('"Open folder" asks for a folder and starts a chat in it', async () => {
    const h = boot({ ipc: { 'dialog:pickDir': { canceled: false, path: '/home/test/picked' } } });
    await flush(8);
    h.window.document.querySelector('#home-open').click();
    await flush(8);
    expect(creates(h).map(c => c.payload.cwd)).toEqual(['/home/test/picked']);
  });

  it('a cancelled folder pick starts nothing', async () => {
    const h = boot({ ipc: { 'dialog:pickDir': { canceled: true, path: null } } });
    await flush(8);
    h.window.document.querySelector('#home-open').click();
    await flush(8);
    expect(creates(h)).toHaveLength(0);
  });

  it('"New chat here" starts in the default folder', async () => {
    const h = boot();
    await flush(8);
    const here = h.window.document.querySelector('#home-here');
    expect(here.textContent).toContain('work');
    here.click();
    await flush(8);
    expect(creates(h).map(c => c.payload.cwd)).toEqual(['/home/test/work']);
  });

  it('offers resume-latest', async () => {
    const h = boot();
    await flush(8);
    expect(h.window.document.querySelector('#home-resume')).toBeTruthy();
  });

  it('autoOpenWelcomeChat brings back the welcome chat', async () => {
    const h = boot({ settings: { autoOpenWelcomeChat: true } });
    await flush(8);
    expect(creates(h)).toHaveLength(1);
    expect(h.window.document.querySelector('#home-blank').hidden).toBe(true);
  });
});
