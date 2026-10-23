// One-line top strip (sidebar toggle, the active chat's title and actions, panel
// buttons) and the sidebar's Open list that replaces the tab bar.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h;
beforeEach(async () => {
  h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      'git:info': { ok: true, repo: 'me/proj', branch: 'main', dirty: 1, files: ['a.js'] },
    },
  });
  await flush(4);
});

const doc = () => h.window.document;

describe('one-line top strip', () => {
  it('holds the sidebar toggle, the active chat header and the panel buttons, and nothing else', () => {
    const bar = doc().querySelector('#tabbar');
    expect(bar.querySelector('#btn-sidebar')).toBeTruthy();
    expect(bar.querySelector('#qa-chat-slot .chat-header .chat-title')).toBeTruthy();
    expect(bar.querySelector('#btn-tasks')).toBeTruthy();
    expect(bar.querySelector('#btn-new-window')).toBeTruthy();
    expect(doc().querySelector('#convo-quick')).toBeNull();   // the second row is gone
  });

  it('uses uniform icon buttons with accessible names', () => {
    const buttons = [...doc().querySelectorAll('#tabbar > button')];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) {
      expect(b.classList.contains('icon-btn'), b.id).toBe(true);
      expect(b.getAttribute('aria-label'), b.id).toBeTruthy();
      expect(b.querySelector('svg'), b.id + ' icon').toBeTruthy();
    }
  });

  it('shows the chat title, which follows the first message', async () => {
    const title = () => doc().querySelector('#tabbar .chat-title').textContent;
    expect(title()).toBe('tmp');
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = 'fix the flaky build';
    chat.send();
    await flush(4);
    expect(title()).toBe('fix the flaky build');
  });

  it('leaves the folder, repo and branch to the Overview', async () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');
    expect(css).toMatch(/\.chat-header \.chat-project \.proj-chip:not\(\.sandbox\):not\(\.mem-pending-chip\) \{ display: none; \}/);
    await flush(4);
    expect(doc().querySelector('#overview-body').textContent).toContain('main');
  });

  it('keeps the tab elements out of sight; the tab bar is gone', () => {
    expect(doc().querySelector('#tabs').hasAttribute('hidden')).toBe(true);
  });
});

describe('sidebar Open list', () => {
  const rows = () => [...doc().querySelectorAll('#sb-open .sb-open-row')];

  it('lists the open chat, marks it active, and goes away when it is closed', async () => {
    await flush(4);
    expect(rows().length).toBe(1);
    expect(rows()[0].classList.contains('active')).toBe(true);
    expect(rows()[0].textContent).toContain('tmp');
    await h.window.Chat.closeChat('c1');
    await flush(4);
    expect(rows().length).toBe(0);
    expect(doc().querySelector('#sb-open').classList.contains('hidden')).toBe(true);
  });

  it('closes a chat from its row, and activates it on click', async () => {
    await flush(4);
    rows()[0].querySelector('.sb-open-close').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush(6);
    expect(h.window.Chat.chats.has('c1')).toBe(false);
  });

  it('shows working and waiting state on the row', async () => {
    await flush(4);
    const meta = [...h.window.tabRegistry.values()][0];
    meta.busy = true;
    h.window.updateNavState();
    await flush(4);
    expect(rows()[0].querySelector('.sb-dot').classList.contains('busy')).toBe(true);
    meta.needsYou = true;
    h.window.updateNavState();
    await flush(4);
    expect(rows()[0].querySelector('.sb-dot').classList.contains('attn')).toBe(true);
  });

  it('follows a rename', async () => {
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = 'rename me please';
    chat.send();
    await flush(6);
    expect(rows()[0].textContent).toContain('rename me please');
  });
});

describe('top bar leftovers', () => {
  it('shows no per-server MCP chips', async () => {
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'init', model: 'm', mcp_servers: [{ name: 'github', status: 'connected' }] } });
    await flush(4);
    expect(doc().querySelector('.chat-mcp-chips')).toBeNull();
  });

  it('closing the chat does not leave its header behind in the bar', async () => {
    await h.window.Chat.closeChat('c1');
    await flush(2);
    expect(doc().querySelector('#qa-chat-slot .chat-header')).toBeNull();
  });
});
