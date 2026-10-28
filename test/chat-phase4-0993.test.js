// Chat upgrade, phase 4 (0.9.93): target chip, model+effort chip, code block
// header, richer jump-marker preview.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function open(create = {}) {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null, ...create },
      'chat:effort-levels': { ok: true, levels: ['low', 'high'] },
      'chat:effort': { ok: true },
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

describe('code block header', () => {
  it('shows the language and keeps the Copy button', async () => {
    const { chat, say } = await open();
    say('```bash\nls -la\n```');
    await flush(6);
    const pre = chat.msgs.querySelector('pre');
    expect(pre.querySelector('.code-lang').textContent).toBe('bash');
    expect(pre.querySelector('.pre-copy')).toBeTruthy();
  });
  it('Wrap toggles a class and reports its state', async () => {
    const { h, chat, say } = await open();
    say('```js\nlong\n```');
    await flush(6);
    const pre = chat.msgs.querySelector('pre');
    const wrap = [...pre.querySelectorAll('.code-act')].find((b) => b.textContent === 'Wrap');
    wrap.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    expect(pre.classList.contains('code-wrap')).toBe(true);
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
  });
  it('picks a file name from the language', async () => {
    const { codeFileName } = await import('../src/renderer/chat/cmdmatch.js');
    expect(codeFileName('python')).toBe('snippet.py');
    expect(codeFileName('Bash')).toBe('snippet.sh');
    expect(codeFileName('weird')).toBe('snippet.txt');
    expect(codeFileName('')).toBe('snippet.txt');
  });
});

describe('target chip', () => {
  it('says Local for a normal chat', async () => {
    const { chat } = await open();
    expect(chat.targetBtn.querySelector('.tg-label').textContent).toBe('Local');
  });
  it('says Worktree, with the path in its tooltip, for an isolated chat', async () => {
    const { chat } = await open({ worktree: { path: '/tmp/wt', branch: 'cc/x', root: '/tmp' } });
    expect(chat.targetBtn.querySelector('.tg-label').textContent).toBe('Worktree');
    expect(chat.targetBtn.title).toContain('/tmp/wt');
  });
  it('opens a two-item menu', async () => {
    const { h, chat } = await open();
    chat.targetBtn.click();
    const items = [...h.window.document.querySelectorAll('.target-menu .wf-item')].map((b) => b.textContent);
    expect(items.length).toBe(2);
    expect(items[0]).toContain('Local ✓');
  });
});

describe('model and effort in one chip', () => {
  it('appends the effort to the model label', async () => {
    const { h, chat } = await open();
    const o = h.window.document.createElement('option');
    o.value = 'm1'; o.textContent = 'model-one';
    chat.modelSel.appendChild(o);
    chat.modelSel.value = 'm1';
    expect(chat.modelBtn.querySelector('.mb-label').textContent).toBe('model-one');
    chat.effort = 'high';
    chat.syncModelBtn();
    expect(chat.modelBtn.querySelector('.mb-label').textContent).toBe('model-one · high');
  });
});

describe('jump marker preview', () => {
  it('shows three lines and the reply state in the tip', async () => {
    const { h, chat, say } = await open();
    const doc = h.window.document;
    chat.composer.value = 'line1\nline2\nline3\nline4';
    chat.send();
    await flush(4);
    say('an answer');
    await flush(8);
    await new Promise((r) => setTimeout(r, 60));
    const tick = chat.pane.querySelector('.req-tick');
    expect(tick).toBeTruthy();
    tick.dispatchEvent(new h.window.MouseEvent('mouseover', { bubbles: true }));
    const tip = chat.pane.querySelector('.req-tip').textContent;
    expect(tip).toContain('line3');
    expect(tip).not.toContain('line4');
    expect(tip).toMatch(/answered|no reply yet|still running/);
  });
});
