// Two-line top bar: line one is tabs, line two is the quick actions with the
// active chat's header (folder, repo, branch, provider) beside "Closed tab".
import { describe, it, expect, beforeEach } from 'vitest';
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

describe('two-line top bar', () => {
  it('puts the active chat header in the quick row, after the Closed tab button', () => {
    const slot = doc().querySelector('#convo-quick #qa-chat-slot');
    expect(slot.querySelector('.chat-header .chat-project')).toBeTruthy();
    expect(slot.compareDocumentPosition(doc().querySelector('#qa-reopen')) & 2).toBe(2);   // Closed tab comes first
  });

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
