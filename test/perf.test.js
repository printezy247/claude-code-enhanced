// Performance (0.9.14, #51): the session index must not block the Electron main
// thread, and a streaming reply must not re-parse its whole markdown on every
// delta.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

describe('session index prefers the SDK and never blocks', () => {
  it('falls back to the disk scan, with the same row shape', async () => {
    // HERMETIC: a temp HOME with a fake .claude/projects tree, so this does not
    // depend on the machine's own session history.
    const ChatManager = require('../src/main/chats.js');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-idx-'));
    const proj = path.join(home, '.claude', 'projects', '-tmp-demo');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, '5e6a8856-685b-7fff-aa97-9f9c1d4e6b22.jsonl'),
      '{"type":"summary","summary":"the summary"}\n'
      + '{"type":"user","cwd":"/tmp/demo","message":{"content":[{"type":"text","text":"the first prompt"}]}}\n');
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const mgr = new ChatManager({ sdk: {} });   // no listSessions -> fallback
      const rows = await mgr.index();
      expect(rows.length).toBe(1);
      expect(rows[0].sessionId).toBe('5e6a8856-685b-7fff-aa97-9f9c1d4e6b22');
      // The scan prefers the stored summary over the first prompt, which is the
      // same precedence the SDK path uses (title > summary > first prompt).
      expect(rows[0].preview).toBe('the summary');
      expect(rows[0].cwd).toBe('/tmp/demo');
      // Same shape as the SDK path, so the renderer need not branch.
      expect(rows[0]).toHaveProperty('branch');
      expect(rows[0]).toHaveProperty('renamed');
      expect(typeof rows[0].mtime).toBe('number');
    } finally {
      process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('yields the event loop instead of hogging it', async () => {
    // HERMETIC: a fake SDK whose listSessions awaits a macrotask, which is what
    // the real one does. The old synchronous scan allowed zero ticks.
    const ChatManager = require('../src/main/chats.js');
    const fakeSdk = {
      listSessions: async () => { await new Promise(r => setTimeout(r, 5)); return []; },
    };
    const mgr = new ChatManager({ sdk: fakeSdk });
    let ticks = 0;
    const iv = setInterval(() => ticks++, 0);
    await mgr.index();
    clearInterval(iv);
    expect(ticks).toBeGreaterThan(0);
  });

  it('maps every SDK field the renderer and the row UI rely on', async () => {
    // HERMETIC: the SDK is the only thing that knows gitBranch / customTitle,
    // so the mapping is asserted against a fake rather than the local disk.
    const ChatManager = require('../src/main/chats.js');
    const SID = '1a571551-242b-4a3c-b175-6aa0b93b1573';
    const fakeSdk = {
      listSessions: async () => ([
        { sessionId: SID, summary: 'generated summary', lastModified: 1700000000000, fileSize: 4096, customTitle: 'my renamed session', firstPrompt: 'the first prompt', gitBranch: 'main', cwd: '/tmp/proj', tag: '' },
        { sessionId: '2b682662-353c-5c5c-c886-dfc4dde4c284', summary: 'no title', lastModified: 1600000000000, gitBranch: 'feature/x', cwd: '/tmp/other' },
      ]),
    };
    const rows = await new ChatManager({ sdk: fakeSdk }).index();
    expect(rows.length).toBe(2);
    // Newest first.
    expect(rows[0].sessionId).toBe(SID);
    // A custom title wins over the generated summary and the first prompt.
    expect(rows[0].preview).toBe('my renamed session');
    expect(rows[0].renamed).toBe(true);
    // No custom title: fall back to the summary, and say it is not renamed.
    expect(rows[1].preview).toBe('no title');
    expect(rows[1].renamed).toBe(false);
    // The fields only the SDK can produce.
    expect(rows[0].branch).toBe('main');
    expect(rows[1].branch).toBe('feature/x');
    expect(rows[0].cwd).toBe('/tmp/proj');
    expect(rows[0].size).toBe(4096);
  });

  it('a non-uuid session id from the SDK is dropped, not shown', async () => {
    const ChatManager = require('../src/main/chats.js');
    const fakeSdk = {
      listSessions: async () => ([
        { sessionId: '../../etc/passwd', summary: 'x', lastModified: 1 },
        { sessionId: '3c793664-464d-6dd6-b06e-b97ee0cd4a95', summary: 'ok', lastModified: 2 },
      ]),
    };
    const rows = await new ChatManager({ sdk: fakeSdk }).index();
    expect(rows.length).toBe(1);
    expect(rows[0].sessionId).toBe('3c793664-464d-6dd6-b06e-b97ee0cd4a95');
  });

  it('history() passes the folder through and maps the same way', async () => {
    const ChatManager = require('../src/main/chats.js');
    const seen = [];
    const fakeSdk = {
      listSessions: async (opts) => { seen.push(opts); return [{ sessionId: '4d8a7755-575b-7eee-863d-bf0c7ecae6ee', summary: 's', lastModified: 5, gitBranch: 'br' }]; },
    };
    const rows = await new ChatManager({ sdk: fakeSdk }).history('/tmp/a-project');
    expect(seen[0].dir).toBe('/tmp/a-project');
    expect(rows[0].branch).toBe('br');
  });

  it('history() resolves an array even with no sessions at all', async () => {
    const ChatManager = require('../src/main/chats.js');
    const rows = await new ChatManager({ sdk: {} }).history('/tmp/definitely-no-such-project');
    expect(rows).toEqual([]);
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