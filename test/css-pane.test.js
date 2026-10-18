// The chat pane must keep .term-pane's absolute fill: a later same-specificity
// `position` rule on .chat-pane collapses the chat to content height (the whole
// pane stops filling #terminals). #fix-pane-fill
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

const rule = (selector) => {
  const at = css.indexOf(selector + ' {');
  expect(at, 'rule missing: ' + selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

describe('chat pane keeps the absolute fill (#fix-pane-fill)', () => {
  it('.term-pane is absolutely positioned to fill #terminals', () => {
    expect(rule('.term-pane')).toMatch(/position:\s*absolute/);
    expect(rule('.term-pane')).toMatch(/inset:\s*0/);
  });

  it('.chat-pane does not override position', () => {
    // every .chat-pane rule block must be position-free
    const re = /\.chat-pane\s*\{[^}]*\}/g;
    for (const m of css.match(re) || []) {
      expect(m, 'chat-pane rule must not set position').not.toMatch(/position:/);
    }
  });
});
