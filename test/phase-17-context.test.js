// 0.26.0: keeping the context window in view: big-output search, biggest tool results,
// retry-loop warning, compaction facts, and /doctor.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const C = require('../src/shared/ctxtools.js');
const D = require('../src/shared/doctor.js');
const { maskText } = require('../src/shared/secrets.js');
const read = (p) => readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('big output', () => {
  it('describes size and lines', () => {
    expect(C.describeOutput('a\nb\nc').label).toBe('5 B · 3 lines');
    expect(C.describeOutput('x'.repeat(56 * 1024)).label).toMatch(/^56 KB · 1 line$/);
    expect(C.describeOutput('a\n'.repeat(1239)).label).toMatch(/1,240 lines$/);
  });
  it('finds matching lines with their numbers, case-insensitively, capped', () => {
    const text = ['alpha', 'Beta error', 'gamma', 'ERROR again'].join('\n');
    expect(C.filterLines(text, 'error').shown).toEqual([{ n: 2, text: 'Beta error' }, { n: 4, text: 'ERROR again' }]);
    expect(C.filterLines(text, '').matches).toBe(0);
    const many = Array.from({ length: 500 }, () => 'hit').join('\n');
    const r = C.filterLines(many, 'hit', 200);
    expect(r.shown).toHaveLength(200);
    expect(r.matches).toBe(500);
  });
  it('the tool card offers search and copy above 8000 characters', () => {
    const src = read('src/renderer/chat/tools.js');
    expect(src).toMatch(/BIG_OUTPUT_CHARS = 8000/);
    expect(src).toMatch(/Search this output/);
    expect(src).toMatch(/full\.length > BIG_OUTPUT_CHARS\) attachBigOutput/);
  });
});

describe('biggest tool results', () => {
  it('ranks by size and estimates tokens', () => {
    const top = C.topConsumers([{ label: 'a', chars: 400 }, { label: 'b', chars: 4000 }, { label: 'c', chars: 0 }, { label: 'd', chars: 40 }], 2);
    expect(top.map((x) => x.label)).toEqual(['b', 'a']);
    expect(top[0].tokens).toBe(1000);
  });
  it('is shown in the context popover and fed by tool results', () => {
    expect(read('src/renderer/chat/ctxpop.js')).toMatch(/topConsumers\(chat\.toolSizes, 5\)/);
    expect(read('src/renderer/chat/tools.js')).toMatch(/trackContextCost\(chat, ctx, text/);
  });
});

describe('retry loop', () => {
  const k = C.retryKey('Bash', { command: 'npm test' });
  it('trips once on the third identical failure in a row', () => {
    const t = C.createRetryTracker(3);
    expect([t.note(k, true), t.note(k, true), t.note(k, true), t.note(k, true)]).toEqual([false, false, true, false]);
  });
  it('a success or a different call resets the streak', () => {
    const t = C.createRetryTracker(3);
    t.note(k, true); t.note(k, true);
    expect(t.note(k, false)).toBe(false);
    t.note(k, true); t.note(k, true);
    expect(t.note(C.retryKey('Bash', { command: 'ls' }), true)).toBe(false);
    expect(t.streak).toBe(1);
  });
  it('same tool with different input is a different call', () => {
    expect(C.retryKey('Bash', { command: 'a' })).not.toBe(C.retryKey('Bash', { command: 'b' }));
  });
});

describe('compaction summary facts', () => {
  const text = '1. Primary Request and Intent:\n   Fix src/main/chats.js and test/a.test.js\n2. Key Technical Concepts:\n## Files\n- `package.json` edited';
  it('lists sections and the files it names', () => {
    const f = C.summaryFacts(text);
    expect(f.sections).toEqual(['Primary Request and Intent', 'Key Technical Concepts', 'Files']);
    expect(f.files).toEqual(expect.arrayContaining(['src/main/chats.js', 'test/a.test.js', 'package.json']));
  });
  it('is empty for plain text', () => {
    expect(C.summaryFacts('nothing here')).toEqual({ files: [], sections: [] });
  });
  it('is drawn under the summary and the boundary note says how big it was', () => {
    expect(read('src/renderer/chat/transcript.js')).toMatch(/summaryFacts\(text\)/);
    expect(read('src/renderer/chat/events.js')).toMatch(/pre_tokens/);
  });
});

describe('/doctor', () => {
  const ok = { claude: { found: true, version: '2.1.0' }, auth: 'account login', mcp: { live: 3, failed: 0, auth: 4 }, tools: [{ name: 'rg', found: true }], sandbox: true, ctx: { percentage: 20 } };
  it('all good scores 100 except where a setting is simply off', () => {
    const checks = D.buildChecks(ok);
    expect(checks.every((c) => c.level === 'ok')).toBe(true);
    expect(D.score(checks)).toBe(100);
  });
  it('flags a missing CLI, a failed sign-in, failed connectors, missing tools and a full window', () => {
    const checks = D.buildChecks({ ...ok, claude: { found: false }, authFailed: true, mcp: { live: 1, failed: 2, auth: 0 }, tools: [{ name: 'rg', found: false }], sandbox: false, ctx: { percentage: 95 } });
    const lv = Object.fromEntries(checks.map((c) => [c.name, c.level]));
    expect(lv).toMatchObject({ 'Claude Code CLI': 'bad', 'Sign-in': 'bad', Connectors: 'warn', 'Helper tools': 'warn', Sandbox: 'warn', 'Context window': 'bad' });
    expect(D.score(checks)).toBeLessThan(50);
  });
  it('the report masks secrets and refuses to be built without a masker', () => {
    const checks = [{ name: 'X', level: 'ok', detail: 'https://h/api?token=abc123secret' }];
    const r = D.reportText(checks, { appVersion: '1' }, maskText);
    expect(r).not.toMatch(/abc123secret/);
    expect(r).toMatch(/\[ok\]/);
    expect(() => D.reportText(checks, {})).toThrow();
  });
  it('is a slash command', () => {
    expect(read('src/renderer/chat/slash.js')).toMatch(/cmd === '\/doctor'/);
    expect(read('src/renderer/chat/slash.js')).toMatch(/name: 'doctor'/);
  });
});
