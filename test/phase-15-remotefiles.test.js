// @vitest-environment jsdom
// Files tab of a chat that runs on another machine: browse folders, read a file, show the git diff.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

const open = async () => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'window:state': { ok: true, state: {} },
    'chat:create': { ok: true, id: 'c1', cwd: '/srv/app', model: '', permissionMode: 'default', provider: null, ssh: { id: 'h1', label: 'box', host: 'box.local' } },
    'ssh:ls': (p) => (p.path === '/srv/app'
      ? { ok: true, entries: [{ name: 'src', dir: true }, { name: 'README.md', dir: false }], truncated: false }
      : { ok: true, entries: [{ name: 'main.js', dir: false }], truncated: false }),
    'ssh:read': { ok: true, text: 'hello <b>world</b>', truncated: false },
    'ssh:diff': { ok: true, text: '+added line\n-removed line', truncated: false },
  } });
  await flush(6);
  const w = h.window;
  w.openSplitTab('files');
  await flush(6);
  return { h, w, body: w.document.querySelector('#split-body') };
};

describe('remote Files tab', () => {
  it('lists the remote folder, folders first, and goes into one', async () => {
    const { h, w, body } = await open();
    expect(h.calls.filter((c) => c.channel === 'ssh:ls')[0].payload).toEqual({ hostId: 'h1', path: '/srv/app' });
    const rows = [...body.querySelectorAll('.remote-row')].map((r) => r.textContent);
    expect(rows[0]).toContain('src');
    body.querySelector('.remote-row.dir').click();
    await flush(6);
    expect(h.calls.filter((c) => c.channel === 'ssh:ls').pop().payload.path).toBe('/srv/app/src');
    expect(body.querySelector('.remote-row').textContent).toContain('main.js');
  });
  it('shows a file as text, never as markup', async () => {
    const { w, body } = await open();
    [...body.querySelectorAll('.remote-row')].find((r) => r.textContent.includes('README.md')).click();
    await flush(6);
    const view = body.querySelector('.remote-view');
    expect(view.textContent).toBe('hello <b>world</b>');
    expect(view.querySelector('b')).toBeNull();
  });
  it('shows the git diff of the folder', async () => {
    const { h, body } = await open();
    body.querySelector('.remote-diff').click();
    await flush(6);
    expect(h.calls.filter((c) => c.channel === 'ssh:diff').pop().payload).toEqual({ hostId: 'h1', path: '/srv/app' });
    expect(body.querySelector('.remote-view').textContent).toContain('+added line');
  });
  it('goes up one folder', async () => {
    const { h, body } = await open();
    body.querySelector('.remote-row.dir').click();
    await flush(6);
    body.querySelector('.remote-up').click();
    await flush(6);
    expect(h.calls.filter((c) => c.channel === 'ssh:ls').pop().payload.path).toBe('/srv/app');
  });
});
