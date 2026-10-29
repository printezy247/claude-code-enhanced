// Batch B (0.11.0): Send to terminal, queue model/effort + test-failure hold,
// rich @ mentions, jump-marker metrics.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function open(extraIpc = {}) {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp/alpha', model: '', permissionMode: 'acceptEdits', provider: null },
      'chat:effort-levels': { ok: true, levels: ['low', 'high'] },
      'chat:effort': { ok: true },
      ...extraIpc,
    },
  });
  await flush();
  h.window.marked.parse = (t) => {
    const m = /^```(\w*)\n([\s\S]*?)\n```$/.exec(t);
    return m ? '<pre><code class="language-' + m[1] + '">' + escapeHtml(m[2]) + '</code></pre>' : '<p>' + escapeHtml(t) + '</p>';
  };
  const chat = h.window.Chat.chats.get('c1');
  const say = (text) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text }] } } });
  return { h, chat, say };
}
const click = (h, el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));

describe('queue: test failures hold the queue', async () => {
  const q = await import('../src/renderer/chat/queue.js');
  it('recognises test commands', () => {
    for (const c of ['npm test', 'npm run test -- --watch=false', 'npx vitest run', 'pytest -q tests/', 'cargo test --release', 'go test ./...', 'cd app && yarn test', 'make test']) {
      expect(q.isTestCommand(c), c).toBe(true);
    }
    for (const c of ['npm install', 'ls -la', 'git commit -m "add tests"', 'echo vitest-is-great', 'cat latest.log']) {
      expect(q.isTestCommand(c), c).toBe(false);
    }
  });
  it('holds on a failed test run unless the rule is off', () => {
    const list = [q.makeItem('next')];
    expect(q.nextAction(list, { testsFailed: true })).toEqual({ hold: 'tests' });
    expect(q.nextAction(list, { testsFailed: true, rules: { onTests: false } })).toMatchObject({ run: { text: 'next' } });
    expect(q.HOLD_TEXT.tests).toMatch(/test run failed/);
  });
  it('sets and clears the model and effort of one item', () => {
    const list = [q.makeItem('a'), q.makeItem('b')];
    const set = q.setOverrides(list, 1, { model: 'm1', effort: 'high' });
    expect(set[1]).toMatchObject({ model: 'm1', effort: 'high' });
    expect(set[0].model).toBeUndefined();
    const cleared = q.setOverrides(set, 1, { model: '', effort: 'high' });
    expect(cleared[1].model).toBeUndefined();
    expect(cleared[1].effort).toBe('high');
    expect(q.setOverrides(list, 9, { model: 'x' })).toEqual(list);
  });
});

describe('queue in the page', () => {
  it('a failed test run in a turn marks the chat, the next turn clears it', async () => {
    const { h, chat } = await open();
    const ev = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
    ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'FAIL', is_error: true }] } });
    ev({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 2 } });
    expect(chat.lastTurnTests).toBe(true);
    ev({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: {} });
    expect(chat.lastTurnTests).toBe(false);
  });

  it('the row menu has Model and effort, and setting it shows on the row', async () => {
    const { h, chat } = await open();
    chat.busy = true;                       // a message sent mid-turn waits in the queue
    chat.composer.value = 'first';
    chat.send('queue');
    await flush(2);
    expect(chat.pendingMsgs).toHaveLength(1);
    const more = chat.queuedEl.querySelector('.q-more');
    click(h, more);
    const item = [...chat.queuedEl.querySelectorAll('.q-menu-item')].find((b) => b.textContent.startsWith('Model and effort'));
    expect(item, 'menu entry').toBeTruthy();
    click(h, item);
    const pop = chat.queuedEl.querySelector('.q-pop');
    expect(pop).toBeTruthy();
    const [modelSel, effortSel] = pop.querySelectorAll('select');
    expect([...effortSel.options].map((o) => o.value)).toEqual(['', 'low', 'high']);
    effortSel.value = 'high';
    click(h, [...pop.querySelectorAll('button')].find((b) => b.textContent === 'Set'));
    expect(chat.pendingMsgs[0].effort).toBe('high');
    expect([...chat.queuedEl.querySelectorAll('.q-chip')].map((c) => c.textContent)).toContain('effort high');
  });
});

describe('Send to terminal', () => {
  it('shows only on shell blocks', async () => {
    const { chat, say } = await open();
    say('```bash\nls -la\n```');
    say('```js\nconst a = 1\n```');
    await flush(6);
    const pres = [...chat.msgs.querySelectorAll('pre')];
    const has = (pre) => [...pre.querySelectorAll('.code-act')].some((b) => b.textContent === 'Send to terminal');
    expect(has(pres[0])).toBe(true);
    expect(has(pres[1])).toBe(false);
  });

  it('pastes into the open terminal without running it', async () => {
    const { h, chat, say } = await open();
    const pasted = [];
    h.window.state.sessions.set('p1', { term: { paste: (t) => pasted.push(t), focus() {} }, fit: { fit() {} }, alive: true, pane: h.window.document.createElement('div'), tabEl: h.window.document.createElement('div') });
    h.window.__tabs.set('p1', { kind: 'pty', pane: h.window.document.createElement('div'), tabEl: h.window.document.createElement('div'), focus() {} });
    h.window.state.activeId = 'p1';
    say('```console\n$ npm ci\n$ npm run build\n```');
    await flush(6);
    const btn = [...chat.msgs.querySelectorAll('.code-act')].find((b) => b.textContent === 'Send to terminal');
    click(h, btn);
    await flush(4);
    expect(pasted).toEqual(['npm ci\nnpm run build']);   // prompts dropped, no trailing newline = not run
  });

  it('the text helpers', async () => {
    const { isShellBlock, shellText } = await import('../src/renderer/chat/cmdmatch.js');
    expect(isShellBlock('zsh', '')).toBe(true);
    expect(isShellBlock('', '#!/bin/bash\necho hi')).toBe(true);
    expect(isShellBlock('python', 'print(1)')).toBe(false);
    expect(shellText('$ ls\n$ pwd\n')).toBe('ls\npwd');
    expect(shellText('echo "$ not a prompt"\nls')).toBe('echo "$ not a prompt"\nls');
  });
});

describe('@ mentions of other conversations', async () => {
  const m = await import('../src/renderer/chat/mentions.js');
  it('tokens, splitting and expansion', () => {
    expect(m.chatToken('Fix "login" bug')).toBe('@chat:"Fix  login  bug"');
    const text = 'compare with @chat:"API work" please, and @chat:"API work" again';
    expect(m.mentionedTitles(text)).toEqual(['API work']);
    expect(m.splitMentions(text).map((p) => p.chat || p.text)).toEqual(['compare with ', 'API work', ' please, and ', 'API work', ' again']);
    const out = m.expandMentions(text, (t) => (t === 'API work' ? [{ role: 'user', text: 'add /users' }, { role: 'assistant', text: 'Added the endpoint.' }] : null));
    expect(out.startsWith(text)).toBe(true);
    expect(out).toContain('<conversation title="API work">');
    expect(out).toContain('Assistant: Added the endpoint.');
    expect(m.expandMentions('see @chat:"gone"', () => null)).toBe('see @chat:"gone"');
    expect(m.conversationContext('t', [])).toBe('');
  });

  it('the bubble shows each mention as a link that jumps to that chat', async () => {
    const { h } = await open();
    const doc = h.window.document;
    const bubble = doc.createElement('div');
    const jumped = [];
    m.renderMentions(bubble, 'look at @chat:"Beta" now', (t) => jumped.push(t), doc);
    const a = bubble.querySelector('a.chat-mention');
    expect(a.textContent).toBe('@Beta');
    expect(bubble.textContent).toBe('look at @Beta now');
    click(h, a);
    expect(jumped).toEqual(['Beta']);
  });
});

describe('jump-marker metrics', () => {
  it('formats a result', async () => {
    const { formatRequestMetrics } = await import('../src/renderer/chat/metrics.js');
    expect(formatRequestMetrics({ duration_ms: 12400, usage: { input_tokens: 3000, cache_read_input_tokens: 400, output_tokens: 320 }, total_cost_usd: 0.0421 })).toBe('took 12s · 3.4k in / 320 out · $0.042');
    expect(formatRequestMetrics({ duration_ms: 90000, usage: { output_tokens: 5 } }, { metered: false })).toBe('took 1m 30s · 0 in / 5 out');
    expect(formatRequestMetrics({})).toBe('');
  });

  it('a finished turn stores its cost on the request and the rail hover shows it', async () => {
    const { h, chat } = await open();
    chat.composer.value = 'first question';
    chat.send();
    await flush(2);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 5000, usage: { input_tokens: 1200, output_tokens: 80 } } });
    const req = chat.msgs.querySelector(':scope > .user-msg');
    expect(req.dataset.metrics).toBe('took 5s · 1.2k in / 80 out');
  });
});

describe('@ image preview handler', () => {
  it('file:thumb refuses anything outside an open project and non-images', async () => {
    const stub = require('electron');
    stub.__reset();
    require('../src/main/main.js');
    await new Promise((r) => setTimeout(r, 200));
    const thumb = stub.__state.handlers.get('file:thumb');
    expect(thumb, 'file:thumb missing').toBeTruthy();
    for (const p of ['/etc/hostname', '/etc/passwd', '~/.ssh/id_rsa', 'photo.png', '/tmp/not-in-a-project.png']) {
      expect((await thumb(null, { path: p })).ok, p).toBe(false);
    }
  });
});
