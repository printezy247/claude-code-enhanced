// Chat view: a reply that streamed while the user was scrolled up must not be
// drawn twice. The live block was detached (outside the virtual window), so
// clearLive's bare remove() left it in chat._allNodes and the next window
// rebuild painted it again above the final copy, caret and all.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

async function open() {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
    },
  });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  return { h, chat, send };
}

describe('reply streamed while scrolled up', () => {
  it('leaves no stale live block in the virtual list', async () => {
    const { chat, send } = await open();
    const say = (text) => send({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    for (let i = 0; i < 120; i++) say('older ' + i);
    await flush();
    chat.follow = false;   // the user scrolled up to read
    const ev = (event) => send({ type: 'stream_event', event });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'You turned down the question.' } });
    say('You turned down the question.');
    await flush();
    expect(chat._allNodes.some(n => n.classList && n.classList.contains('live'))).toBe(false);
    expect(chat._allNodes.some(n => n.querySelector && /Thinking…/.test(n.textContent || ''))).toBe(false);
    const copies = chat._allNodes.filter(n => (n.textContent || '').includes('You turned down the question.'));
    expect(copies).toHaveLength(1);
  });
});
