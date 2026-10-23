// Phase B — icons (#54). The emoji that used to be icons render at different
// sizes per platform, cannot inherit colour (so they ignored the theme), and
// are announced by screen readers before the label they sit next to. These
// tests pin the replacement: one stroke family, themeable, decorative.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const icons = require('../src/shared/icons.js');

const ROOT = join(__dirname, '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/**
 * COLOUR emoji only. These render as full-colour glyphs whose appearance the OS
 * chooses, which is what made the old icons inconsistent.
 *
 * CJK dingbats (★ ✓ ⚠ ✂ ✻ ➤) are deliberately allowed: they are monochrome text
 * symbols that render identically everywhere, and several of them are CONTENT —
 * a model rating, or a sentence marker — not an affordance. #54 replaced the
 * ones that were doing an icon's job; the rest are text.
 */
const COLOUR_EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}]/u;

describe('the icon set itself', () => {
  it('has a name for every icon the UI asks for', () => {
    const src = (read('src/renderer/chat.js') + read('src/renderer/app.js') + read('src/renderer/index.html'))
      // Comments mention the attribute in prose; only real markup counts.
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const asked = new Set([...src.matchAll(/data-icon="([a-zA-Z0-9]+)"/g)].map((m) => m[1]));
    expect(asked.size).toBeGreaterThan(5);
    for (const n of asked) expect(icons.has(n), 'no icon named ' + n).toBe(true);
  });

  it('every path is on the same 24x24 stroked grid', () => {
    const one = icons.svg('terminal');
    expect(one).toContain('viewBox="0 0 24 24"');
    expect(one).toContain('fill="none"');
    expect(one).toContain('stroke="currentColor"');   // so it follows the theme
    expect(one).toContain('stroke-width="2"');
    expect(one).toMatch(/stroke-linecap="round"/);
    // Every absolute coordinate attribute stays inside the 0..24 box. (Relative
    // path commands are skipped: `l5-5` is not a coordinate.)
    for (const name of icons.names()) {
      const body = icons.svg(name);
      const attrs = body.matchAll(/\b(?:x|y|x1|y1|x2|y2|cx|cy|r)="(-?\d+(?:\.\d+)?)"/g);
      for (const [, raw] of attrs) {
        const v = Number(raw);
        expect(v, `${name} has ${raw} outside the viewBox`).toBeGreaterThanOrEqual(-1);
        expect(v, `${name} has ${raw} outside the viewBox`).toBeLessThanOrEqual(25);
      }
      for (const [, pts] of body.matchAll(/points="([^"]+)"/g)) {
        for (const pair of pts.trim().split(/\s+/)) {
          const v = Number(pair.split(',')[0]);
          expect(Number.isFinite(v) && v >= 0 && v <= 24, `${name} point ${pair} outside the box`).toBe(true);
        }
      }
    }
  });

  it('is decorative by default, because the adjacent text is the name', () => {
    const out = icons.svg('gear');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('focusable="false"');   // IE/Edge focus trap
  });

  it('an unknown name renders nothing rather than a broken icon', () => {
    expect(icons.svg('definitely-not-an-icon')).toBe('');
    expect(icons.has('definitely-not-an-icon')).toBe(false);
  });

  it('is one family: every icon uses stroke geometry, none is a filled blob', () => {
    for (const name of icons.names()) {
      const body = icons.svg(name);
      expect(body, name + ' has fill').not.toMatch(/fill="#/);
      expect(body, name + ' has no stroked shape').toMatch(/<(path|line|polyline|polygon|circle|rect)/);
    }
  });
});

describe('no emoji are left doing icon work (#54)', () => {
  for (const f of ['src/renderer/chat.js', 'src/renderer/app.js', 'src/renderer/index.html', 'src/renderer/providers.js']) {
    it(`${f} contains no emoji`, () => {
      const hits = read(f).match(new RegExp(COLOUR_EMOJI, 'gu')) || [];
      expect(hits, 'emoji left in ' + f + ': ' + [...new Set(hits)].join(' ')).toEqual([]);
    });
  }

  it('the sidebar nav declares icons by name, not by glyph', () => {
    const h = read('src/renderer/index.html');
    expect(h).toMatch(/class="ico" data-icon="layers"/);
    expect(h).toMatch(/class="ico" data-icon="gear"/);
  });
});

describe('declared icons are actually painted (#54)', () => {
  async function boot() {
    const h = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
        'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 100 }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      },
    });
    await flush(10);
    return h;
  }

  it('every nav icon becomes an inline SVG at boot', async () => {
    const h = await boot();
    const navIcons = [...h.window.document.querySelectorAll('.nav-btn .ico')];
    expect(navIcons.length).toBe(5);
    for (const span of navIcons) {
      const svg = span.querySelector('svg');
      expect(svg, 'unpainted icon in the nav').toBeTruthy();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('the sidebar actions, the top-strip buttons and the logo are painted too', async () => {
    const h = await boot();
    for (const sel of ['#qa-new', '#qa-resume', '#qa-reopen', '#btn-sidebar', '#btn-tasks', '#btn-new-window']) {
      expect(h.window.document.querySelector(sel + ' svg'), sel).toBeTruthy();
    }
    // The logo is the app's own mark (inline SVG), not an icon in a span.
    expect(h.window.document.querySelector('svg.logo-mark')).toBeTruthy();
  });

  it('a tool card renders an SVG icon, not an emoji', async () => {
    const h = await boot();
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    });
    await flush();
    const ico = h.window.document.querySelector('.tool-card .tool-ico svg');
    expect(ico, 'tool card has no SVG icon').toBeTruthy();
    expect(ico.getAttribute('class')).toContain('ic-terminal');
  });

  it('an unknown tool still gets the fallback icon rather than a blank', async () => {
    const h = await boot();
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'TotallyMadeUpTool', input: {} }] } },
    });
    await flush();
    const ico = h.window.document.querySelector('.tool-card .tool-ico svg');
    expect(ico).toBeTruthy();
    expect(ico.getAttribute('class')).toContain('ic-wrench');
  });

  it('an MCP tool gets the plug icon', async () => {
    const h = await boot();
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'message',
      msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__github__create_issue', input: {} }] } },
    });
    await flush();
    expect(h.window.document.querySelector('.tool-card .tool-ico svg').getAttribute('class')).toContain('ic-plug');
  });

  it('painting is idempotent, so a re-render cannot nest SVGs', async () => {
    const h = await boot();
    const span = h.window.document.querySelector('.nav-btn .ico');
    h.window.paintDeclaredIcons();
    h.window.paintDeclaredIcons();
    expect(span.querySelectorAll('svg').length).toBe(1);
  });
});