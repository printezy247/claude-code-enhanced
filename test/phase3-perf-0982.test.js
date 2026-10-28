// Phase 3 of the CCE review: Monaco (4.6 MB) is parsed on every start even
// when no diff or code block is ever shown. It now loads on first use.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const ROOT = path.join(__dirname, '..');

function boot() {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/h' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
    },
  });
  delete h.window.monaco;   // as at a real start, before anything asked for it
  return h;
}

const monacoScripts = (doc) => [...doc.querySelectorAll('script[src$="vendor/monaco.js"]')];

describe('Monaco loads on first use', () => {
  it('index.html does not load Monaco at start', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    expect(html).not.toMatch(/<script[^>]+vendor\/monaco\.js/);
    expect(html).not.toMatch(/<link[^>]+vendor\/monaco\.css/);
  });

  it('loadMonaco adds the env, the bundle and the stylesheet once, and resolves with monaco', async () => {
    const h = boot();
    await flush();
    const doc = h.window.document;
    const a = h.window.cceLoadMonaco();
    const b = h.window.cceLoadMonaco();
    expect(a).toBe(b);
    expect(doc.querySelectorAll('link[href$="vendor/monaco.css"]')).toHaveLength(1);
    const env = doc.querySelector('script[src$="vendor/monaco-env.js"]');
    env.dispatchEvent(new h.window.Event('load'));
    await flush();
    expect(monacoScripts(doc)).toHaveLength(1);
    h.window.monaco = { editor: { setTheme() {} } };
    monacoScripts(doc)[0].dispatchEvent(new h.window.Event('load'));
    expect(await a).toBe(h.window.monaco);
  });

  it('a missing bundle resolves to null, so callers fall back to plain text', async () => {
    const h = boot();
    await flush();
    const p = h.window.cceLoadMonaco();
    h.window.document.querySelector('script[src$="vendor/monaco-env.js"]').dispatchEvent(new h.window.Event('error'));
    expect(await p).toBeNull();
  });

  it('opening a diff before Monaco is loaded asks for it, then shows the text diff if it cannot load', async () => {
    const h = boot();
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.js', old_string: 'a', new_string: 'b' } }] } });
    await flush();
    const wrap = chat.msgs.querySelector('.monaco-diff');
    expect(wrap).toBeTruthy();
    wrap.__init();
    const env = h.window.document.querySelector('script[src$="vendor/monaco-env.js"]');
    expect(env).toBeTruthy();
    env.dispatchEvent(new h.window.Event('error'));
    await flush();
    expect(wrap.querySelector('.diff-line')).toBeTruthy();
  });
});

describe('connector status cache', () => {
  it('is kept for 30 s between Overview redraws', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/renderer/app/overview.js'), 'utf8');
    expect(src).toMatch(/CONNECTOR_STATUS_TTL_MS = 30_000/);
  });
});
