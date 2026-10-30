// Per-project monthly budgets: ledger, standing, and one alert per level.
import { describe, it, expect } from 'vitest';
import { addSpend, standing, nextAlert, recordTurn } from '../src/renderer/app/budgets.js';

const OCT = Date.UTC(2026, 9, 15);
const NOV = Date.UTC(2026, 10, 2);
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } }; };

describe('ledger', () => {
  it('adds per folder and starts clean in a new month', () => {
    let l = addSpend(null, '/a', 1.5, OCT);
    l = addSpend(l, '/a', 0.5, OCT);
    l = addSpend(l, '/b', 3, OCT);
    expect(l.byCwd).toEqual({ '/a': 2, '/b': 3 });
    expect(addSpend(l, '/a', 1, NOV).byCwd).toEqual({ '/a': 1 });
  });
  it('ignores junk costs', () => {
    expect(addSpend(null, '/a', NaN, OCT).byCwd).toEqual({});
    expect(addSpend(null, '/a', -2, OCT).byCwd).toEqual({});
  });
});

describe('standing', () => {
  it('reports none, ok, warn and over', () => {
    const l = { month: '2026-10', byCwd: { '/a': 8 }, alerted: {} };
    expect(standing(l, {}, '/a', OCT).level).toBe('none');
    expect(standing(l, { '/a': 100 }, '/a', OCT).level).toBe('ok');
    expect(standing(l, { '/a': 10 }, '/a', OCT).level).toBe('warn');
    expect(standing(l, { '/a': 8 }, '/a', OCT).level).toBe('over');
  });
  it('counts last month as zero', () => {
    const l = { month: '2026-10', byCwd: { '/a': 99 }, alerted: {} };
    expect(standing(l, { '/a': 10 }, '/a', NOV).spent).toBe(0);
  });
});

describe('alerts', () => {
  it('fire once per level', () => {
    const l = { month: '2026-10', byCwd: { '/a': 8.5 }, alerted: {} };
    expect(nextAlert(l, { '/a': 10 }, '/a', OCT).level).toBe('warn');
    expect(nextAlert(l, { '/a': 10 }, '/a', OCT)).toBeNull();
    l.byCwd['/a'] = 10.5;
    expect(nextAlert(l, { '/a': 10 }, '/a', OCT).level).toBe('over');
    expect(nextAlert(l, { '/a': 10 }, '/a', OCT)).toBeNull();
  });
  it('recordTurn stores spend and returns a plain message', () => {
    const store = mem();
    store.setItem('cce:budgets', JSON.stringify({ '/work/app': 10 }));
    expect(recordTurn(store, '/work/app', 5, OCT)).toBeNull();
    expect(recordTurn(store, '/work/app', 3.5, OCT)).toMatch(/app is at 85% of its monthly budget/);
    expect(recordTurn(store, '/work/app', 2, OCT)).toMatch(/passed its monthly budget/);
    expect(recordTurn(store, '/work/app', 1, OCT)).toBeNull();
  });
  it('stays quiet without a limit', () => {
    expect(recordTurn(mem(), '/x', 50, OCT)).toBeNull();
  });
});

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

describe('overview row and live alert', () => {
  async function open() {
    const h = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
        'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'chat:create': { ok: true, id: 'c1', cwd: '/tmp/app', model: '', permissionMode: 'acceptEdits', provider: null },
      },
    });
    await flush();
    return h;
  }
  it('warns once when a finished turn crosses 80% of the folder budget', async () => {
    const h = await open();
    h.window.localStorage.setItem('cce:budgets', JSON.stringify({ '/tmp/app': 10 }));
    const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
    send({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 8.5, usage: {} });
    await flush();
    const ledger = JSON.parse(h.window.localStorage.getItem('cce:spend'));
    expect(ledger.byCwd['/tmp/app']).toBe(8.5);
    expect(h.window.document.body.textContent).toMatch(/app is at 85% of its monthly budget/);
  });
});
