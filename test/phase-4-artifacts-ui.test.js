// @vitest-environment jsdom
// Phase 4.1 UI: keep a code block or a reply, see it in the Artifacts tab,
// export it to PDF, delete it. The viewer shows text, never raw markup.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

const open = async (extra = {}) => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    'artifact:save': { ok: true, id: 'a'.repeat(64) },
    'artifact:list': { ok: true, artifacts: [{ id: 'a'.repeat(64), title: 'Plan', kind: 'markdown', at: 1, bytes: 9, preview: '# Plan' }, { id: 'b'.repeat(64), title: 'snippet', kind: 'code', at: 0, bytes: 4, preview: 'x=1' }] },
    'artifact:get': (p) => ({ ok: true, id: p.id, title: 'Plan', kind: p.id[0] === 'a' ? 'markdown' : 'code', content: p.id[0] === 'a' ? '# Heading\n\n<img src=x onerror=alert(1)>' : 'x=1' }),
    'artifact:remove': { ok: true },
    'artifact:export-pdf': { ok: true, saved: true, path: '/tmp/Plan.pdf' },
    ...extra,
  } });
  await flush(4);
  return { h, w: h.window, chat: h.window.Chat.chats.get('c1') };
};
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

describe('keeping things', () => {
  it('a code block has a Keep button that saves it as code', async () => {
    const { h, w, chat } = await open();
    w.marked.parse = () => '<p>here:</p><pre><code class="language-js">const a = 1;</code></pre>';   // the test helper's parser has no code blocks
    w.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'here:\n\n```js\nconst a = 1;\n```' }] } } });
    await flush(4);
    const keep = chat.msgs.querySelector('pre .code-keep');
    expect(keep).toBeTruthy();
    click(w, keep);
    await flush(4);
    const call = h.calls.filter((c) => c.channel === 'artifact:save').pop();
    expect(call.payload).toMatchObject({ kind: 'code' });
    expect(call.payload.content).toContain('const a = 1;');
  });
  it('a reply has a Keep button that saves it as markdown', async () => {
    const { h, w, chat } = await open();
    w.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text: '# Plan\n\nsteps for the whole release, written out in full so it is worth keeping' }] } } });
    await flush(4);
    click(w, chat.msgs.querySelector('.msg-keep'));
    await flush(4);
    expect(h.calls.filter((c) => c.channel === 'artifact:save').pop().payload).toMatchObject({ kind: 'markdown', content: '# Plan\n\nsteps for the whole release, written out in full so it is worth keeping' });
  });
});

describe('Artifacts tab', () => {
  it('lists, opens as sanitized text, exports and deletes', async () => {
    const { h, w } = await open();
    w.openSplitTab('artifacts');
    await flush(6);
    const body = w.document.querySelector('#split-body');
    const rows = [...body.querySelectorAll('.artifact-row')];
    expect(rows.map((r) => r.querySelector('.artifact-title').textContent)).toEqual(['Plan', 'snippet']);
    click(w, rows[0]);
    await flush(6);
    expect(body.querySelector('.artifact-view h1, .artifact-view h2, .artifact-view p')).toBeTruthy();
    expect(body.querySelector('.artifact-view img[onerror]')).toBeNull();
    click(w, body.querySelector('.artifact-pdf'));
    await flush(4);
    const pdf = h.calls.filter((c) => c.channel === 'artifact:export-pdf').pop();
    expect(pdf.payload.id).toBe('a'.repeat(64));
    click(w, body.querySelector('.artifact-del'));
    await flush(4);
    expect(h.calls.some((c) => c.channel === 'artifact:remove' && c.payload.id === 'a'.repeat(64))).toBe(true);
  });
  it('the code view is plain text', async () => {
    const { w } = await open();
    w.openSplitTab('artifacts');
    await flush(6);
    click(w, w.document.querySelectorAll('#split-body .artifact-row')[1]);
    await flush(6);
    expect(w.document.querySelector('#split-body .artifact-view pre').textContent).toBe('x=1');
  });
});
