// Compacting shell output before the model reads it.
//
// A build log can print 200k characters; the model paid for every token of
// it. The compaction keeps a usable head and tail, collapses repeated lines
// and says how much was dropped — and the card in the UI keeps the original,
// so nothing is hidden from the user.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compactBashOutput, collapseRepeats, toolResultText, DEFAULT_MAX_CHARS } = require('../src/main/toolfilter.js');

describe('reading a tool result', () => {
  it('reads plain text', () => {
    expect(toolResultText('hello')).toBe('hello');
  });

  it('reads a block array', () => {
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });

  it('reads a stdout/stderr object', () => {
    expect(toolResultText({ stdout: 'out', stderr: 'err' })).toBe('out\nerr');
  });

  it('never throws on a shape it does not know', () => {
    expect(toolResultText(null)).toBe('');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText(42)).toBe('42');
  });
});

describe('collapsing repeated lines', () => {
  it('turns a run of identical lines into one line plus a count', () => {
    const out = collapseRepeats('x\nx\nx\nx\ny');
    expect(out.split('\n').length).toBe(2);
    expect(out).toContain('(×4');
    expect(out).toContain('y');
  });

  it('leaves a short run alone', () => {
    expect(collapseRepeats('x\nx\ny')).toBe('x\nx\ny');
  });
});

describe('compacting shell output', () => {
  it('leaves short output untouched', () => {
    const r = compactBashOutput({ output: 'all good\n', maxChars: 8000 });
    expect(r.compacted).toBe(false);
    expect(r.text).toBe('all good\n');
    expect(r.original).toBe('all good\n');
  });

  it('keeps the head and the tail of a long output and says how much was dropped', () => {
    const body = Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n');
    const r = compactBashOutput({ output: body, command: 'npm test', maxChars: 2000 });
    expect(r.compacted).toBe(true);
    expect(r.original).toBe(body);
    expect(r.text).toContain('line 0');
    expect(r.text).toContain('line 399');
    expect(r.text).toMatch(/characters elided/);
    expect(r.text).toContain('npm test');
  });

  it('stays inside the budget', () => {
    const body = 'x'.repeat(50000);
    const r = compactBashOutput({ output: body, maxChars: 2000 });
    expect(r.text.length).toBeLessThanOrEqual(2000);
  });

  it('collapses a repetitive build log before cutting it', () => {
    const body = Array.from({ length: 2000 }, () => 'same line').join('\n');
    const r = compactBashOutput({ output: body, maxChars: 2000 });
    expect(r.text).toContain('identical lines');
  });

  it('never returns more than the budget, even with a huge header', () => {
    const r = compactBashOutput({ output: 'y'.repeat(100000), command: 'z'.repeat(5000), maxChars: 1000 });
    expect(r.text.length).toBeLessThanOrEqual(1000);
  });

  it('never hands the model more than the budget, even with a long command', () => {
    // The budget is a promise: the text the model reads never exceeds it —
    // not at the smallest budget, where a long command in the header leaves
    // the body almost nothing. #N2
    for (const limit of [500, 800, 2000, 20000]) {
      for (const cmdLen of [0, 40, 200, 600]) {
        const r = compactBashOutput({
          output: 'y'.repeat(200000),
          command: 'x'.repeat(cmdLen),
          maxChars: limit,
        });
        expect(r.text.length,
          'over the budget at ' + limit + ' with a ' + cmdLen + '-char command')
          .toBeLessThanOrEqual(limit);
      }
    }
  });

  it('has a default budget', () => {
    expect(DEFAULT_MAX_CHARS).toBe(8000);
    const r = compactBashOutput({ output: 'q'.repeat(DEFAULT_MAX_CHARS + 100) });
    expect(r.compacted).toBe(true);
  });

  it('clamps a budget that is out of range', () => {
    // 999999 is out of range: the promise the Settings row makes is 500…100000.
    // A 200k output must not be handed to the model whole.
    const r = compactBashOutput({ output: 'x'.repeat(200000), maxChars: 999999 });
    expect(r.compacted).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100000);
  });

  it('clamps a budget that is below the range', () => {
    const r = compactBashOutput({ output: 'x'.repeat(2000), maxChars: 10 });
    expect(r.compacted).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(2000);
  });

  it('gives the model more text when the budget is raised', () => {
    // The knob said "characters of shell output the model may read" and did
    // nothing above ~2700: the head and the tail were capped at 1200 each.
    const body = 'x'.repeat(50000);
    const small = compactBashOutput({ output: body, maxChars: 2000 });
    const big = compactBashOutput({ output: body, maxChars: 20000 });
    expect(small.text.length, 'the budget did not change the text').toBeLessThan(big.text.length);
    expect(big.text.length, 'a 20000 budget still gave the model ~2500 chars').toBeGreaterThan(15000);
    // And the text the model reads never leaves the budget.
    expect(small.text.length).toBeLessThanOrEqual(2000);
    expect(big.text.length).toBeLessThanOrEqual(20000);
  });

  it('states the real size of the text the model reads', () => {
    const r = compactBashOutput({ output: 'z'.repeat(50000), command: 'npm test', maxChars: 4000 });
    const m = /model sees (\d+) chars/.exec(r.text);
    expect(m, 'the header states no size: ' + r.text.slice(0, 140)).toBeTruthy();
    expect(Number(m[1]), 'the header lies about the size').toBe(r.text.length);
    expect(r.text.length).toBeLessThanOrEqual(4000);
  });
});
