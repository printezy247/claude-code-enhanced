// Preview pane in the split view: URL bar + sandboxed iframe, state persisted.
// #feat-preview-pane
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const boot = () => loadRenderer({ ipc: {
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  'shell:openExternal': { ok: true },
} });

describe('preview pane (#feat-preview-pane)', () => {
  it('renders a URL bar + sandboxed frame and loads the entered URL', async () => {
    const h = boot();
    await flush();
    h.window.toggleSplit(true);
    const kind = h.window.document.querySelector('#split-kind');
    kind.value = 'preview';
    h.window.renderSplit();
    const body = h.window.document.querySelector('#split-body');
    expect(body.classList.contains('preview-body')).toBe(true);
    const frame = body.querySelector('iframe.preview-frame');
    expect(frame).toBeTruthy();
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');

    const url = body.querySelector('.preview-url');
    url.value = 'localhost:4173';
    body.querySelector('.preview-bar button').click();   // "load"
    expect(frame.src).toBe('http://localhost:4173/');
    expect(h.window.localStorage.getItem('cce.previewUrl')).toBe('http://localhost:4173');
  });
});
