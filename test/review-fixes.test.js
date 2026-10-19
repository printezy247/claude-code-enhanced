// Fixes from the 0.9.30 code review: the queued-element collision, session-id
// tracking, unescaped names in innerHTML-built chips, the ask-card counter,
// and OAuth flows that could hang or reject unhandled after cancel.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const oauth = require('../src/main/oauth.js');

async function open(extra = {}) {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
      ...extra,
    },
  });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  return { h, chat, send };
}

describe('queued element vs queue counter', () => {
  it('sending mid-turn after a result still reaches the engine', async () => {
    const { h, chat, send } = await open();
    send({ type: 'result', subtype: 'success', result: 'All done for now.', queued_turn_count: 0 });
    chat.busy = true;
    chat.composer.value = 'steer it';
    chat.send();
    await flush();
    // Before the fix, renderQueued threw on the number that showQueued had
    // stored in chat.queued and the message never left the composer.
    expect(h.calls.some(c => c.channel === 'chat:send')).toBe(true);
  });
});

describe('session id tracking', () => {
  it('stores the engine session id on the chat, not only the tab meta', async () => {
    const { chat, send } = await open();
    send({ type: 'system', subtype: 'init', session_id: '11111111-2222-3333-4444-555555555555', model: 'sonnet' });
    expect(chat.sessionId).toBe('11111111-2222-3333-4444-555555555555');
  });
});

describe('names in innerHTML-built chips are escaped', () => {
  it('an MCP server name with HTML does not become live DOM', async () => {
    const { h, chat, send } = await open();
    send({
      type: 'system', subtype: 'init', model: 'sonnet',
      mcp_servers: [{ name: '<img id="xss1">', status: 'connected' }],
    });
    expect(chat.pane.querySelector('#xss1')).toBe(null);
    const chip = chat.pane.querySelector('.mcp-chip');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('<img id="xss1">');
    expect(h.calls.length).toBeGreaterThan(0);
  });
});

describe('ask cards share the pending counter', () => {
  it('counts a question card and clears it when answered', async () => {
    const { h, chat } = await open();
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'rq1', toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Which one?', multiSelect: false, options: [{ label: 'Alpha' }] }] },
    });
    expect(chat.permCount).toBe(1);
    const opt = chat.permSlot.querySelector('.ask-opt');
    opt.click();
    const send = [...chat.permSlot.querySelectorAll('.perm-actions button')].find(b => /Send/.test(b.textContent));
    send.click();
    await flush();
    expect(chat.permCount).toBe(0);
    expect(h.calls.some(c => c.channel === 'chat:permission-answer')).toBe(true);
  });

  it('a failed answer IPC surfaces an error instead of a silent hang', async () => {
    const { h, chat } = await open({
      'chat:permission-answer': { ok: false, error: 'request no longer pending' },
    });
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'permission', requestId: 'rq2', toolName: 'Bash', input: { command: 'ls' },
    });
    const allow = [...chat.permSlot.querySelectorAll('.perm-actions button')].find(b => /allow/i.test(b.textContent));
    allow.click();
    await flush();
    expect(h.window.document.querySelector('.toast')).toBeTruthy();
    expect(chat.busy).toBe(false);
  });
});

describe('OAuth cancel settles every flow', () => {
  const cfg = {
    flow: 'pkce',
    authorizeUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    clientId: 'cid',
    redirectUri: 'http://127.0.0.1:0/callback',
  };

  it('PKCE cancel rejects a pending wait() instead of hanging', async () => {
    const flow = oauth.begin('test', cfg);
    await flow.port;
    flow.cancel();
    await expect(flow.wait()).rejects.toThrow(/cancelled/);
  });

  it('device cancel rejects with "sign-in cancelled", not a timeout', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // The device endpoint issues the code; the token endpoint keeps pending
      // so only cancel can end the flow.
      const body = String(url).endsWith('/device')
        ? { interval: 3, device_code: 'dc', verification_uri: 'https://example.com/activate', user_code: 'ABCD-EFGH' }
        : { error: 'authorization_pending' };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    try {
      const flow = oauth.begin('test', {
        flow: 'device',
        deviceUrl: 'https://example.com/device',
        tokenUrl: 'https://example.com/token',
        clientId: 'cid',
      });
      const ready = await flow.ready;
      expect(ready.userCode).toBe('ABCD-EFGH');
      flow.cancel();
      await expect(flow.wait()).rejects.toThrow(/cancelled/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
