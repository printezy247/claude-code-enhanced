// The "jump to latest" button: it appears when the transcript is scrolled away
// from the live end, and clicking it returns to the newest response.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

let h;
const ipc = {
  'app:info': { ok: true, appVersion: '0.0.0', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
};

beforeEach(async () => {
  h = loadRenderer({ ipc });
  await flush(4);
});

const btn = () => h.window.document.querySelector('.chat-latest');
const msgs = () => h.window.document.querySelector('.chat-msgs');

/** jsdom has no layout, so the scroll metrics are stubbed. */
const setScroll = (scrollTop, scrollHeight, clientHeight) => {
  const m = msgs();
  Object.defineProperty(m, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(m, 'clientHeight', { value: clientHeight, configurable: true });
  m.scrollTop = scrollTop;
  m.dispatchEvent(new h.window.Event('scroll'));
};

describe('jump to latest', () => {
  it('is hidden while the view is at the live end', () => {
    setScroll(900, 1000, 100);   // 1000-900-100 = 0 -> at the bottom
    expect(btn().classList.contains('hidden')).toBe(true);
  });

  it('appears once the user scrolls up', () => {
    setScroll(0, 1000, 100);     // 1000-0-100 = 900 -> away from the bottom
    expect(btn().classList.contains('hidden')).toBe(false);
  });

  it('jumps to the newest response and re-arms auto-follow', () => {
    setScroll(0, 1000, 100);
    expect(btn().classList.contains('hidden')).toBe(false);

    btn().click();

    expect(msgs().scrollTop).toBe(1000);
    expect(btn().classList.contains('hidden')).toBe(true);
  });

  it('has an accessible name', () => {
    expect(btn().getAttribute('aria-label')).toMatch(/latest/i);
    expect(btn().textContent.trim().length).toBeGreaterThan(0);
  });
});

describe('jump to latest icon', () => {
  it('paints the chevron SVG', () => {
    const b = btn();
    const svg = b.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('jump to latest keyboard shortcut', () => {
  it('End in the composer returns to the newest response', () => {
    setScroll(0, 1000, 100);
    expect(btn().classList.contains('hidden')).toBe(false);

    const composer = h.window.document.querySelector('.chat-input');
    composer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));

    expect(msgs().scrollTop).toBe(1000);
    expect(btn().classList.contains('hidden')).toBe(true);
  });
});
