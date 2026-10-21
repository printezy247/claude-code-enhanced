// Auto memory in the chat: off unless enabled, probes once after a few turns,
// stores the reply as proposals, and shows a chip until they are reviewed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const boot = async (autoMemory, pending = []) => {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100, autoMemory }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      'chat:send': { ok: true },
      'memory:probe-prompt': { ok: true, prompt: 'PROBE' },
      'memory:propose': { ok: true, queued: 1 },
      'memory:pending': { ok: true, pending },
      'memory:read': { ok: true, global: { path: '', content: '' }, project: null },
    },
  });
  await flush(4);
  return h;
};
const turn = (h, result) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'result', subtype: 'success', result, usage: {} } });
const sent = (h, text) => h.calls.some((c) => c.channel === 'chat:send' && c.payload.text === text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('auto memory in the chat', () => {
  it('does nothing while the setting is off', async () => {
    const h = await boot(false);
    for (let i = 0; i < 4; i++) turn(h, 'ok');
    await wait(1700);
    expect(sent(h, 'PROBE')).toBe(false);
  });

  it('probes once after three finished turns, then hands the reply to memory:propose', async () => {
    const h = await boot(true);
    turn(h, 'a'); turn(h, 'b');
    await wait(1700);
    expect(sent(h, 'PROBE')).toBe(false);            // only two turns so far
    turn(h, 'c');
    await wait(1700);
    expect(sent(h, 'PROBE')).toBe(true);
    turn(h, '[{"name":"x","type":"user","description":"d","body":"b"}]');   // the model's reply to the probe
    await flush(4);
    const call = h.calls.find((c) => c.channel === 'memory:propose');
    expect(call.payload.text).toContain('"name":"x"');
    expect(h.window.document.body.textContent).toContain('1 note to review');
    turn(h, 'd'); turn(h, 'e'); turn(h, 'f');
    await wait(1700);
    expect(h.calls.filter((c) => c.channel === 'chat:send' && c.payload.text === 'PROBE')).toHaveLength(1);   // never twice
  });

  it('shows a review chip when the folder already has notes waiting', async () => {
    const h = await boot(false, [{ slug: 'a', type: 'user', description: 'd', body: 'b' }]);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'init', model: 'm', mcp_servers: [] } });
    await flush(6);
    expect(h.window.document.querySelector('.mem-pending-chip').textContent).toContain('1 memory note to review');
  });
});
