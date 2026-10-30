// UI plan item 11: one compact line that says what the chat is doing, where.
import { describe, it, expect } from 'vitest';
import { envStrip } from '../src/renderer/app/envstrip.js';

describe('envStrip', () => {
  it('joins status, model, branch and changes', () => {
    expect(envStrip({ busy: true, alive: true, model: 'sonnet' }, { branch: 'main', dirty: 3 })).toBe('working · sonnet · main · 3 changed');
  });
  it('idle and clean', () => {
    expect(envStrip({ busy: false, alive: true, model: 'opus' }, { branch: 'dev', dirty: 0 })).toBe('idle · opus · dev · clean');
  });
  it('ended chat, no model, no git', () => {
    expect(envStrip({ alive: false }, null)).toBe('ended');
    expect(envStrip({ alive: false }, { isRepo: false })).toBe('ended');
  });
  it('no chat at all gives the branch alone, or nothing', () => {
    expect(envStrip(null, { branch: 'main', dirty: 0 })).toBe('main · clean');
    expect(envStrip(null, null)).toBe('');
  });
});
