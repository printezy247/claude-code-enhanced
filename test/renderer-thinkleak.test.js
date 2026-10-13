// Chat view: reasoning a model wrote into its reply (ending in a bare </think>)
// folds away as a thought instead of being printed as the answer.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const LEAK = 'The PR has one open comment. My edit added an extra bracket.</think>Good, I can see the current state clearly.';

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
  const say = (text) => send({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  return { h, chat, send, say };
}

describe('reasoning leaked into a reply', () => {
  it('is folded into a collapsed thought, leaving only the answer as the message', async () => {
    const { chat, say } = await open();
    say(LEAK);
    await flush();
    const msg = chat.msgs.querySelector('.assistant-msg .md');
    expect(msg.textContent).toContain('Good, I can see the current state clearly.');
    expect(msg.textContent).not.toContain('extra bracket');
    expect(chat.msgs.textContent).not.toContain('</think>');
    const thought = chat.msgs.querySelector('details.thinking-block');
    expect(thought.open).toBe(false);
    expect(thought.querySelector('.think-body').textContent).toBe('The PR has one open comment. My edit added an extra bracket.');
    // The thought comes first, as it was written.
    expect(thought.compareDocumentPosition(msg) & 4).toBe(4);
  });

  it('copies only the answer', async () => {
    const { h, chat, say } = await open();
    say(LEAK);
    await flush();
    chat.msgs.querySelector('.assistant-msg .msg-copy').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush();
    expect(h.calls.filter(c => c.channel === 'clipboard:write').pop().payload.text).toBe('Good, I can see the current state clearly.');
  });

  it('folds it while the reply is still streaming', async () => {
    const { h, chat, send } = await open();
    const ev = (event) => send({ type: 'stream_event', event });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'weighing the options</think>Use ' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the second one.' } });
    await new Promise(r => h.window.requestAnimationFrame(r));
    await flush();
    expect(chat.msgs.querySelector('.assistant-msg.live .md').textContent.trim()).toBe('Use the second one.');
    expect(chat.msgs.querySelector('details.thinking-block .think-body').textContent).toBe('weighing the options');
    // When the finished message replaces the live one, no stray thought is left behind.
    ev({ type: 'message_stop' });
    expect(chat.msgs.querySelectorAll('details.thinking-block')).toHaveLength(0);
  });

  it('leaves a reply that only talks about the tag untouched', async () => {
    const { chat, say } = await open();
    say('The model ends its reasoning with `</think>` before answering.');
    await flush();
    expect(chat.msgs.querySelector('details.thinking-block')).toBeNull();
    expect(chat.msgs.querySelector('.assistant-msg .md').textContent).toContain('</think>');
  });
});
