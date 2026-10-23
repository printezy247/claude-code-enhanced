// Phase A — accessibility (P1, #53). Every item here is a measured or
// verifiable defect that was fixed: contrast ratios computed from the palette,
// focus indicators that did not exist, icon-only buttons with no accessible
// name, clickable divs unreachable by keyboard, and dialogs that did not
// declare themselves as dialogs.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const ROOT = join(__dirname, '..');
const css = () => readFileSync(join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
const html = () => readFileSync(join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

// ---- WCAG relative luminance / contrast, computed here so the test is
// independent of any library and states its own threshold.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Pull the token block for a theme out of the stylesheet. */
function tokens(theme) {
  const src = css();
  const re = theme === 'light'
    ? /:root\[data-theme="light"\]\s*\{([^}]*)\}/
    : /:root\s*\{([^}]*)\}/;
  const block = re.exec(src)[1];
  const out = {};
  for (const line of block.split('\n')) {
    const m = /--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('contrast meets WCAG AA in both themes (#53)', () => {
  // AA is 4.5:1 for normal text. Every foreground token is checked against every
  // surface it can be drawn on, which is how the three failures were found.
  for (const theme of ['dark', 'light']) {
    it(`${theme}: every text colour clears 4.5:1 on every surface`, () => {
      const t = tokens(theme);
      const surfaces = ['bg', 'bg2', 'bg3', 'bg4'].map((k) => t[k]);
      const failures = [];
      for (const fg of ['text', 'muted', 'accent', 'ok', 'warn', 'danger']) {
        for (const bg of surfaces) {
          const r = contrast(t[fg], bg);
          if (r < 4.5) failures.push(`${fg} on ${bg} = ${r.toFixed(2)}:1`);
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }

  it('the focus ring itself clears 3:1 (WCAG 2.2 non-text contrast)', () => {
    for (const theme of ['dark', 'light']) {
      const t = tokens(theme);
      const ring = contrast(t.focus, t.bg);
      expect(ring, `focus on bg (${theme}) = ${ring.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      for (const surf of ['bg2', 'bg3', 'bg4']) {
        const r = contrast(t.focus, t[surf]);
        expect(r, `focus on ${surf} (${theme}) = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('the old failing values are gone, so this cannot silently regress', () => {
    const dark = tokens('dark');
    // #d2626a measured 3.69:1 on --bg4 and #d97757 measured 4.36:1.
    expect(dark.danger).not.toBe('#d2626a');
    expect(dark.accent).not.toBe('#d97757');
    expect(contrast(dark.danger, dark.bg4)).toBeGreaterThan(4.5);
    expect(contrast(dark.accent, dark.bg4)).toBeGreaterThan(4.5);
  });
});

describe('focus is always visible (#53)', () => {
  it('a focus-visible rule exists (there were none at all before)', () => {
    expect(css()).toMatch(/^:focus-visible\s*\{/m);
  });

  it('no bare outline:none is left without a replacement indicator', () => {
    // Strip comments first: a `/* … */` line above a rule would otherwise be
    // captured as part of the selector and never match its :focus-visible twin.
    const src = css().replace(/\/\*[\s\S]*?\*\//g, '');
    // `outline: none` is only acceptable in two shapes: narrowed to mouse
    // focus (:not(:focus-visible)), or on a selector that separately has a
    // :focus-visible ring. Anything else hides focus with nothing in its place.
    const offenders = [];
    for (const m of src.matchAll(/([^{}]*)\{([^{}]*outline:\s*none[^{}]*)\}/g)) {
      const selector = m[1].split('}').pop().trim();
      if (!selector || /:focus-visible/.test(selector)) continue;
      if (/:not\(:focus-visible\)/.test(selector)) continue;
      // Accept when every comma-separated part has a :focus-visible counterpart.
      const parts = selector.split(',').map((p) => p.trim()).filter(Boolean);
      const covered = parts.every((part) => {
        const bare = part.replace(/:(not\()?\:?focus\)?/g, '').replace(/\s+/g, '');
        return src.includes(bare + ':focus-visible');
      });
      if (!covered) offenders.push(selector);
    }
    expect(offenders, 'outline:none with no focus-visible replacement: ' + offenders.join(', ')).toEqual([]);
  });

  it('the row, tab and menu controls are in the focus ring list', () => {
    const src = css();
    for (const sel of ['.convo-row:focus-visible', '.tab:focus-visible', '.nav-btn:focus-visible', '.convo-menu-item:focus-visible']) {
      expect(src, sel).toContain(sel);
    }
  });
});

describe('landmarks and live regions (#53)', () => {
  it('the sidebar is a labelled nav landmark', () => {
    expect(html()).toMatch(/<nav id="nav" aria-label="Sections">/);
  });

  it('the active nav item says it is the current page', () => {
    expect(html()).toContain('aria-current="page"');
  });

  it('toasts are a live region, and errors are alerts', async () => {
    expect(html()).toMatch(/id="toasts"[^>]*aria-live="polite"/);
    expect(html()).not.toContain('toast-root');   // one container, not two
    const h = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
        'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      },
    });
    await flush(6);
    h.window.toast('all good', 'ok');
    h.window.toast('it broke', 'err');
    const root = h.window.document.querySelector('#toasts');
    expect(root, 'toasts land in the live region').toBeTruthy();
    expect(root.getAttribute('aria-live')).toBe('polite');
    const [ok, err] = root.querySelectorAll('.toast');
    expect(ok.textContent).toBe('all good');
    // Errors interrupt; plain status messages do not.
    expect(err.getAttribute('role')).toBe('alert');
    expect(ok.getAttribute('role')).toBeNull();
  });

  it('the conversation-count badge is announced politely', () => {
    expect(html()).toMatch(/id="sess-count"[^>]*aria-live="polite"/);
  });

  it('decorative glyphs next to text are hidden from assistive tech', () => {
    // The Usage icon was a colour emoji, announced as "bar chart" before its label.
    expect(html()).not.toMatch(/class="ico">📊/);
    const icons = [...html().matchAll(/<span class="ico"([^>]*)>/g)];
    expect(icons.length).toBeGreaterThan(3);
    // The spans now hold an inline SVG that carries aria-hidden itself, so the
    // requirement is: every declared icon is either an SVG (hidden by the icon
    // helper) or explicitly aria-hidden.
    for (const [, attrs] of icons) {
      const hidden = attrs.includes('aria-hidden="true"') || attrs.includes('data-icon=');
      expect(hidden, 'icon span neither aria-hidden nor a declared SVG: ' + attrs).toBe(true);
    }
    // No glyph left doing an icon's job.
    for (const glyph of ['📊', ['2B3C', 'FE0F'].map(String.fromCharCode).join(''), '⚙', '▤']) {
      expect(html(), 'glyph still used as an icon: ' + glyph).not.toContain('class="ico">' + glyph);
    }
  });
});

describe('dialogs declare themselves (#53)', () => {
  it('every modal overlay sets role=dialog and aria-modal', () => {
    const src = readFileSync(join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const overlays = src.match(/el\('div', 'modal-overlay'\)/g) || [];
    expect(overlays.length).toBeGreaterThanOrEqual(4);
    const withRole = src.match(/overlay\.setAttribute\('role', 'dialog'\)/g) || [];
    expect(withRole.length).toBe(overlays.length);
    expect((src.match(/overlay\.setAttribute\('aria-modal', 'true'\)/g) || []).length).toBe(overlays.length);
  });
});

describe('icon-only buttons have an accessible name (#53)', () => {
  it('each glyph-only button in app.js and chat.js carries aria-label', () => {
    let total = 0;
    for (const f of ['src/renderer/app.js', 'src/renderer/chat.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      // A button whose only content is a glyph, not a word.
      const glyphOnly = src.match(/el\('button', '[^']+', '(?:✕|▾|▶|■|✻|⏹|⇧|⋯|✎|⧉|⚙|↻|↶|＋)'\)/g) || [];
      total += glyphOnly.length;
      // Each one must be followed nearby by an aria-label assignment.
      for (const m of glyphOnly) {
        const at = src.indexOf(m);
        const after = src.slice(at, at + 260);
        expect(after, f + ' :: ' + m).toMatch(/setAttribute\('aria-label'/);
      }
    }
    // The pattern still finds something, so the check cannot pass vacuously.
    expect(total, 'glyph-only buttons found').toBeGreaterThan(0);
  });
});

describe('conversation rows are keyboard-operable (#53)', () => {
  const SESSIONS = [
    { cwd: '/home/jack/alpha', sessionId: 'a1', mtime: Date.now() - 3600e3, preview: 'the row to test' },
  ];
  async function boot() {
    const h = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
        'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
        'chats:index': { ok: true, sessions: SESSIONS },
        'usage:scan': { ok: true, days: [], total: 0, sessions: 0 },
      },
    });
    await flush(10);
    h.window.switchView('conversations');
    h.window.toggleConversations(true);
    await flush(10);
    return h;
  }

  it('a row is focusable and announced as a button with a name', async () => {
    const h = await boot();
    const row = h.window.document.querySelector('.convo-row');
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('aria-label')).toContain('the row to test');
  });

  it('Enter opens the conversation', async () => {
    const h = await boot();
    const row = h.window.document.querySelector('.convo-row');
    row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    const created = h.calls.filter((c) => c.channel === 'chat:create');
    expect(created.length).toBeGreaterThan(0);
    expect(created[created.length - 1].payload.resume).toBe('a1');
  });

  it('Space opens the actions menu instead of the conversation', async () => {
    const h = await boot();
    const row = h.window.document.querySelector('.convo-row');
    const before = h.calls.filter((c) => c.channel === 'chat:create').length;
    row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await flush();
    expect(h.window.document.querySelector('.convo-menu')).toBeTruthy();
    expect(h.calls.filter((c) => c.channel === 'chat:create').length).toBe(before);
  });

  it('the actions menu is a menu, and its items are menu items', async () => {
    const h = await boot();
    h.window.document.querySelector('.convo-more').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
    await flush();
    const menu = h.window.document.querySelector('.convo-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    const items = menu.querySelectorAll('.convo-menu-item');
    expect(items.length).toBeGreaterThan(3);
    for (const i of items) expect(i.getAttribute('role')).toBe('menuitem');
  });
});