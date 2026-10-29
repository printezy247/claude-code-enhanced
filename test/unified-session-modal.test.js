// The New session dialog in the real renderer: one Chat / one Terminal type,
// a CLI picker, "CLI default" first in the Model list (0.9.96).
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
  'chats:index': { ok: true, sessions: [] },
  'usage:scan': { ok: true, days: [], total: 0, sessions: 0 },
  'engines:list': { ok: true, engines: [
    { id: 'codex', label: 'Codex', found: true, hint: '' },
    { id: 'opencode', label: 'OpenCode', found: true, hint: '' },
    { id: 'antigravity', label: 'Antigravity CLI', found: false, hint: 'install it' },
  ] },
  'chat:create': { ok: true, id: 'c9', cwd: '/home/jack/alpha', model: '', permissionMode: 'default', provider: null },
};
const click = (h, el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
const change = (h, sel, v) => { sel.value = v; sel.dispatchEvent(new h.window.Event('change', { bubbles: true })); };

async function open() {
  const h = loadRenderer({ ipc });
  await flush(10);
  click(h, h.window.document.querySelector('#qa-new'));
  await flush(5);
  const sels = [...h.window.document.querySelectorAll('.modal select')];
  const launch = [...h.window.document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Launch');
  return { h, type: sels[0], cli: sels[1], model: sels[2], launch };
}

describe('New session dialog', () => {
  it('has Chat/Terminal, Claude first, missing CLIs greyed out', async () => {
    const { type, cli } = await open();
    expect([...type.options].map((o) => o.value)).toEqual(['chat', 'terminal']);
    expect([...cli.options].map((o) => o.value)).toEqual(['claude', 'codex', 'opencode', 'antigravity']);
    expect(cli.value).toBe('claude');
    expect(cli.querySelector('option[value="antigravity"]').disabled).toBe(true);
  });

  it('launches a Claude chat on CLI default (no provider)', async () => {
    const { h, model, launch } = await open();
    expect(model.value).toBe('');
    click(h, launch);
    await flush(5);
    const call = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(call.payload.cliDefault).toBe(true);
    expect(call.payload.providerUid).toBeUndefined();
    expect(call.payload.engine).toBeUndefined();
  });

  it('launches a Codex chat on a CCE provider model', async () => {
    const { h, cli, model, launch } = await open();
    change(h, cli, 'codex');
    const opts = [...model.options].map((o) => o.value);
    expect(opts[0]).toBe('');
    expect(opts).toContain(JSON.stringify({ uid: 'oai', model: 'qwen/qwen3-coder' }));
    expect(opts.some((v) => v.includes('"ant"'))).toBe(false);   // no base URL: Claude login only
    change(h, model, JSON.stringify({ uid: 'oai', model: 'qwen/qwen3-coder' }));
    click(h, launch);
    await flush(5);
    const call = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(call.payload).toMatchObject({ engine: 'codex', providerUid: 'oai', model: 'qwen/qwen3-coder' });
  });

  it('Terminal offers every CLI plus a shell', async () => {
    const { h, type, cli } = await open();
    change(h, type, 'terminal');
    expect([...cli.options].map((o) => o.value)).toEqual(['claude', 'codex', 'opencode', 'antigravity', 'shell']);
  });
});
