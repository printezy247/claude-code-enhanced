// @vitest-environment jsdom
// A second application window (window:new) and the shell-output filter the
// main process applies before it hands command output to the model.
//
// The button lives in the tabbar (not the left nav — that one has a fixed
// number of entries), and the filter is a Settings card because it decides
// how much of a command's output the model pays for.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const baseSettings = (over = {}) => ({
  defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, theme: 'dark',
  failoverChain: [], sandbox: {}, ...over,
});

/**
 * A boot-shaped ipc stub. `settings:set` echoes the merged settings back so
 * the renderer keeps a coherent state.settings after a save.
 */
const bootIpc = (settings = baseSettings(), extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings, claude: { found: true, path: '', version: '' } },
  'settings:set': (payload) => ({
    ok: true,
    settings: { ...settings, ...((payload && payload.settings) || {}) },
    claude: { found: true, path: '', version: '' },
  }),
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
  'window:new': { ok: true },
  ...extra,
});

async function boot(settings = baseSettings(), extra = {}) {
  const h = loadRenderer({ ipc: bootIpc(settings, extra) });
  await flush(6);
  return h;
}

const doc = (h) => h.window.document;
const click = (h, n) => n.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
const changed = (h, n) => n.dispatchEvent(new h.window.Event('change'));
const key = (h, k, opts = {}) => h.window.document.dispatchEvent(
  new h.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })
);

describe('new window button', () => {
  it('sits in the tabbar with a non-empty accessible name', async () => {
    const h = await boot();
    const bar = doc(h).querySelector('#tabbar');
    expect(bar, 'no tabbar').toBeTruthy();
    const btn = bar.querySelector('#btn-new-window');
    expect(btn, 'no #btn-new-window in the tabbar').toBeTruthy();
    // It is a tabbar control, not one of the fixed left-nav entries.
    expect(btn.classList.contains('nav-btn')).toBe(false);
    // And it comes before the tab strip it belongs to.
    const kids = [...bar.children];
    expect(kids.indexOf(btn)).toBeLessThan(kids.indexOf(bar.querySelector('#tabs')));
    const name = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
    expect(name.length, 'the button has no accessible name').toBeGreaterThan(0);
    h.window.close();
  });

  it('asks the main process for a new window exactly once', async () => {
    const h = await boot();
    click(h, doc(h).querySelector('#btn-new-window'));
    await flush(6);
    expect(h.calls.filter(c => c.channel === 'window:new').length).toBe(1);
    h.window.close();
  });

  it('Ctrl+Shift+N opens a new window, and Ctrl+Shift+T still starts a session', async () => {
    const h = await boot();
    key(h, 'N', { ctrlKey: true, shiftKey: true });
    await flush(6);
    expect(h.calls.filter(c => c.channel === 'window:new').length).toBe(1);
    // The new-session shortcut is untouched: the two must not claim each other.
    key(h, 'T', { ctrlKey: true, shiftKey: true });
    await flush(4);
    expect(doc(h).querySelector('.modal-overlay'), 'Ctrl+Shift+T no longer opens the new-session dialog').toBeTruthy();
    expect(h.calls.filter(c => c.channel === 'window:new').length).toBe(1);
    h.window.close();
  });

  it('says so when the window cannot be opened', async () => {
    const h = await boot(baseSettings(), { 'window:new': { ok: false, error: 'no window for you' } });
    click(h, doc(h).querySelector('#btn-new-window'));
    await flush(6);
    const err = doc(h).querySelector('#toasts .toast.err');
    expect(err, 'no error toast').toBeTruthy();
    expect(err.textContent).toContain('no window for you');
    h.window.close();
  });
});

describe('shell-output filter settings', () => {
  it('exposes the filter and shows what the store holds', async () => {
    const h = await boot(baseSettings({ outputFilter: 'off' }));
    h.window.switchView('settings');
    const sel = doc(h).querySelector('#opt-outputfilter');
    expect(sel, 'no #opt-outputfilter in the settings panel').toBeTruthy();
    expect(sel.value).toBe('off');
    expect([...sel.options].map(o => o.value)).toEqual(['on', 'off']);
    h.window.close();
  });

  it('defaults to on when the store says nothing', async () => {
    const h = await boot();
    h.window.switchView('settings');
    expect(doc(h).querySelector('#opt-outputfilter').value).toBe('on');
    h.window.close();
  });

  it('saves the new filter through settings:set', async () => {
    const h = await boot(baseSettings({ outputFilter: 'off' }));
    h.window.switchView('settings');
    const sel = doc(h).querySelector('#opt-outputfilter');
    sel.value = 'on';
    changed(h, sel);
    await flush(6);
    const call = h.calls.filter(c => c.channel === 'settings:set').pop();
    expect(call, 'changing the filter did not save').toBeTruthy();
    expect(call.payload.settings.outputFilter).toBe('on');
    h.window.close();
  });

  it('has a character budget that defaults to 8000', async () => {
    const h = await boot();
    h.window.switchView('settings');
    const input = doc(h).querySelector('#opt-outputfilter-max');
    expect(input, 'no #opt-outputfilter-max in the settings panel').toBeTruthy();
    expect(input.type).toBe('number');
    expect(input.getAttribute('min')).toBe('500');
    expect(input.getAttribute('max')).toBe('100000');
    expect(input.getAttribute('step')).toBe('500');
    expect(input.value).toBe('8000');
    h.window.close();
  });

  it('clamps the budget to its range and saves a number', async () => {
    const h = await boot();
    h.window.switchView('settings');
    const input = doc(h).querySelector('#opt-outputfilter-max');
    input.value = '999999';
    changed(h, input);
    await flush(6);
    let call = h.calls.filter(c => c.channel === 'settings:set').pop();
    expect(call, 'the budget was not saved').toBeTruthy();
    expect(call.payload.settings.outputFilterMaxChars).toBe(100000);

    input.value = '10';
    changed(h, input);
    await flush(6);
    call = h.calls.filter(c => c.channel === 'settings:set').pop();
    expect(call.payload.settings.outputFilterMaxChars).toBe(500);
    h.window.close();
  });

  it('explains that only what the model reads is compacted', async () => {
    const h = await boot();
    h.window.switchView('settings');
    const card = doc(h).querySelector('#opt-outputfilter').closest('.settings-card');
    const hints = [...card.querySelectorAll('.hint')].map(n => n.textContent);
    const hint = hints.find(t => /model/i.test(t) && /full/i.test(t));
    expect(hint, 'no hint explains the filter; card had: ' + hints.join(' | ')).toBeTruthy();
    h.window.close();
  });
});
