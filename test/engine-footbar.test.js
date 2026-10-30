// The chat footbar of engine chats: Codex, Antigravity and OpenCode each show
// the controls their CLI has and leave out the rest (model, mode, effort,
// context / compact, attach), driven by the capabilities chat:create returns.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const ipc = {
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], defaultUid: 'ant', leanPresets: [], instances: [
    { uid: 'ant', name: 'Anthropic', baseUrl: '', model: '' },
    { uid: 'oai', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', model: 'qwen/qwen3-coder' },
  ] },
  'settings:get': { ok: true, settings: { defaultCwd: '/home/jack/alpha', fontSize: 14, scrollback: 1000, theme: 'dark', failoverChain: [], sandbox: {} }, claude: { found: true }, leanPresets: [] },
  'connectors:presets': { ok: true, presets: [] },
  'chat:supported-models': { ok: true, models: [{ id: 'm-fast', displayName: 'Fast' }] },
  'chat:effort-levels': { ok: true, levels: ['low', 'high'] },
  'chats:index': { ok: true, sessions: [] },
  'usage:scan': { ok: true, days: [], total: 0, sessions: 0 },
  'engines:list': { ok: true, engines: [
    { id: 'codex', label: 'Codex', bin: 'codex', providers: true, found: true, hint: '' },
    { id: 'opencode', label: 'OpenCode', bin: 'opencode', providers: true, found: true, hint: '' },
    { id: 'antigravity', label: 'Antigravity CLI', bin: 'agy', providers: false, found: false, hint: 'install it' },
  ] },
  'chat:create': { ok: true, id: 'c9', cwd: '/home/jack/alpha', model: '', permissionMode: 'default', provider: null },
};

const click = (h, el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

const CAPS = {
  codex: { images: true, approvals: true, model: true, effort: true, compact: true, context: true, folder: true, workflows: true, modes: [['default', 'ask', 'asks'], ['plan', 'read-only', 'ro'], ['bypassPermissions', 'yolo', 'no asks']] },
  antigravity: { images: false, approvals: false, model: true, effort: true, compact: false, context: false, folder: true, workflows: true, modes: [['default', 'ask', 'a'], ['acceptEdits', 'accept edits', 'b'], ['auto', 'auto', 'c'], ['plan', 'plan', 'd'], ['bypassPermissions', 'yolo', 'e']] },
  opencode: { images: true, approvals: true, model: true, effort: false, compact: false, context: false, folder: true, workflows: true, modes: null },
};

async function openEngineChat(engine, caps = CAPS[engine]) {
  const h = loadRenderer({
    ipc: {
      ...ipc,
      'chat:set-mode': { ok: true, permissionMode: 'plan', autoPolicy: false },
      'chat:create': { ok: true, id: 'c9', cwd: '/home/jack/alpha', engine, label: engine, model: engine + ' · CLI default', engineModel: '', permissionMode: 'default', provider: null, capabilities: caps },
    },
  });
  await flush(10);
  click(h, h.window.document.querySelector('#qa-new'));
  await flush(5);
  const sels = [...h.window.document.querySelectorAll('.modal select')];
  sels[1].value = engine;
  sels[1].dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await flush(3);
  const launch = [...h.window.document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Launch');
  click(h, launch);
  await flush(10);
  const pane = h.window.document.querySelector('.chat-pane');
  return { h, pane };
}

describe('engine chat footbar', () => {
  it('Codex: every control is there (model, mode with its own modes, effort, context)', async () => {
    const { pane } = await openEngineChat('codex');
    expect(pane.classList.contains('no-model')).toBe(false);
    expect(pane.classList.contains('no-mode')).toBe(false);
    expect(pane.classList.contains('no-ctx')).toBe(false);
    expect([...pane.querySelector('.chat-mode-foot').options].map((o) => o.value)).toEqual(['default', 'plan', 'bypassPermissions']);
    expect(pane.querySelector('.chat-mode-foot').value).toBe('default');
    const models = [...pane.querySelector('.chat-model-foot').options].map((o) => o.value);
    expect(models).toEqual(expect.arrayContaining(['', 'm-fast', '__custom']));
    expect(pane.querySelector('.chat-effort').classList.contains('hidden')).toBe(false);
    expect([...pane.querySelector('.chat-effort').options].map((o) => o.value)).toEqual(['', 'low', 'high']);
    expect(pane.querySelector('.chat-wf-btn')).not.toBeNull();
    expect(pane.querySelector('.chat-target-btn')).not.toBeNull();
  });

  it('Antigravity: model, mode and effort, but no context ring and no attach', async () => {
    const { pane } = await openEngineChat('antigravity');
    expect(pane.classList.contains('no-ctx')).toBe(true);
    expect(pane.classList.contains('engine-images')).toBe(false);
    expect([...pane.querySelector('.chat-mode-foot').options].map((o) => o.value)).toEqual(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);
    expect(pane.querySelector('.chat-effort').classList.contains('hidden')).toBe(false);
  });

  it('OpenCode: model only; no mode picker, no effort, no context ring', async () => {
    const { pane } = await openEngineChat('opencode', CAPS.opencode);
    expect(pane.classList.contains('no-mode')).toBe(true);
    expect(pane.classList.contains('no-ctx')).toBe(true);
    expect(pane.classList.contains('no-model')).toBe(false);
  });

  it('a CLI without a model switch gets no model chip', async () => {
    const { pane } = await openEngineChat('opencode', { ...CAPS.opencode, model: false });
    expect(pane.classList.contains('no-model')).toBe(true);
  });

  it('changing the mode asks the main process and keeps the CLI\'s own mode', async () => {
    const { h, pane } = await openEngineChat('codex');
    const sel = pane.querySelector('.chat-mode-foot');
    sel.value = 'plan';
    sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await flush(5);
    const call = h.calls.filter((c) => c.channel === 'chat:set-mode').pop();
    expect(call.payload).toMatchObject({ id: 'c9', mode: 'plan' });
  });
});
