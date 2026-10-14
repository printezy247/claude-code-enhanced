// Performance (0.9.14, #51): the session index must not block the Electron main
// thread, and a streaming reply must not re-parse its whole markdown on every
// delta.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

describe('session index prefers the SDK and never blocks', () => {
  it('index() resolves an array and reports branch/title fields', async () => {
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: {} });
    const rows = await mgr.index();
    expect(Array.isArray(rows)).toBe(true);
    // Whichever path ran, the shape the renderer consumes is unchanged, plus
    // the two fields the SDK adds.
    for (const r of rows.slice(0, 5)) {
      expect(typeof r.sessionId).toBe('string');
      expect(typeof r.mtime).toBe('number');
      expect(r).toHaveProperty('preview');
      expect(r).toHaveProperty('branch');
    }
  });

  it('falls back to the disk scan when the SDK has no listSessions', async () => {
    const ChatManager = require('../src/main/chats.js');
    // An sdk object with no session helpers: index() must still answer.
    const mgr = new ChatManager({ sdk: {} });
    const viaFallback = await mgr.scanIndex();
    expect(Array.isArray(viaFallback)).toBe(true);
  });

  it('yields the event loop instead of hogging it', async () => {
    // No sdk override: this is the real production path, where the SDK's own
    // async work interleaves with our timers. The old synchronous scan allowed
    // zero ticks.
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ proxyToken: 'tok' });
    let ticks = 0;
    const iv = setInterval(() => ticks++, 0);
    const rows = await mgr.index();
    clearInterval(iv);
    expect(rows.length).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
  });

  it('the SDK path is what actually answers, and it carries the extra fields', async () => {
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ proxyToken: 'tok' });
    const rows = await mgr.index();
    expect(rows.length).toBeGreaterThan(0);
    // gitBranch is computable only by the SDK; the disk scan cannot produce it.
    expect(rows.some(r => r.branch)).toBe(true);
    expect(rows.filter(r => r.branch).every(r => typeof r.branch === 'string')).toBe(true);
  });

  it('history() also resolves and is not a bare array', async () => {
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: {} });
    const rows = await mgr.history(process.cwd());
    expect(Array.isArray(rows)).toBe(true);
  });

  it('transcriptItems caps the replay at 300 items', async () => {
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: {} });
    const records = [];
    for (let i = 0; i < 400; i++) records.push({ type: 'user', message: { content: [{ type: 'text', text: 'm' + i }] } });
    const out = ChatManager.transcriptItems(records);
    expect(out.length).toBe(300);
    // The cap keeps the tail, which is the recent conversation.
    expect(out[out.length - 1].text).toBe('m399');
  });
});

describe('transcriptItems pairs tool results with their cards', () => {
  it('attaches output and error state to the matching tool item', () => {
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: {} });
    const items = ChatManager.transcriptItems([
      { type: 'user', message: { content: [{ type: 'text', text: 'run it' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'no such file' }] }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'that failed' }] } },
    ]);
    expect(items.map(i => i.t)).toEqual(['user', 'tool', 'assistant']);
    expect(items[1].output).toBe('no such file');
    expect(items[1].isError).toBe(true);
  });

  it('drops sidechain, meta and summary records', () => {
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: {} });
    const items = ChatManager.transcriptItems([
      { type: 'summary', summary: 'a title' },
      { type: 'user', isSidechain: true, message: { content: [{ type: 'text', text: 'from a sidechain' }] } },
      { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'real' }] } },
    ]);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe('real');
  });

  it('a result with no matching card is ignored, not crashed on', () => {
    const ChatManager = require('../src/main/chats.js');
    const mgr = new ChatManager({ sdk: {} });
    const items = ChatManager.transcriptItems([
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe('ok');
  });
});

describe('streaming commits are coalesced (#51)', () => {
  const ipc = {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
  };

  const evt = (msg) => ({ id: 'c1', kind: 'message', msg });
  const start = () => evt({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const say = (text) => evt({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

  it('the whole reply still lands, coalesced into fewer paints', async () => {
    const h = loadRenderer({ ipc });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent(start());
    const words = 'the quick brown fox jumps over the lazy dog'.split(' ');
    for (const w of words) h.window.Chat.handleEvent(say(w + ' '));
    await new Promise(r => setTimeout(r, 140));   // past the commit window
    const body = chat.msgs.querySelector('.assistant-msg .md');
    expect(body).toBeTruthy();
    // Coalescing must not lose or duplicate any word.
    const text = body.textContent.replace(/\s+/g, ' ').trim();
    for (const w of words) expect(text).toContain(w);
    expect(text.split(' ').filter(Boolean).length).toBe(words.length);
  });

  it('a delta inside the window survives to the final frame', async () => {
    // message_stop tears the live block down (the finalized assistant frame
    // replaces it), so the guarantee is that nothing is lost: the engine's
    // final frame carries the complete text regardless of where the last
    // coalesced delta landed.
    const h = loadRenderer({ ipc });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent(start());
    h.window.Chat.handleEvent(say('first part'));
    await new Promise(r => setTimeout(r, 100));
    h.window.Chat.handleEvent(say(' and the very last words'));
    h.window.Chat.handleEvent(evt({ type: 'stream_event', event: { type: 'message_stop' } }));
    h.window.Chat.handleEvent(evt({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'first part and the very last words' }] },
    }));
    await flush();
    const bodies = [...chat.msgs.querySelectorAll('.assistant-msg .md')];
    expect(bodies.length).toBe(1);
    expect(bodies[0].textContent).toContain('and the very last words');
  });

  it('the finalized block is enhanced (copy button) while live ones are not', async () => {
    // Copy buttons and syntax colouring are per-commit work, so they only run
    // on the final paint. A half-written reply must not pay for them.
    const h = loadRenderer({ ipc });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent(start());
    h.window.Chat.handleEvent(say('partial'));
    await new Promise(r => setTimeout(r, 120));
    // Still streaming: no copy button yet.
    expect(chat.msgs.querySelector('.assistant-msg .msg-copy')).toBeNull();
    h.window.Chat.handleEvent(evt({ type: 'stream_event', event: { type: 'message_stop' } }));
    h.window.Chat.handleEvent(evt({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }));
    await flush();
    expect(chat.msgs.querySelector('.assistant-msg .msg-copy')).toBeTruthy();
  });

  it('a delta inside the window is not painted synchronously', async () => {
    const h = loadRenderer({ ipc });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent(start());
    h.window.Chat.handleEvent(say('one'));
    await new Promise(r => setTimeout(r, 100));
    h.window.Chat.handleEvent(say(' two'));
    // Immediately after the delta, the second half is NOT yet in the DOM:
    // that is the coalescing working.
    const body = chat.msgs.querySelector('.assistant-msg .md');
    expect(body.textContent).not.toContain('two');
    await new Promise(r => setTimeout(r, 120));
    expect(chat.msgs.querySelector('.assistant-msg .md').textContent).toContain('two');
  });

  it('the finalized assistant message renders once, in full', async () => {
    const h = loadRenderer({ ipc });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent(start());
    for (const t of ['A ', 'B ', 'C']) h.window.Chat.handleEvent(say(t));
    h.window.Chat.handleEvent(evt({ type: 'assistant', message: { content: [{ type: 'text', text: 'A B C' }] } }));
    await flush();
    const bodies = [...chat.msgs.querySelectorAll('.assistant-msg .md')];
    expect(bodies.length).toBe(1);
    expect(bodies[0].textContent).toContain('A B C');
  });
});

describe('off-screen messages skip layout and paint (#51)', () => {
  it('settled rows opt into content-visibility, the streaming one does not', () => {
    const fs = require('fs');
    const css = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
    expect(css).toMatch(/\.chat-msgs > \.msg[^{]*\{[^}]*content-visibility:\s*auto/);
    expect(css).toContain('contain-intrinsic-size');
    // The block being streamed must stay visible or the user sees nothing.
    expect(css).toMatch(/\.live[^{]*\{[^}]*content-visibility:\s*visible/);
  });
});