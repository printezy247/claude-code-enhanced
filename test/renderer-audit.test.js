// Renderer regressions from the 2026-10 audit, phase 3.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const ipc = {
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
};

async function open() {
  const h = loadRenderer({ ipc });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  const ev = (event) => send({ type: 'stream_event', event });
  return { h, chat, send, ev };
}

describe('interrupted / result without message_stop', () => {
  it('removes half-streamed live blocks and cancels running tool cards', async () => {
    const { chat, send, ev } = await open();
    ev({ type: 'message_start', message: {} });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } });
    expect(chat.msgs.querySelectorAll('.live').length).toBeGreaterThan(0);
    send({ type: 'result', subtype: 'error_during_execution', usage: {} });
    expect(chat.msgs.querySelectorAll('.live').length).toBe(0);
    expect(chat.msgs.textContent).not.toContain('preparing');
    expect(chat.lives.size).toBe(0);
  });
});

describe('tool card header', () => {
  it('is keyboard reachable and announces its state', async () => {
    const { chat, ev } = await open();
    ev({ type: 'message_start', message: {} });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } });
    const head = chat.msgs.querySelector('.tool-head');
    expect(head.getAttribute('tabindex')).toBe('0');
    expect(head.getAttribute('role')).toBe('button');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.dispatchEvent(new head.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('closeChat', () => {
  it('still tears the tab down when the IPC close rejects', async () => {
    const { h, chat } = await open();
    h.window.ccx.invoke = async () => { throw new Error('ipc gone'); };
    await h.window.Chat.closeChat('c1').catch(() => {});
    expect(h.window.Chat.chats.has('c1')).toBe(false);
  });
});
