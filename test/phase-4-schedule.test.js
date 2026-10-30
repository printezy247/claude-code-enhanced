// @vitest-environment jsdom
// Phase 4.3: scheduled prompts. Pure timing rules, run history, and the list on the Board.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { parseWhen, nextRun, dueTasks, recordRun, loadTasks, saveTasks, MAX_HISTORY } from '../src/renderer/chat/schedule.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');
beforeEach(() => localStorage.clear());

const at = (h, m, day = 1) => new Date(2026, 0, day, h, m, 0).getTime();

describe('parseWhen', () => {
  it.each([
    ['every 30m', { every: 30 }],
    ['every 2h', { every: 120 }],
    ['hourly', { every: 60 }],
    ['daily 09:00', { daily: 540 }],
    ['daily 9:05', { daily: 545 }],
  ])('%s', (s, out) => expect(parseWhen(s)).toEqual(out));
  it.each(['', 'every', 'every 0m', 'every 5s', 'daily 25:00', 'daily 9', 'whenever', 'every 99999h'])('refuses %s', (s) => expect(parseWhen(s)).toBe(null));
  it('does not allow runs more often than every 5 minutes', () => expect(parseWhen('every 1m')).toBe(null));
});

describe('nextRun', () => {
  it('every N minutes counts from the last run', () => {
    expect(nextRun({ every: 30 }, at(10, 0), at(9, 0))).toBe(at(10, 30));
  });
  it('a task never run starts one interval after it was made', () => {
    expect(nextRun({ every: 60 }, 0, at(9, 0))).toBe(at(10, 0));
  });
  it('daily picks today if the time has not passed, else tomorrow', () => {
    expect(nextRun({ daily: 540 }, 0, at(8, 0))).toBe(at(9, 0));
    expect(nextRun({ daily: 540 }, 0, at(10, 0))).toBe(at(9, 0, 2));
  });
});

describe('dueTasks', () => {
  const mk = (over) => ({ id: 't', name: 'n', prompt: 'p', cwd: '/w', when: 'every 30m', enabled: true, createdAt: at(9, 0), lastRun: 0, history: [], ...over });
  it('lists enabled tasks whose time has come', () => {
    expect(dueTasks([mk({})], at(9, 31)).map((t) => t.id)).toEqual(['t']);
    expect(dueTasks([mk({})], at(9, 10))).toEqual([]);
  });
  it('skips disabled tasks and tasks with a bad schedule', () => {
    expect(dueTasks([mk({ enabled: false })], at(12, 0))).toEqual([]);
    expect(dueTasks([mk({ when: 'bogus' })], at(12, 0))).toEqual([]);
  });
  it('a long absence runs a task once, not once per missed slot', () => {
    expect(dueTasks([mk({})], at(20, 0)).length).toBe(1);
  });
});

describe('history', () => {
  it('records result and time, newest first, capped', () => {
    let t = { id: 't', history: [], lastRun: 0 };
    for (let i = 0; i < MAX_HISTORY + 3; i++) t = recordRun(t, { ok: true, text: 'r' + i }, 1000 + i);
    expect(t.history.length).toBe(MAX_HISTORY);
    expect(t.history[0].text).toBe('r' + (MAX_HISTORY + 2));
    expect(t.lastRun).toBe(1000 + MAX_HISTORY + 2);
  });
  it('keeps failures and truncates long text', () => {
    const t = recordRun({ id: 't', history: [], lastRun: 0 }, { ok: false, text: 'x'.repeat(5000) }, 5);
    expect(t.history[0].ok).toBe(false);
    expect(t.history[0].text.length).toBeLessThanOrEqual(2000);
  });
});

describe('storage', () => {
  it('round-trips and survives junk', () => {
    saveTasks([{ id: 'a', name: 'A', prompt: 'p', cwd: '/w', when: 'hourly', enabled: true, createdAt: 1, lastRun: 0, history: [] }]);
    expect(loadTasks()[0].id).toBe('a');
    localStorage.setItem('schedule:tasks', '{nope');
    expect(loadTasks()).toEqual([]);
  });
});

describe('Board list', () => {
  it('adds a task, runs it read-only, shows the history, and deletes it', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': (p) => ({ ok: true, id: p && p.permissionMode === 'plan' ? 'k1' : 'c1', cwd: '/work/proj', model: '', permissionMode: (p && p.permissionMode) || 'default', provider: null }),
      'chat:send': { ok: true }, 'chat:close': { ok: true },
      'chats:board': { ok: true, rows: [] }, 'jobs:list': { ok: true, jobs: [] }, 'runs:interrupted': { ok: true, runs: [] }, 'engines:list': { ok: true, engines: [] },
    } });
    await flush(4);
    const w = h.window;
    w.switchView('board');
    await flush(6);
    const d = w.document;
    d.querySelector('#sched-name').value = 'Morning check';
    d.querySelector('#sched-prompt').value = 'summarise yesterday\'s commits';
    d.querySelector('#sched-when').value = 'daily 09:00';
    d.querySelector('#sched-add').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(4);
    expect(d.querySelectorAll('.sched-row').length).toBe(1);
    d.querySelector('.sched-run').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(6);
    const made = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(made.payload.permissionMode).toBe('plan');            // read-only: nothing can be approved unattended
    w.Chat.handleEvent({ id: 'k1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'three commits' }] } } });
    w.Chat.handleEvent({ id: 'k1', kind: 'message', msg: { type: 'result', subtype: 'success', is_error: false, result: 'ok' } });
    await flush(6);
    expect(d.querySelector('.sched-row').textContent).toContain('three commits');
    d.querySelector('.sched-del').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(2);
    expect(d.querySelectorAll('.sched-row').length).toBe(0);
  });
});
