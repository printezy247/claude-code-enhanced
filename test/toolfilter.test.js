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
    expect(r.text.length).toBeLessThanOrEqual(2400);
  });

  it('collapses a repetitive build log before cutting it', () => {
    const body = Array.from({ length: 2000 }, () => 'same line').join('\n');
    const r = compactBashOutput({ output: body, maxChars: 2000 });
    expect(r.text).toContain('identical lines');
  });

  it('never returns more than the budget, even with a huge header', () => {
    const r = compactBashOutput({ output: 'y'.repeat(100000), command: 'z'.repeat(5000), maxChars: 1000 });
    expect(r.text.length).toBeLessThanOrEqual(1400);
  });

  it('has a default budget', () => {
    expect(DEFAULT_MAX_CHARS).toBe(8000);
    const r = compactBashOutput({ output: 'q'.repeat(DEFAULT_MAX_CHARS + 100) });
    expect(r.compacted).toBe(true);
  });
});
