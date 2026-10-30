// Search across past conversations: date filter and transcript hits mapped to sessions.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dateCutoff, deepMatches, snippet } from '../src/renderer/app/convosearch.js';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const DAY = 86400000;

describe('dateCutoff', () => {
  it('maps a range to the oldest allowed time', () => {
    expect(dateCutoff('day', 1000 * DAY)).toBe(999 * DAY);
    expect(dateCutoff('week', 1000 * DAY)).toBe(993 * DAY);
    expect(dateCutoff('month', 1000 * DAY)).toBe(970 * DAY);
  });
  it('means no limit for any time or an unknown value', () => {
    expect(dateCutoff('', 5)).toBe(0);
    expect(dateCutoff('zzz', 5)).toBe(0);
  });
});

describe('snippet', () => {
  it('cuts around the match and flattens escapes', () => {
    const line = '{"text":"' + 'a'.repeat(100) + ' the NEEDLE is here\\nnext ' + 'b'.repeat(100) + '"}';
    const s = snippet(line, 'needle');
    expect(s).toContain('NEEDLE');
    expect(s).not.toContain('\\n');
    expect(s.length).toBeLessThan(100);
  });
});

describe('deepMatches', () => {
  const sessions = [{ sessionId: 'aaa', preview: 'one' }, { sessionId: 'bbb', preview: 'two' }];
  it('groups hits per session, counts them and skips unknown files', () => {
    const matches = [
      { file: '/h/.claude/projects/p/aaa.jsonl', line: '{"x":"foo bar"}' },
      { file: '/h/.claude/projects/p/aaa.jsonl', line: '{"x":"foo again"}' },
      { file: '/h/.claude/projects/p/zzz.jsonl', line: '{"x":"foo"}' },
      { file: '/h/.claude/projects/p/bbb.jsonl', line: '{"x":"foo"}' },
    ];
    const out = deepMatches(matches, sessions, 'foo');
    expect(out.map(o => [o.session.sessionId, o.count])).toEqual([['aaa', 2], ['bbb', 1]]);
    expect(out[0].snippet).toContain('foo');
  });
  it('honours a session filter', () => {
    const matches = [{ file: '/p/aaa.jsonl', line: 'foo' }, { file: '/p/bbb.jsonl', line: 'foo' }];
    const out = deepMatches(matches, sessions, 'foo', (s) => s.sessionId === 'bbb');
    expect(out).toHaveLength(1);
  });
});

describe('sidebar', () => {
  it('has a date filter', async () => {
    const h = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
        'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
      },
    });
    await flush();
    const sel = h.window.document.querySelector('#convo-drop .convo-date');
    expect(sel).toBeTruthy();
    expect([...sel.options].map(o => o.value)).toEqual(['', 'day', 'week', 'month']);
  });
});
