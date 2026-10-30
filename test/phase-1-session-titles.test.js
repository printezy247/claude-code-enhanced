// Phase 1.5: the CLI's own session title names the chat once; a name the user
// typed is never overwritten.
import { describe, it, expect } from 'vitest';
import { cliTitleOf, applyCliTitle, markManualTitle } from '../src/renderer/chat/titles.js';

const mkChat = (extra) => ({
  tabEl: { firstChild: { textContent: '⌘ fix the login' } },
  titleEl: { textContent: 'fix the login' },
  titled: true,
  ...extra,
});

describe('cliTitleOf', () => {
  it('prefers the custom title, then the summary', () => {
    expect(cliTitleOf({ customTitle: 'Mine', summary: 'Auto' })).toBe('Mine');
    expect(cliTitleOf({ summary: 'Auto title' })).toBe('Auto title');
  });
  it('ignores empty or missing info and the raw first prompt', () => {
    expect(cliTitleOf(null)).toBe('');
    expect(cliTitleOf({ summary: '   ' })).toBe('');
    expect(cliTitleOf({ summary: 'fix the login', firstPrompt: 'fix the login' })).toBe('');
  });
  it('collapses whitespace and caps the length', () => {
    expect(cliTitleOf({ summary: 'a\n  b' })).toBe('a b');
    expect(cliTitleOf({ summary: 'x'.repeat(200) }).length).toBeLessThanOrEqual(40);
  });
});

describe('applyCliTitle', () => {
  it('names the tab and the header once', () => {
    const c = mkChat();
    expect(applyCliTitle(c, { summary: 'Fix login redirect' })).toBe(true);
    expect(c.tabEl.firstChild.textContent).toBe('⌘ Fix login redirect');
    expect(c.titleEl.textContent).toBe('Fix login redirect');
    expect(applyCliTitle(c, { summary: 'Something else' })).toBe(false);
    expect(c.titleEl.textContent).toBe('Fix login redirect');
  });
  it('never overwrites a manual rename', () => {
    const c = mkChat();
    markManualTitle(c, 'My name');
    expect(applyCliTitle(c, { summary: 'Auto' })).toBe(false);
    expect(c.titleEl.textContent).toBe('My name');
  });
  it('does nothing without a usable title', () => {
    const c = mkChat();
    expect(applyCliTitle(c, {})).toBe(false);
    expect(c.titleEl.textContent).toBe('fix the login');
    expect(c.cliTitled).toBeFalsy();
  });
  it('keeps the first-turn text when the CLI has nothing yet, then accepts a later title', () => {
    const c = mkChat();
    applyCliTitle(c, {});
    expect(applyCliTitle(c, { summary: 'Later' })).toBe(true);
  });
});

describe('wiring', () => {
  it('session:title is a known, schema-checked channel', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const fs = req('node:fs');
    expect(fs.readFileSync(new URL('../src/preload/preload.js', import.meta.url), 'utf8')).toContain("'session:title'");
    expect(fs.readFileSync(new URL('../src/main/ipcschemas.js', import.meta.url), 'utf8')).toContain("'session:title'");
  });
});
