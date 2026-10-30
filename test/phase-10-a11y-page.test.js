// Found by the Front-End Checklist audit (Accessibility Essentials) run through Lightpanda.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;

describe('page structure', () => {
  it('has exactly one h1, inside main, before the other headings', () => {
    const h1s = doc.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    expect(h1s[0].closest('main')).not.toBeNull();
    expect(doc.querySelector('main').querySelector('h1,h2,h3')).toBe(h1s[0]);
  });
  it('starts with a skip link that lands on the focusable main', () => {
    const first = doc.querySelector('body > a');
    expect(first.getAttribute('href')).toBe('#main');
    expect(first.textContent).toMatch(/skip/i);
    expect(doc.querySelector('#main').getAttribute('tabindex')).toBe('-1');
    expect(css).toMatch(/\.skip-link:focus/);
  });
  it('every visible form control has a name', () => {
    for (const c of doc.querySelectorAll('input:not([type=hidden]),select,textarea')) {
      if (c.getAttribute('aria-hidden') === 'true') continue;
      const named = c.getAttribute('aria-label') || c.getAttribute('aria-labelledby') || c.title
        || (c.id && doc.querySelector('label[for="' + c.id + '"]')) || c.closest('label');
      expect(named, c.outerHTML.slice(0, 80)).toBeTruthy();
    }
  });
});
