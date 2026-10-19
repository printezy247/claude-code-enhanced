// Deleting a conversation stuck, and third-party models looped on context-mode's
// hidden output. These pin the fixes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const chatsMod = require('../src/main/chats.js');
const ChatManager = chatsMod;
const { loadRenderer, flush } = require('./helpers/renderer.js');

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('deleting a conversation', () => {
  let home; let oldHome;
  beforeEach(() => {
    oldHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-del-'));
    process.env.HOME = home;
  });
  afterEach(() => { process.env.HOME = oldHome; fs.rmSync(home, { recursive: true, force: true }); });

  const put = (folder) => {
    const dir = path.join(home, '.claude', 'projects', folder);
    fs.mkdirSync(path.join(dir, SID), { recursive: true });
    fs.writeFileSync(path.join(dir, SID + '.jsonl'), '{"type":"user"}\n');
    return dir;
  };

  it('finds the transcript even when the folder guess misses, and removes subagent files', async () => {
    const dir = put('-some-other-munge');
    const m = new ChatManager({ sdk: {} });
    const r = await m.deleteSession('/home/nobody/elsewhere', SID);
    expect(r.deleted).toBe(true);
    expect(fs.existsSync(path.join(dir, SID + '.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dir, SID))).toBe(false);
  });

  it('says so when there is nothing to delete instead of claiming success', async () => {
    const m = new ChatManager({ sdk: {} });
    await expect(m.deleteSession('/x', SID)).rejects.toThrow(/no longer on disk/);
  });

  it('closes a live chat on that session first so it cannot write the file back', async () => {
    put('-x');
    const m = new ChatManager({ sdk: {} });
    const closed = [];
    m.chats.set('c9', { sessionId: SID });
    m.close = (id) => closed.push(id);
    const r = await m.deleteSession('/x', SID);
    expect(closed).toEqual(['c9']);
    expect(r.closed).toEqual(['c9']);
  });
});

describe('context-mode on translated providers', () => {
  const kimi = { uid: 'k', baseUrl: 'https://api.example/v1', protocol: 'openai' };
  const claude = { uid: 'a', baseUrl: '', protocol: 'anthropic' };
  const off = { enabledPlugins: { 'context-mode@context-mode': false } };

  it('is off for third-party models and left alone for Claude by default', () => {
    expect(chatsMod.pluginOverrides({ provider: kimi })).toEqual(off);
    expect(chatsMod.pluginOverrides({ provider: claude })).toBe(null);
    expect(chatsMod.pluginOverrides({ provider: null })).toBe(null);
  });

  it('follows the setting', () => {
    expect(chatsMod.pluginOverrides({ provider: kimi, settings: { contextMode: 'on' } })).toBe(null);
    expect(chatsMod.pluginOverrides({ provider: claude, settings: { contextMode: 'off' } })).toEqual(off);
  });
});

describe('MCP tool cards say what they ran', () => {
  it('shows the command, not just the tool name', async () => {
    const h = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/h' },
        'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      },
    });
    await flush(4);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'm1', name: 'mcp__plugin_context-mode_context-mode__ctx_execute', input: { language: 'shell', code: '# scan\ngit status --short' } },
      { type: 'tool_use', id: 'm2', name: 'mcp__github__search_code', input: { query: 'deleteSession repo:x' } },
    ] } } });
    await flush();
    const titles = [...h.window.document.querySelectorAll('.tool-title')].map(t => t.textContent);
    expect(titles.join('\n')).toContain('context-mode ▸ ctx_execute · git status --short');
    expect(titles.join('\n')).toContain('github ▸ search_code · deleteSession repo:x');
  });
});
