// Batch D (0.13.0), the renderer side of SSH chats. The command, quoting and
// options are in ssh-chat.test.js; lint caching in lint-cache.test.js; memory
// in perf-budget.test.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const HOSTS = [{ id: 'h-1', label: 'build box', host: 'build.example.com', user: 'jack', port: 22, identity: '' }];

async function open(create = {}) {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'sshhosts:list': { ok: true, hosts: HOSTS },
    'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null, ...create },
  } });
  await flush();
  return { h, chat: h.window.Chat.chats.get('c1') };
}
const click = (h, el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

describe('target chip with SSH hosts', () => {
  it('lists the saved hosts next to Local and New worktree', async () => {
    const { h, chat } = await open();
    click(h, chat.targetBtn);
    await flush(4);
    const items = [...chat.pane.querySelectorAll('.target-menu .wf-item b')].map((b) => b.textContent);
    expect(items).toEqual(['Local ✓', 'New worktree', 'SSH · build box']);
    expect(chat.pane.querySelector('.target-menu').textContent).toContain('jack@build.example.com');
  });

  it('choosing a host asks for the remote folder and starts the chat with sshHost', async () => {
    const { h, chat } = await open();
    let asked = '';
    h.window.askText = async (q) => { asked = q; return '/srv/app'; };
    click(h, chat.targetBtn);
    await flush(4);
    const item = [...chat.pane.querySelectorAll('.target-menu .wf-item')].find((b) => b.textContent.includes('SSH'));
    click(h, item);
    await flush(6);
    expect(asked).toContain('build box');
    const call = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(call.payload).toMatchObject({ cwd: '/srv/app', sshHost: 'h-1', permissionMode: 'acceptEdits' });
  });

  it('a remote chat says so: chip, target label, notice, and no worktree entry', async () => {
    const { h, chat } = await open({ cwd: '/srv/app', ssh: { id: 'h-1', label: 'build box', host: 'build.example.com' } });
    expect(chat.targetBtn.querySelector('.tg-label').textContent).toBe('SSH · build box');
    expect(chat.targetBtn.title).toContain('over SSH');
    await flush(6);
    expect(chat.projEl.textContent).toContain('⇄ build box');
    expect(chat.projEl.textContent).toContain('app');             // the remote folder's name
    expect(chat.msgs.textContent).toContain('Remote chat: Claude Code runs on build box');
    click(h, chat.targetBtn);
    await flush(4);
    const items = [...chat.pane.querySelectorAll('.target-menu .wf-item b')].map((b) => b.textContent);
    expect(items).toEqual(['Local', 'SSH · build box ✓']);
  });

  it('from a remote chat, Local starts a local chat without the remote path', async () => {
    const { h, chat } = await open({ cwd: '/srv/app', ssh: { id: 'h-1', label: 'build box', host: 'build.example.com' } });
    h.window.askText = async () => 'ok';
    click(h, chat.targetBtn);
    await flush(4);
    click(h, [...chat.pane.querySelectorAll('.target-menu .wf-item')].find((b) => b.textContent.startsWith('Local')));
    await flush(6);
    const call = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(call.payload.cwd).toBeUndefined();
    expect(call.payload.sshHost).toBeUndefined();
  });
});

describe('chips added next to the project info survive its redraw', () => {
  it('a worktree chip is still there after git:info answers', async () => {
    const { h, chat } = await open({ worktree: { path: '/tmp/wt', branch: 'cce/20261029-ab12', root: '/tmp/wt', top: '/tmp', needsInstall: ['node_modules'] } });
    await flush(6);                       // git:info has answered and redrawn the row
    expect(h.calls.some((c) => c.channel === 'git:info')).toBe(true);
    expect(chat.projEl.textContent).toContain('⌥ cce/20261029-ab12');
    expect(chat.msgs.textContent).toContain('starts without node_modules');
  });
});
