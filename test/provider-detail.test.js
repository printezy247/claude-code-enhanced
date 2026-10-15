// Provider detail dialog: a save must not be undone by the next redraw.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

describe('provider detail dialog', () => {
  it('shows the saved value after Save instead of the value captured at open', async () => {
    const saved = { uid: 'p1', presetId: 'openrouter', name: 'OpenRouter', protocol: 'anthropic', baseUrl: 'https://openrouter.ai/api', keyHeader: 'bearer', model: 'anthropic/claude-sonnet-4.5', smallFastModel: '', headers: {}, models: [], whitelist: [], blacklist: [] };
    const catalog = [{ id: 'openrouter', display: 'OpenRouter', protocol: 'anthropic', baseUrl: 'https://openrouter.ai/api', defaultModel: 'anthropic/claude-sonnet-4.5' }];
    const { window } = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, theme: 'dark', failoverChain: [], sandbox: {} }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'providers:all': () => ({ ok: true, presets: [], catalog, instances: [{ ...saved }], defaultUid: 'p1' }),
        'providers:save': ({ instance }) => { Object.assign(saved, instance); return { ok: true, uid: 'p1' }; },
        'catalog:models': { ok: true, models: [] },
        'provider:listModels': { ok: true, models: [] },
      },
    });
    window.state.providers = { presets: [], catalog, instances: [{ ...saved }], defaultUid: 'p1' };

    window.ProvidersUI.openDetail('p1', { tab: 'options' });
    const field = (label) => [...window.document.querySelectorAll('.provider-detail label.fld')]
      .find(l => l.textContent.includes(label)).querySelector('input');

    field('Default model').value = 'deepseek-v4-flash';
    [...window.document.querySelectorAll('.provider-detail button')].find(b => b.textContent === 'Save').click();
    await flush(8);

    expect(saved.model).toBe('deepseek-v4-flash');
    // The redraw after Save must read the saved instance, not the open-time copy.
    expect(field('Default model').value).toBe('deepseek-v4-flash');
  });

  it('names the newly saved key in the key field, not the one it replaced', async () => {
    const inst = { uid: 'x1', presetId: 'xiaomi', name: 'Xiaomi', protocol: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', keyHeader: 'bearer', model: 'mimo-v2.6-pro', smallFastModel: '', headers: {}, models: [], whitelist: [], blacklist: [], authType: 'api', authHint: 'sk-scd…grtq' };
    const catalog = [{ id: 'xiaomi', display: 'Xiaomi', protocol: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1' }];
    const { window } = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, theme: 'dark', failoverChain: [], sandbox: {} }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'providers:all': () => ({ ok: true, presets: [], catalog, instances: [{ ...inst }], defaultUid: 'x1' }),
        'auth:setKey': () => { inst.authHint = 'tp-slx…rge5'; return { ok: true }; },
        'catalog:models': { ok: true, models: [] },
        'provider:listModels': { ok: true, models: [] },
      },
    });
    window.state.providers = { presets: [], catalog, instances: [{ ...inst }], defaultUid: 'x1' };
    window.ProvidersUI.openDetail('x1', { tab: 'auth' });
    const input = window.document.querySelector('.provider-detail input[type=password]');
    expect(input.placeholder).toContain('sk-scd…grtq');
    input.value = 'tp-new-key';
    [...window.document.querySelectorAll('.provider-detail button')].find(b => b.textContent === 'Save key').click();
    await flush(8);
    expect(input.placeholder).toBe('leave blank to keep tp-slx…rge5');
    expect(window.document.querySelector('.provider-detail .auth-status').textContent).toContain('tp-slx…rge5');
  });
});
