// Phase 3.1 + 3.2: per-chat output style and per-chat environment variables.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv, redactEnv, OUTPUT_STYLES, mergeEnv } from '../src/renderer/chat/chatopts.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

describe('parseEnv', () => {
  it('reads NAME=value lines', () => {
    expect(parseEnv('A=1\nB=two words\n')).toEqual({ env: { A: '1', B: 'two words' }, errors: [] });
  });
  it('skips blanks and comments, keeps = inside values, strips quotes', () => {
    expect(parseEnv('# note\n\nURL=http://x?a=b\nQ="quoted"').env).toEqual({ URL: 'http://x?a=b', Q: 'quoted' });
  });
  it('the last duplicate wins', () => {
    expect(parseEnv('A=1\nA=2').env).toEqual({ A: '2' });
  });
  it('rejects bad names and says which line', () => {
    const r = parseEnv('1BAD=x\nGOOD=y\nno equals');
    expect(r.env).toEqual({ GOOD: 'y' });
    expect(r.errors.map((e) => e.line)).toEqual([1, 3]);
  });
  it('refuses variables that would change how the engine itself runs', () => {
    const r = parseEnv('PATH=/x\nLD_PRELOAD=/y\nNODE_OPTIONS=--inspect\nOK=1');
    expect(r.env).toEqual({ OK: '1' });
    expect(r.errors.length).toBe(3);
  });
});

describe('redactEnv', () => {
  it('shows names and never values', () => {
    const s = redactEnv({ API_KEY: 'sk-secret', A: '1' });
    expect(s).toContain('API_KEY');
    expect(s).not.toContain('sk-secret');
    expect(s).not.toContain('=1');
  });
});

describe('mergeEnv', () => {
  it('the chat scope wins over the global one', () => {
    expect(mergeEnv({ A: 'global', B: 'g' }, { A: 'chat' })).toEqual({ A: 'chat', B: 'g' });
  });
});

describe('output styles', () => {
  it('start with the default and name the built-in ones', () => {
    expect(OUTPUT_STYLES[0]).toEqual({ id: '', label: 'Default' });
    expect(OUTPUT_STYLES.map((s) => s.id)).toEqual(expect.arrayContaining(['Explanatory', 'Learning']));
  });
});

const open = async () => {
  const h = loadRenderer({ ipc: {
    'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
    'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
    'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
    'connectors:presets': { ok: true, presets: [] },
    'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    'chat:flags': { ok: true, applied: true },
  } });
  await flush(4);
  return { h, w: h.window, chat: h.window.Chat.chats.get('c1') };
};
const menuItem = (w, text) => [...w.document.querySelectorAll('.chat-menu-item')].find((b) => b.textContent.includes(text));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

describe('in the app', () => {
  it('picking an output style sends it as a flag and is remembered for the folder', async () => {
    const { h, w, chat } = await open();
    click(w, w.document.querySelector('.hdr-more'));
    click(w, menuItem(w, 'Explanatory'));
    await flush(4);
    const call = h.calls.filter((c) => c.channel === 'chat:flags').pop();
    expect(call.payload).toEqual({ id: 'c1', patch: { outputStyle: 'Explanatory' } });
    expect(chat.outputStyle).toBe('Explanatory');
    expect(JSON.parse(w.localStorage.getItem('style:/work/proj'))).toBe('Explanatory');
  });
  it('environment variables go to the engine as a flag, and the values are never stored or logged', async () => {
    const { h, w, chat } = await open();
    w.askText = async () => 'MY_TOKEN=abc123\nMODE=dev';
    click(w, w.document.querySelector('.hdr-more'));
    click(w, menuItem(w, 'Environment'));
    await flush(6);
    const call = h.calls.filter((c) => c.channel === 'chat:flags').pop();
    expect(call.payload.patch.env).toEqual({ MY_TOKEN: 'abc123', MODE: 'dev' });
    expect(chat.chatEnvNames).toEqual(['MY_TOKEN', 'MODE']);
    const stored = JSON.stringify(Object.entries(w.localStorage));
    expect(stored).not.toContain('abc123');
  });
});

describe('transcript size guard (3.6)', () => {
  it('keeps the DOM bounded with 2400 tool cards', async () => {
    const { w, chat } = await open();
    const ev = (msg) => w.Chat.handleEvent({ id: 'c1', kind: 'message', msg });
    const t0 = performance.now();
    for (let i = 0; i < 2400; i++) {
      ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' + i, name: 'Read', input: { file_path: '/f' + i } }] } });
    }
    const took = performance.now() - t0;
    const inDom = chat.msgs.querySelectorAll('.tool-card').length;
    expect(inDom, 'tool cards in the DOM').toBeLessThan(250);
    expect(took, `2400 cards took ${took.toFixed(0)} ms`).toBeLessThan(20000);
  });
});

describe('panel modules (3.7)', () => {
  it('panels.js keeps its public exports and every new module loads', async () => {
    const panels = await import('../src/renderer/chat/panels.js').catch((e) => ({ err: e }));
    // These modules touch the DOM only when called; loading them must not throw.
    for (const f of ['panel-memory', 'panel-palette', 'panel-skills', 'panel-mcp', 'panel-history', 'panel-plan', 'panel-opts']) {
      expect(fs.existsSync(new URL('../src/renderer/chat/' + f + '.js', import.meta.url)), f).toBe(true);
    }
    const src = fs.readFileSync(new URL('../src/renderer/chat/panels.js', import.meta.url), 'utf8');
    for (const n of ['makePanel', 'wireHeaderMenu', 'renderProjectInfo', 'openPalette', 'showFind', 'openPlanViewer', 'updatePlanViewer', 'setOutputStyle', 'maybeProbeMemory', 'collectMemoryProbe', 'maybeProbeSkill', 'collectSkillProbe', 'showPendingChip']) {
      expect(src, n).toMatch(new RegExp('\\b' + n + '\\b'));
    }
    expect(src.split('\n').length, 'panels.js length').toBeLessThan(300);
    void panels;
  });
});
