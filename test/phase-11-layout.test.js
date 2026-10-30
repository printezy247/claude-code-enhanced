// Two layout bugs from a maximised window: the sidebar nav ran wider than the
// sidebar, and the jump-to-request rail sat under the floating Overview.
// jsdom has no layout, so these pin the CSS rules that fix them.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
const rule = (sel) => { const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}')); return m ? m[1] : ''; };

describe('sidebar nav stays inside the sidebar', () => {
  it('no label on the active button: six icons, tooltips only', () => {
    expect(css).not.toMatch(/#nav \.nav-btn\.active > span:not\(\.ico\):not\(\.badge\) \{ display: inline/);
  });
  it('the six buttons share the row equally and may shrink', () => {
    const r = rule('#nav .nav-btn');
    expect(r).toMatch(/flex:\s*1 1 0/);
    expect(r).toMatch(/min-width:\s*0/);
    expect(r).toMatch(/justify-content:\s*center/);
  });
});

describe('jump rail clears the floating Overview', () => {
  const block = css.slice(css.indexOf('@media (min-width: 1500px)'));
  it('is moved left by the Overview width while the Overview floats', () => {
    expect(block).toMatch(/\.req-rail[^{]*\{[^}]*right:\s*calc\(var\(--ov-w, 304px\) \+ 4px\)/);
  });
  it('its tooltip moves with it', () => {
    expect(block).toMatch(/\.req-tip[^{]*\{[^}]*right:\s*calc\(var\(--ov-w, 304px\) \+ 40px\)/);
  });
  it('only when the Overview is actually shown', () => {
    expect(block).toMatch(/:not\(\.ov-hidden\)[^{]*\.req-rail/);
  });
});
