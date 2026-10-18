// MCP elicitation cards: connector OAuth (url mode) and structured input (form
// mode). The SDK's onElicitation now reaches the user instead of being declined.
// #feat-elicitation
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const ipc = {
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  'chat:elicit-answer': { ok: true },
  'shell:openExternal': { ok: true },
};

let h;
beforeEach(() => { h = loadRenderer({ ipc }); });

const elicited = () => h.calls.filter(c => c.channel === 'chat:elicit-answer');

describe('elicitation card (#feat-elicitation)', () => {
  it('renders a form from requestedSchema and submits typed values', async () => {
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'elicitation', requestId: 'e1', serverName: 'github', mode: 'form',
      message: 'Sign in', requestedSchema: {
        type: 'object',
        properties: { user: { type: 'string', title: 'Username' }, tok: { type: 'string', title: 'Token' } },
        required: ['user', 'tok'],
      }, expiresAt: Date.now() + 60000,
    });
    await flush();
    const card = chat.permSlot.querySelector('.elic[data-rid="e1"]');
    expect(card).toBeTruthy();
    expect([...card.querySelectorAll('[data-key]')].map(i => i.dataset.key)).toEqual(['user', 'tok']);

    // required fields empty → Submit disabled
    const send = [...card.querySelectorAll('button')].find(b => b.textContent === 'Submit');
    expect(send.disabled).toBe(true);

    card.querySelector('[data-key="user"]').value = 'ada';
    card.querySelector('[data-key="tok"]').value = 'ghp_x';
    card.querySelector('[data-key="user"]').dispatchEvent(new h.window.Event('input', { bubbles: true }));
    expect(send.disabled).toBe(false);

    send.click();
    await flush();
    const call = elicited().find(c => c.payload.requestId === 'e1');
    expect(call.payload.action).toBe('accept');
    expect(call.payload.content).toEqual({ user: 'ada', tok: 'ghp_x' });
    expect(chat.permSlot.querySelector('.elic[data-rid="e1"]')).toBeFalsy(); // card removed
  });

  it('url mode opens the authorization page and can accept or decline', async () => {
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'elicitation', requestId: 'e2', serverName: 'notion', mode: 'url',
      message: 'Authorize in your browser', url: 'https://notion.so/authorize?x=1',
      elicitationId: 'el-9', expiresAt: Date.now() + 60000,
    });
    await flush();
    const card = chat.permSlot.querySelector('.elic[data-rid="e2"]');
    expect(card).toBeTruthy();
    const open = [...card.querySelectorAll('button')].find(b => b.textContent.includes('Open authorization'));
    open.click();
    await flush();
    expect(h.calls.some(c => c.channel === 'shell:openExternal' && c.payload.url === 'https://notion.so/authorize?x=1')).toBe(true);
    const decline = [...card.querySelectorAll('button')].find(b => b.textContent === 'Decline');
    decline.click();
    await flush();
    const d = elicited().find(c => c.payload.requestId === 'e2');
    expect(d.payload.action).toBe('decline');
    expect(chat.permSlot.querySelector('.elic[data-rid="e2"]')).toBeFalsy();
  });

  it('auto-accepts when the connector reports elicitation_complete', async () => {
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'elicitation', requestId: 'e3', serverName: 'linear', mode: 'url',
      url: 'https://linear.app/oauth', elicitationId: 'el-3', expiresAt: Date.now() + 60000,
    });
    await flush();
    expect(chat.permSlot.querySelector('.elic[data-rid="e3"]')).toBeTruthy();
    // engine says the browser round-trip finished
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'elicitation_complete', elicitation_id: 'el-3' } });
    await flush();
    const call = elicited().find(c => c.payload.requestId === 'e3');
    expect(call && call.payload.action).toBe('accept');
    expect(chat.permSlot.querySelector('.elic[data-rid="e3"]')).toBeFalsy();
  });

  it('clears the card on a timeout / interrupt event', async () => {
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'elicitation', requestId: 'e4', serverName: 's', mode: 'form',
      requestedSchema: { type: 'object', properties: { a: { type: 'string' } }, required: [] },
      expiresAt: Date.now() + 60000,
    });
    await flush();
    expect(chat.permSlot.querySelector('.elic[data-rid="e4"]')).toBeTruthy();
    h.window.Chat.handleEvent({ id: 'c1', kind: 'elicitation-cleared', requestId: 'e4', reason: 'timeout' });
    expect(chat.permSlot.querySelector('.elic[data-rid="e4"]')).toBeFalsy();
  });
});
