// Shift+Enter inside a list line continues the list; on an empty item it ends it.
import { describe, it, expect } from 'vitest';
import { continueList } from '../src/renderer/chat/listkeys.js';

const at = (value, caret = value.length) => continueList(value, caret);

describe('continueList', () => {
  it('bullets keep their marker', () => {
    expect(at('- one')).toEqual({ value: '- one\n- ', caret: 8 });
    expect(at('* one')).toEqual({ value: '* one\n* ', caret: 8 });
  });
  it('numbers count up', () => {
    expect(at('1. one')).toEqual({ value: '1. one\n2. ', caret: 10 });
    expect(at('9. nine')).toEqual({ value: '9. nine\n10. ', caret: 12 });
  });
  it('indent is kept', () => {
    expect(at('  - sub')).toEqual({ value: '  - sub\n  - ', caret: 12 });
  });
  it('an empty item ends the list instead', () => {
    expect(at('- one\n- ')).toEqual({ value: '- one\n', caret: 6 });
    expect(at('1. a\n2. ')).toEqual({ value: '1. a\n', caret: 5 });
  });
  it('works in the middle of the text and splits the line at the caret', () => {
    const r = at('- ab\nnext', 4);
    expect(r.value).toBe('- ab\n- \nnext');
    expect(r.caret).toBe(7);
    expect(at('- abcd', 4)).toEqual({ value: '- ab\n- cd', caret: 7 });
  });
  it('plain lines and checkbox-free text are left to the browser', () => {
    expect(at('hello')).toBeNull();
    expect(at('')).toBeNull();
    expect(at('-no space')).toBeNull();
    expect(at('2024. a year')).toEqual({ value: '2024. a year\n2025. ', caret: 19 });
  });
});
