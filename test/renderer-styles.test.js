// Output-style picker: the engine's style list fills the footer select at
// init; changing it sends apply_flag_settings. #feat-output-styles
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h;
const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  'chat:styles': { ok: true, styles: ['Explanatory', 'Learning'] },
  'chat:flags': { ok: true },
  ...extra,
});

beforeEach(() => { h = null; });

describe('output style picker (#feat-output-styles)', () => {
  it('fills the footer select from the engine list at init', async () => {
    h = loadRenderer({ ipc: ipc() });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'init',
      session_id: 's1', plugin_errors: [], mcp_servers: [], tools: [], slash_commands: [], model: 'm' } });
    await flush();
    expect(chat.styleSel.classList.contains('hidden')).toBe(false);
    expect([...chat.styleSel.options].map(o => o.value)).toEqual(['', 'Explanatory', 'Learning']);
  });

  it('stays hidden when no styles exist', async () => {
    h = loadRenderer({ ipc: ipc({ 'chat:styles': { ok: true, styles: [] } }) });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'init',
      plugin_errors: [], mcp_servers: [], tools: [], slash_commands: [] } });
    await flush();
    expect(chat.styleSel.classList.contains('hidden')).toBe(true);
  });

  it('sends apply_flag_settings on change', async () => {
    h = loadRenderer({ ipc: ipc() });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'init',
      plugin_errors: [], mcp_servers: [], tools: [], slash_commands: [] } });
    await flush();
    chat.styleSel.value = 'Learning';
    chat.styleSel.dispatchEvent(new h.window.Event('change'));
    await flush();
    const call = h.calls.find(c => c.channel === 'chat:flags' && c.payload.patch && c.payload.patch.outputStyle === 'Learning');
    expect(call).toBeTruthy();
  });
});
