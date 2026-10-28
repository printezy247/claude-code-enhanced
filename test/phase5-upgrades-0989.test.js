// Phase 5 of the 26-item upgrade plan (items 21-26):
//   21. Visual markdown editor — edit + preview + checklists + arrow diagrams
//   22. Browser preview pane — already shipped; locked in by regression greps
//   23. Code review pane — working-tree diff hunks, not just file names
//   24. cce:// deep links — parsed in main, routed to the right view
//   25. Update check — newer GitHub release found and reported honestly
//   26. Translations/i18n — core UI strings in es/de with English fallback
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const deeplink = require('../src/main/deeplink.js');
const updatecheck = require('../src/main/updatecheck.js');
const mdtools = await import('../src/renderer/app/mdtools.js');
const i18n = await import('../src/renderer/i18n.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let booted = null;
async function bootMain() {
  if (booted) return booted;
  const stub = require('electron');
  stub.__reset();
  require('../src/main/main.js');
  await sleep(250);
  booted = stub;
  return booted;
}

// ---------- 21. visual markdown editor ------------------------------------------

describe('visual markdown editor (item 21)', () => {
  it('toggles a checklist line in the source', () => {
    expect(mdtools.toggleTaskLine('- [ ] buy milk')).toBe('- [x] buy milk');
    expect(mdtools.toggleTaskLine('- [x] buy milk')).toBe('- [ ] buy milk');
    expect(mdtools.toggleTaskLine('- plain bullet')).toBe('- plain bullet');
    expect(mdtools.toggleTaskLine('')).toBe('');
  });

  it('parses an arrow chain into nodes and edges', () => {
    const g = mdtools.parseFlow('build -> test -> ship');
    expect(g.nodes).toEqual(['build', 'test', 'ship']);
    expect(g.edges).toEqual([['build', 'test'], ['test', 'ship']]);
    expect(mdtools.parseFlow('nothing here').nodes).toEqual([]);
  });

  it('renders the arrow chain as an SVG diagram', () => {
    const g = mdtools.parseFlow('a -> b -> c');
    const svg = mdtools.flowSvg(g);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('a');
    expect(svg).toContain('c');
    expect(svg).toContain('<rect');   // boxes, not raw text
  });

  it('the editor modal exists and Files rows can open it', () => {
    const src = read('src/renderer/app/mdedit.js');
    expect(src).toMatch(/openMdEditor/);
    expect(src).toMatch(/marked|DOMPurify|innerHTML/);
    const ov = read('src/renderer/app/overview.js');
    expect(ov).toMatch(/openMdEditor/);
  });
});

// ---------- 22. preview pane (regression lock) ------------------------------------

describe('browser preview pane (item 22)', () => {
  it('stays a sandboxed localhost-only iframe with an escape hatch', () => {
    const ov = read('src/renderer/app/overview.js');
    expect(ov).toMatch(/kind === 'preview'/);
    expect(ov).toMatch(/previewHost/);                       // localhost/file gate
    expect(ov).toMatch(/['"]sandbox['"], ['"]allow-scripts allow-forms allow-same-origin['"]/);
    expect(ov).toMatch(/shell:openExternal/);                // ↗ open for outside URLs
    expect(read('src/renderer/index.html')).toMatch(/data-kind="preview"/);
  });
});

// ---------- 23. code review pane ------------------------------------------------------

describe('code review pane (item 23)', () => {
  it('a Review tab exists and renders the working-tree diff', () => {
    expect(read('src/renderer/index.html')).toMatch(/data-kind="review"/);
    const ov = read('src/renderer/app/overview.js');
    expect(ov).toMatch(/kind === 'review'/);
    expect(ov).toMatch(/git:diff/);                          // real hunks, not just names
  });

  it('preload allowlists what the pane needs', () => {
    const pl = read('src/preload/preload.js');
    expect(pl).toContain("'git:diff'");
    expect(pl).toContain("'git:diff-stats'");
  });
});

// ---------- 24. cce:// deep links -------------------------------------------------------

describe('cce:// deep links (item 24)', () => {
  it('parses the three link shapes', () => {
    expect(deeplink.parseCceUrl('cce://chat/abc123')).toEqual({ action: 'chat', id: 'abc123' });
    expect(deeplink.parseCceUrl('cce://view/board')).toEqual({ action: 'view', view: 'board' });
    const open = deeplink.parseCceUrl('cce://open?p=%2Fhome%2Fme%2Fproj');
    expect(open.action).toBe('open');
    expect(open.path).toBe('/home/me/proj');
  });

  it('rejects junk and foreign schemes', () => {
    expect(deeplink.parseCceUrl('https://example.com').action).toBe('unknown');
    expect(deeplink.parseCceUrl('cce://chat/../../etc').action).toBe('unknown');
    expect(deeplink.parseCceUrl('').action).toBe('unknown');
    expect(deeplink.parseCceUrl('cce://view/../../settings').action).toBe('unknown');
  });

  it('main registers the protocol and listens for links', () => {
    const src = read('src/main/main.js');
    expect(src).toMatch(/setAsDefaultProtocolClient\('cce'\)/);
    expect(src).toMatch(/open-url/);
    expect(src).toMatch(/deeplink\.parseCceUrl/);
  });
});

// ---------- 25. update check -------------------------------------------------------------

describe('update check (item 25)', () => {
  it('isNewer compares dotted versions numerically', () => {
    expect(updatecheck.isNewer('0.9.90', '0.9.89')).toBe(true);
    expect(updatecheck.isNewer('0.9.89', '0.9.89')).toBe(false);
    expect(updatecheck.isNewer('0.9.10', '0.9.9')).toBe(true);   // not string order
    expect(updatecheck.isNewer('0.9.89', '0.10.0')).toBe(false);
  });

  it('check() reads the latest release with an injected fetch (no network in tests)', async () => {
    const fake = async (url) => ({
      ok: true,
      json: async () => ({ tag_name: 'v0.9.99', html_url: 'https://github.com/x/y/releases/tag/v0.9.99', name: '0.9.99' }),
    });
    const r = await updatecheck.check({ current: '0.9.89', fetchImpl: fake });
    expect(r.updateAvailable).toBe(true);
    expect(r.latest).toBe('0.9.99');
    expect(r.url).toContain('github.com');
    const none = await updatecheck.check({
      current: '0.9.89',
      fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.9.89' }) }),
    });
    expect(none.updateAvailable).toBe(false);
    // A failed fetch is an honest error, not a fake "up to date".
    const down = await updatecheck.check({ current: '0.9.89', fetchImpl: async () => { throw new Error('offline'); } });
    expect(down.error).toBeTruthy();
    expect(down.updateAvailable).toBe(false);
  });

  it('the IPC channel and the Settings card exist', async () => {
    const stub = await bootMain();
    expect(typeof stub.__state.handlers.get('update:check')).toBe('function');
    const pl = read('src/preload/preload.js');
    expect(pl).toContain("'update:check'");
    expect(read('src/renderer/app/settings.js')).toMatch(/Check for updates/);
  });
});

// ---------- 26. translations / i18n ---------------------------------------------------------

describe('translations/i18n (item 26)', () => {
  it('es and de carry every key en has (no half-translated UI)', () => {
    const missing = i18n.incompleteLocales();
    expect(missing).toEqual([]);
  });

  it('t() falls back to English for unknown keys and unknown locales', () => {
    i18n.setLang('en');
    expect(i18n.t('nav.conversations')).toBe('Conversations');
    i18n.setLang('de');
    expect(i18n.t('nav.conversations')).not.toBe('Conversations');
    i18n.setLang('xx');
    expect(i18n.t('nav.conversations')).toBe('Conversations');   // unknown locale → en
    expect(i18n.t('no.such.key')).toBe('no.such.key');           // unknown key → the key itself
    i18n.setLang('en');
  });

  it('the Settings language picker is wired and nav labels carry data-i18n', () => {
    expect(read('src/renderer/app/settings.js')).toMatch(/Language|language/);
    expect(read('src/renderer/index.html')).toMatch(/data-i18n="nav\.conversations"/);
  });
});
