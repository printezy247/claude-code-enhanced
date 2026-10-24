// 0.9.65: icons in status rows are drawn (not printed as markup), terminal
// colour codes never reach a tool card, the chat stays on the window's centre
// line with the sidebar open, and the Overview can be resized.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const css = readFileSync(join(__dirname, '..', 'src/renderer/styles.css'), 'utf8');

const ipc = () => ({
  'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
});

describe('0.9.65 polish', () => {
  it('a denied tool shows an icon, not <svg> text', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush(10);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', reason: 'nope <b>' } });
    await flush();
    const note = h.window.document.querySelector('.sys-note.warn');
    expect(note.querySelector('svg')).toBeTruthy();
    expect(note.textContent).not.toContain('<svg');
    expect(note.textContent).toContain('nope <b>');
  });

  it('a background task row shows a clock icon, not markup', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush(10);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'task', msg: { subtype: 'task_started', task_id: 'b1', description: 'npm run dev', is_backgrounded: true } });
    await flush();
    const text = h.window.document.querySelector('.chat-msgs').textContent;
    expect(text).toContain('npm run dev');
    expect(text).not.toContain('<svg');
    expect(h.window.document.querySelector('.chat-msgs svg.ic-clock')).toBeTruthy();
  });

  it('colour codes are stripped from tool output', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush(10);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'deno test' } }] } } });
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '\u001b[0m\u001b[32mok\u001b[0m | 3 passed' }] } } });
    await flush();
    const out = h.window.document.querySelector('.tool-card pre, .tool-card .tool-out');
    expect(out.textContent).toContain('ok | 3 passed');
    expect(out.textContent).not.toContain('\u001b');
  });

  it('the chat column is offset by the sidebar width so it stays centred (wide windows)', () => {
    expect(css).toMatch(/@media \(min-width: 1500px\) \{\s*body:not\(\.sb-hidden\):not\(\.split-open\) :is\(\.chat-msgs, \.chat-perm-slot, \.chat-composer\) \{ padding-right: 272px; \}/);
  });

  it('the Overview gets a resize grip and remembers its width', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush(10);
    const doc = h.window.document;
    const grip = doc.querySelector('#overviewpane #ov-resize');
    expect(grip).toBeTruthy();
    grip.dispatchEvent(new h.window.MouseEvent('dblclick', { bubbles: true }));
    expect(doc.documentElement.style.getPropertyValue('--ov-w')).toBe('');
  });
});
