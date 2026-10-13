// Code blocks: the copy button must paste exactly what the block says, and the
// highlighter must paint with the app's theme (it defaulted to black-on-dark).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const CODE = 'cd ~/abdul\n  bash install.sh\n\nsystemctl --user status abdul --no-pager\nabdul doctor';

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Monaco's colorize(): one <span> per line joined by <br/>, spaces as &nbsp;. */
const fakeColorize = async (text) => text.split('\n')
  .map((l) => '<span><span class="mtk1">' + escapeHtml(l).replace(/ /g, '&nbsp;') + '</span></span>')
  .join('<br/>');

async function open({ theme } = {}) {
  const themes = [];
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, theme: theme || 'dark' }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
    },
  });
  await flush();
  h.window.marked.parse = (t) => {
    const m = /^```(\w*)\n([\s\S]*?)\n```$/.exec(t);
    return m ? '<pre><code class="language-' + m[1] + '">' + escapeHtml(m[2]) + '</code></pre>' : '<p>' + escapeHtml(t) + '</p>';
  };
  h.window.monaco = { editor: { colorize: fakeColorize, setTheme: (t) => themes.push(t) } };
  if (theme) h.window.document.documentElement.setAttribute('data-theme', theme);
  const chat = h.window.Chat.chats.get('c1');
  const say = (text) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text }] } } });
  return { h, chat, say, themes };
}

const click = (h, node) => node.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
const lastCopied = (h) => h.calls.filter(c => c.channel === 'clipboard:write').pop().payload.text;

describe('code block copy', () => {
  it('pastes exactly the code shown, with real spaces and line breaks, after highlighting', async () => {
    const { h, chat, say } = await open();
    say('```bash\n' + CODE + '\n```');
    await flush(6);
    const code = chat.msgs.querySelector('pre code');
    // Prove the highlighter really did swap the DOM to the nbsp/<br> form that used to leak into copies.
    expect(code.innerHTML).toContain('&nbsp;');
    expect(code.textContent).not.toContain('\n');
    click(h, chat.msgs.querySelector('pre .pre-copy'));
    await flush(4);
    const got = lastCopied(h);
    expect(got).toBe(CODE);
    expect(got).not.toContain(' ');
    expect(got.split('\n')).toHaveLength(5);
  });

  it('does not put the button\'s own symbol into a copy of a bare <pre>', async () => {
    const { h, chat } = await open();
    h.window.marked.parse = () => '<pre>plain line one\nplain line two</pre>';
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } });
    await flush(4);
    click(h, chat.msgs.querySelector('pre .pre-copy'));
    await flush(4);
    expect(lastCopied(h)).toBe('plain line one\nplain line two');
  });

  it('still copies correctly when no highlighter is available', async () => {
    const { h, chat, say } = await open();
    delete h.window.monaco;
    say('```bash\n' + CODE + '\n```');
    await flush(4);
    click(h, chat.msgs.querySelector('pre .pre-copy'));
    await flush(4);
    expect(lastCopied(h)).toBe(CODE);
  });
});

describe('code block colours', () => {
  it('asks Monaco for the dark theme before highlighting', async () => {
    const { chat, say, themes } = await open({ theme: 'dark' });
    say('```bash\n' + CODE + '\n```');
    await flush(6);
    expect(chat.msgs.querySelector('pre code').innerHTML).toContain('mtk1');
    expect(themes).toContain('vs-dark');
  });

  it('uses the light theme when the app is light', async () => {
    const { say, themes } = await open({ theme: 'light' });
    say('```bash\n' + CODE + '\n```');
    await flush(6);
    expect(themes).toContain('vs');
    expect(themes).not.toContain('vs-dark');
  });

  it('switching the app theme switches Monaco too', async () => {
    const { h, themes } = await open();
    h.window.applyTheme('light');
    h.window.applyTheme('dark');
    expect(themes.slice(-2)).toEqual(['vs', 'vs-dark']);
  });
});
