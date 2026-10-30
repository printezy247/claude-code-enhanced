// Phase 2.6: render-time budgets. Generous ceilings (about 20x what a slow
// laptop needs) so they only fail on a real regression, e.g. work that grows
// with the square of the list. Each failure says which budget broke.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { rankCommands, windowRange } from '../src/renderer/chat/cmdmatch.js';
import { makeItem, move, nextAction, serialize, deserialize } from '../src/renderer/chat/queue.js';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const within = (label, ms, fn) => {
  const t0 = performance.now();
  fn();
  const took = performance.now() - t0;
  expect(took, `${label} took ${took.toFixed(0)} ms, budget ${ms} ms`).toBeLessThan(ms);
};

describe('performance budgets', () => {
  const cmds = Array.from({ length: 1000 }, (_, i) => ({ name: 'cmd-' + i + '-thing', description: 'does thing number ' + i, source: i % 3 ? 'project' : 'user' }));

  it('slash menu: ranking 1000 commands per keystroke', () => {
    within('rank 1000 commands, empty query', 150, () => rankCommands(cmds, '', []));
    for (const q of ['c', 'cmd-9', 'thing 5', 'zzzz']) within('rank 1000 commands for "' + q + '"', 150, () => rankCommands(cmds, q, ['cmd-1-thing']));
  });
  it('slash menu: only a window of rows is drawn', () => {
    const { first, last } = windowRange(1000, 28, 5000, 280);
    expect(last - first, 'rows drawn for 1000 commands').toBeLessThan(30);
  });
  it('queue: 50 items through the pure queue code', () => {
    const list = Array.from({ length: 50 }, (_, i) => makeItem('message ' + i));
    within('move, next-action and save of a 50-item queue', 50, () => {
      let l = list;
      for (let i = 0; i < 49; i++) l = move(l, i, 49 - i);
      nextAction(l, {});
      deserialize(JSON.stringify(serialize(l)));
    });
  });
  it('queue: drawing 50 rows', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    } });
    await flush(4);
    const chat = h.window.Chat.chats.get('c1');
    chat.busy = true;
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) { chat.composer.value = 'queued message ' + i; chat.send('queue'); }
    const took = performance.now() - t0;
    expect(chat.queuedEl.querySelectorAll('.q-row').length, 'rows drawn').toBe(50);
    expect(took, `queueing and drawing 50 rows took ${took.toFixed(0)} ms, budget 3000 ms`).toBeLessThan(3000);
  });
});
