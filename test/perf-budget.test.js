// Perf budget: a long session (2000+ transcript cards) must stay cheap. The
// transcript keeps a virtual window of rows in the DOM, so the node count stays
// flat however long the chat gets, and each new card costs about the same.
// The old version of this file only split a string and never touched the
// renderer.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const CARDS = 2100;
const VIRT_WINDOW = 100;

async function openChat() {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/h' },
    'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100, autoNudge: false }, claude: { found: true, path: '', version: '' } },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  } });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  return { h, chat, send };
}

/** One turn = three cards: a reply, a tool call, its result. */
function turn(send, i) {
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Step ' + i + ': reading the file and checking the result.' }] } });
  send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu' + i, name: 'Bash', input: { command: 'echo ' + i } }] } });
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content: 'out ' + i }] } });
}

describe('perf budget: 2000+ transcript cards', () => {
  it('keeps the DOM to the virtual window and each card cheap', async () => {
    const { chat, send } = await openChat();
    const turns = Math.ceil(CARDS / 3);
    const t0 = performance.now();
    let firstHalf = 0;
    for (let i = 0; i < turns; i++) {
      turn(send, i);
      if (i === Math.floor(turns / 2)) firstHalf = performance.now() - t0;
    }
    await flush();
    const total = performance.now() - t0;
    const secondHalf = total - firstHalf;

    // Flat DOM: the window, plus a few non-row nodes (spacers, notes).
    expect(chat.msgs.children.length).toBeLessThanOrEqual(VIRT_WINDOW + 20);
    // Linear, not quadratic: the second half of the session costs about what
    // the first did. A per-card cost that grows with history doubles or worse.
    expect(secondHalf).toBeLessThan(firstHalf * 2.5 + 250);
    // Generous wall-clock ceiling for slow CI runners (jsdom, no GPU).
    expect(total).toBeLessThan(20000);
  }, 60000);

  it('the newest card is in the DOM and the oldest is not', async () => {
    const { chat, send } = await openChat();
    for (let i = 0; i < 800; i++) turn(send, i);
    await flush();
    expect(chat.msgs.textContent).toContain('Step 799:');
    expect(chat.msgs.textContent).not.toContain('Step 0:');
  }, 60000);
});
