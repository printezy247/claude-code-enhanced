// Chat pane: "/" lists commands in a fresh chat, command output and the
// compaction summary are not drawn as prompts, and a keyed provider is not
// labelled "no auth".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const COMMANDS = [
  { name: 'ecc:code-review', description: 'Code review of local changes or a PR', argumentHint: '[pr]' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'init', description: 'Write a CLAUDE.md' },
];

async function open({ provider = null, commands = COMMANDS } = {}) {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: provider ? [provider] : [], defaultUid: provider ? provider.uid : null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000, autoNudge: false }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider },
      'chat:commands': { ok: true, commands },
    },
  });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  const send = (msg) => h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
  return { h, chat, send };
}

const type = async (h, chat, v) => {
  chat.composer.value = v;
  chat.composer.dispatchEvent(new h.window.Event('input'));
  await flush(4);
};
const items = (chat) => [...chat.slash.querySelectorAll('.slash-item')].map(i => i.querySelector('.slash-name').textContent);

describe('"/" in the composer', () => {
  it('lists commands in a fresh chat, before the engine has replied', async () => {
    const { h, chat } = await open();
    expect(chat.init).toBeFalsy();
    await type(h, chat, '/');
    expect(chat.slash.classList.contains('hidden')).toBe(false);
    // The list is windowed (only the visible rows are drawn), so check the full list on the chat.
    expect(chat.slashItems.map(c => c.name)).toEqual(expect.arrayContaining(['compact', 'ecc:code-review', 'review']));
    expect(h.calls.filter(c => c.channel === 'chat:commands')).toHaveLength(1);
    await type(h, chat, '/ecc');
    expect(chat.slash.textContent).toContain('Code review of local changes or a PR');
  });

  it('filters by prefix, then by any part of the name', async () => {
    const { h, chat } = await open();
    await type(h, chat, '/rev');
    // prefix first, then word-start (after ":"), then any part of the name
    expect(items(chat)).toEqual(['/review', '/ecc:code-review [pr]', '/preview']);
  });

  it('puts the picked command in the composer', async () => {
    const { h, chat } = await open();
    await type(h, chat, '/ini');
    chat.composer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(chat.composer.value).toBe('/init ');
    expect(chat.slash.classList.contains('hidden')).toBe(true);
  });

  it('still offers cce\'s own commands when the session lists none', async () => {
    const { h, chat } = await open({ commands: [] });
    await type(h, chat, '/co');
    expect(items(chat).sort()).toEqual(['/compact', '/compare', '/context', '/cost']);
  });
});

describe('records that are not prompts', () => {
  it('draws /model output as a quiet note, not a user bubble', async () => {
    const { chat, send } = await open();
    send({ type: 'user', uuid: 'u1', message: { content: '<local-command-caveat>The command below was run directly in Claude Code…</local-command-caveat>' } });
    send({ type: 'user', uuid: 'u2', message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>glm-5.1</command-args>' } });
    send({ type: 'user', uuid: 'u3', message: { content: '<local-command-stdout>Set model to `glm-5.1`</local-command-stdout>' } });
    await flush();
    const bubbles = [...chat.msgs.querySelectorAll('.user-bubble')].map(b => b.textContent);
    expect(bubbles.join('|')).toContain('/model glm-5.1');
    expect(bubbles.join('|')).not.toContain('<');
    expect(chat.msgs.querySelector('.cmd-note').textContent).toBe('↳ Set model to `glm-5.1`');
    expect(chat.msgs.textContent).not.toContain('local-command');
  });

  it('folds the compaction summary away instead of showing it as a page-long prompt', async () => {
    const { chat, send } = await open();
    send({ type: 'user', uuid: 'u9', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Reviewed cce.' } });
    send({ type: 'user', uuid: 'u9', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Reviewed cce.' } });
    await flush();
    expect(chat.msgs.querySelectorAll('.user-bubble')).toHaveLength(0);
    const d = chat.msgs.querySelectorAll('details.compact-summary');
    expect(d).toHaveLength(1);
    expect(d[0].open).toBe(false);
    expect(d[0].textContent).toContain('Reviewed cce.');
  });
});

describe('provider status', () => {
  it('does not call a keyed third-party provider "no auth"', async () => {
    const { chat, send } = await open({ provider: { uid: 'p1', name: 'Alibaba', baseUrl: 'https://dashscope.example/v1', authType: 'api', authHint: 'sk-…1234' } });
    send({ type: 'system', subtype: 'init', model: 'qwen3.5-plus', apiKeySource: 'none', slash_commands: [], tools: [], mcp_servers: [] });
    await flush();
    expect(chat.statusRight.textContent).toContain('provider key');
    expect(chat.statusRight.textContent).not.toContain('no auth');
  });
});
