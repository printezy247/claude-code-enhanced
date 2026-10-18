// A provider's model must stay what the user set. Three ways it did not:
// partial saves blanked the default model, a provider with no default fell
// back to the "model" pinned in ~/.claude/settings.json ("sonnet"), and the
// chat menu offered Claude names a third-party provider cannot serve, which the
// proxy silently swapped for another model.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const providers = require('../src/main/providers.js');
const { loadRenderer, flush } = require('./helpers/renderer.js');

describe('saving part of a provider', () => {
  it('leaves the models alone when the save does not include them', () => {
    const toggle = providers.normalizeModelFields({ uid: 'a', name: 'Alibaba', disabled: true });
    expect('model' in toggle).toBe(false);
    expect('smallFastModel' in toggle).toBe(false);
    const stored = { uid: 'a', name: 'Alibaba', model: 'kimi-k3', smallFastModel: 'qwen-flash' };
    Object.assign(stored, toggle);
    expect(stored.model).toBe('kimi-k3');
    expect(stored.smallFastModel).toBe('qwen-flash');
  });

  it('still cleans the fields it was given', () => {
    expect(providers.normalizeModelFields({ model: ' kimi-k3, other ', smallFastModel: '' }))
      .toEqual({ model: 'kimi-k3', smallFastModel: '' });
  });
});

describe('model for a chat with nothing picked', () => {
  const ali = { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: '', whitelist: ['qwen3.5-plus', 'kimi-k3'], models: ['x'] };
  it('uses the pick, then the provider default, then its first listed model', () => {
    expect(providers.chatModelFor(ali, 'kimi-k3')).toBe('kimi-k3');
    expect(providers.chatModelFor({ ...ali, model: 'glm-5.1' }, '')).toBe('glm-5.1');
    expect(providers.chatModelFor(ali, '')).toBe('qwen3.5-plus');
    expect(providers.chatModelFor({ ...ali, whitelist: [] }, '')).toBe('x');
  });
  it('leaves Anthropic\'s own API to the user\'s Claude setting', () => {
    expect(providers.chatModelFor({ baseUrl: '', model: '' }, '')).toBe('');
    expect(providers.chatModelFor({ baseUrl: 'https://api.anthropic.com', model: '' }, '')).toBe('');
  });
});

async function openChat(provider, model = '') {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: provider ? [provider] : [], defaultUid: provider ? provider.uid : null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model, permissionMode: 'acceptEdits', provider },
      'chat:supported-models': { ok: true, models: [{ value: 'claude-opus-5-5', displayName: 'Opus 5.5' }] },
    },
  });
  await flush(4);
  return { h, chat: h.window.Chat.chats.get('c1') };
}
const options = (chat) => [...chat.modelSel.options].map(o => o.value);

describe('provider card', () => {
  it('flags a remote provider with no default model', async () => {
    const { h } = await openChat(null);
    const insts = [
      { uid: 'n', name: 'NaraRouter Z', baseUrl: 'https://router.example/v1', model: '' },
      { uid: 'k', name: 'Kilo', baseUrl: 'https://kilo.example/v1', model: 'glm-5.1' },
    ];
    h.window.state.providers = { presets: [], catalog: [{ id: 'x', display: 'X' }], instances: insts, defaultUid: 'k' };
    await h.window.ProvidersUI.render();
    const cards = [...h.window.document.querySelectorAll('.provider-card')];
    const text = (name) => cards.find(c => c.textContent.includes(name)).textContent;
    expect(text('NaraRouter Z')).toContain('model  not set');
    expect(text('Kilo')).not.toContain('not set');
  });
});

describe('the chat model menu', () => {
  const ALI = { uid: 'p1', name: 'Alibaba', baseUrl: 'https://dashscope.example/v1', model: 'kimi-k3', whitelist: ['kimi-k3', 'qwen3.5-plus', 'glm-5.1'] };

  it('lists a third-party provider\'s own models, not Claude names it cannot serve', async () => {
    const { chat } = await openChat(ALI);
    expect(options(chat)).toEqual(['', 'kimi-k3', 'qwen3.5-plus', 'glm-5.1', '__custom']);
    expect(chat.modelSel.options[0].textContent).toBe('provider default · kimi-k3');
  });

  it('says so when the provider has no default', async () => {
    const { chat } = await openChat({ ...ALI, model: '' });
    expect(chat.modelSel.options[0].textContent).toBe('provider default (none set)');
  });

  it('keeps the Claude choices on Anthropic\'s own API', async () => {
    const { chat } = await openChat({ uid: 'a', name: 'Anthropic', baseUrl: '', model: '' });
    expect(options(chat)).toEqual(expect.arrayContaining(['', 'opus', 'sonnet', 'haiku', '__custom']));
  });

  it('follows the engine when it reports a different model', async () => {
    const { h, chat } = await openChat(ALI, 'kimi-k3');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'system', subtype: 'session_state_changed', state: { model: 'deepseek-v4-pro' } } });
    await flush();
    expect(chat.model).toBe('deepseek-v4-pro');
    expect(chat.modelSel.value).toBe('deepseek-v4-pro');
  });
});
