// Phase 4 of the CCE review: stability checks. The loop guard must not stop
// an ordinary edit-and-test cycle; a provider switch must not leave the old
// engine running; a failed send says the real cause in words; and the chats
// that were open when the app last stopped can be reopened from the home page.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoopGuard } = require('../src/main/loopguard.js');
const ChatManager = require('../src/main/chats.js');
const { loadRenderer, flush } = require('./helpers/renderer.js');

describe('loop guard: no false trips on a fix cycle', () => {
  it('test, edit, test, edit… with failing tests never trips', () => {
    const g = createLoopGuard();
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const t = { id: 't' + n++, name: 'Bash', input: { command: 'npm test' } };
      expect(g.record(t).tripped).toBe(false);
      g.result(t.id, 'FAIL test/a.test.js\n  expected ' + i + ' to be 12\nTests 1 failed | 40 passed', true);
      const e = { id: 't' + n++, name: 'Edit', input: { file_path: '/a.js', old_string: 'v' + i, new_string: 'v' + (i + 1) } };
      expect(g.record(e).tripped).toBe(false);
      g.result(e.id, 'ok', false);
    }
  });

  it('the same failing test after each different edit never trips', () => {
    const g = createLoopGuard();
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const t = { id: 'x' + n++, name: 'Bash', input: { command: 'npx vitest run test/a.test.js' } };
      expect(g.record(t).tripped).toBe(false);
      g.result(t.id, 'FAIL expected 1 to be 2 (Duration 1.2' + i + 's)', true);
      const e = { id: 'x' + n++, name: 'Write', input: { file_path: '/a.js', content: 'try ' + i } };
      expect(g.record(e).tripped).toBe(false);
      g.result(e.id, 'written', false);
    }
  });

  it('still trips on the same test run three times with nothing changed', () => {
    const g = createLoopGuard();
    let tripped = false;
    for (let i = 0; i < 3; i++) {
      const t = { id: 'r' + i, name: 'Bash', input: { command: 'npm test' } };
      tripped = g.record(t).tripped || tripped;
      g.result(t.id, 'Tests 40 passed', false);
    }
    expect(tripped).toBe(true);
  });
});

describe('provider switch leaves no engine behind', () => {
  it('closing a chat aborts its engine process', async () => {
    let opts = null;
    const close = vi.fn();
    const sdk = { query: ({ options }) => { opts = options; return Object.assign((async function* () { await new Promise(() => {}); })(), { interrupt: vi.fn(), setModel: vi.fn(), setPermissionMode: vi.fn(), close }); } };
    const mgr = new ChatManager({ proxyToken: 't', sdk });
    const { id } = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {}, model: 'm' });
    mgr.close(id);
    expect(opts.abortController.signal.aborted).toBe(true);
  });
});

function boot({ storage, ipc = {} } = {}) {
  return loadRenderer({
    welcome: false,
    storage,
    ipc: {
      'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': (p) => ({ ok: true, id: 'c' + Math.random().toString(36).slice(2, 7), cwd: (p && p.cwd) || '/tmp', model: '', permissionMode: 'default', provider: null }),
      'chats:index': { ok: true, sessions: [] },
      ...ipc,
    },
  });
}

describe('failed sends say the real cause', () => {
  const cases = [
    ['authentication_failed', '', /sign-in|API key/i],
    ['billing_error', 'credit balance is too low', /credit|quota/i],
    ['rate_limit', '', /rate limit/i],
    ['invalid_request', 'prompt is too long: 250000 tokens > 200000 maximum', /too large|too long/i],
    ['model_not_found', 'model x does not exist', /model/i],
  ];
  for (const [code, detail, want] of cases) {
    it(code, async () => {
      const h = boot({ ipc: { 'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null } } });
      await flush(8);
      h.window.document.querySelector('#home-here').click();
      await flush(8);
      const chat = h.window.Chat.chats.get('c1');
      h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', error: code, message: { content: detail ? [{ type: 'text', text: detail }] : [] } } });
      await flush();
      const err = [...chat.msgs.querySelectorAll('.error-msg')].map((n) => n.textContent).join(' ');
      expect(err).toMatch(want);
      expect(err).toContain(code);
    });
  }
});

describe('reopen the chats from last time', () => {
  const saved = JSON.stringify([{ cwd: '/home/test/a', sessionId: '11111111-1111-4111-8111-111111111111' }, { cwd: '/home/test/b', sessionId: '22222222-2222-4222-8222-222222222222' }]);

  it('the home page offers them and reopens each by session id', async () => {
    const h = boot({ storage: { 'cce:openChats': saved } });
    await flush(8);
    const btn = h.window.document.querySelector('#home-restore');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('2');
    btn.click();
    await flush(12);
    const resumed = h.calls.filter((c) => c.channel === 'chat:create').map((c) => [c.payload.cwd, c.payload.resume]);
    expect(resumed).toEqual([
      ['/home/test/a', '11111111-1111-4111-8111-111111111111'],
      ['/home/test/b', '22222222-2222-4222-8222-222222222222'],
    ]);
  });

  it('no button when nothing was open', async () => {
    const h = boot();
    await flush(8);
    expect(h.window.document.querySelector('#home-restore')).toBeNull();
  });

  it('remembers a chat once the engine names its session', async () => {
    const h = boot({ ipc: { 'chat:create': { ok: true, id: 'c1', cwd: '/home/test/w', model: '', permissionMode: 'default', provider: null } } });
    await flush(8);
    h.window.document.querySelector('#home-here').click();
    await flush(8);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'init', session_id: '33333333-3333-4333-8333-333333333333', tools: [], model: 'm' } });
    await flush();
    expect(JSON.parse(h.window.localStorage.getItem('cce:openChats'))).toEqual([{ cwd: '/home/test/w', sessionId: '33333333-3333-4333-8333-333333333333' }]);
  });
});
