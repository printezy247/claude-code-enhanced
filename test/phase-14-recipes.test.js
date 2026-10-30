// @vitest-environment jsdom
// /recipe: a saved chain of prompts (build, review, fix) run one step per turn, pausing between steps.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { parseSteps, parseRecipeCmd, recipeAfterTurn, loadRecipes, saveRecipe, deleteRecipe } from '../src/renderer/chat/recipes.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };

describe('parseSteps', () => {
  it('splits on --- lines and trims', () => {
    expect(parseSteps('build it\n---\n review it \n---\nfix findings')).toEqual({ auto: false, steps: ['build it', 'review it', 'fix findings'] });
  });
  it('a first line of "auto" means no pause between steps', () => {
    expect(parseSteps('auto\none\n---\ntwo')).toEqual({ auto: true, steps: ['one', 'two'] });
  });
  it('drops empty steps and refuses too many or none', () => {
    expect(parseSteps('a\n---\n\n---\nb').steps).toEqual(['a', 'b']);
    expect(parseSteps('   ').error).toMatch(/at least one/i);
    expect(parseSteps(Array.from({ length: 9 }, (_, i) => 's' + i).join('\n---\n')).error).toMatch(/at most 8/);
  });
});

describe('storage', () => {
  it('saves, lists and deletes by name', () => {
    const s = mem();
    expect(saveRecipe(s, 'Review Flow', 'a\n---\nb').ok).toBe(true);
    expect(Object.keys(loadRecipes(s))).toEqual(['review-flow']);
    expect(deleteRecipe(s, 'review-flow')).toBe(true);
    expect(loadRecipes(s)).toEqual({});
  });
  it('rejects an empty name or empty steps', () => {
    expect(saveRecipe(mem(), '!!', 'a').ok).toBe(false);
    expect(saveRecipe(mem(), 'x', '').ok).toBe(false);
  });
});

describe('parseRecipeCmd', () => {
  it('reads list, save, delete and run', () => {
    expect(parseRecipeCmd('/recipe')).toEqual({ action: 'list' });
    expect(parseRecipeCmd('/recipe save my-flow')).toEqual({ action: 'save', name: 'my-flow' });
    expect(parseRecipeCmd('/recipe delete my-flow')).toEqual({ action: 'delete', name: 'my-flow' });
    expect(parseRecipeCmd('/recipe my-flow')).toEqual({ action: 'run', name: 'my-flow' });
    expect(parseRecipeCmd('/recipe save').error).toMatch(/name/);
  });
});

describe('recipeAfterTurn', () => {
  const mk = (auto) => ({ recipe: { name: 'r', steps: ['one', 'two', 'three'], i: 0, auto } });
  it('pauses before the next step unless auto', () => {
    const c = mk(false);
    expect(recipeAfterTurn(c, {})).toEqual({ pause: { prompt: 'two', n: 2, of: 3 } });
  });
  it('auto goes straight on, and ends after the last step', () => {
    const c = mk(true);
    expect(recipeAfterTurn(c, {})).toEqual({ prompt: 'two', n: 2, of: 3 });
    expect(recipeAfterTurn(c, {})).toEqual({ prompt: 'three', n: 3, of: 3 });
    expect(recipeAfterTurn(c, {})).toBeNull();
    expect(c.recipe).toBeNull();
  });
  it('a stop or an error ends it', () => {
    const c = mk(true);
    expect(recipeAfterTurn(c, { error: true })).toBeNull();
    expect(c.recipe).toBeNull();
  });
});

describe('/recipe in a chat', () => {
  it('runs step one, then offers step two with a Continue button', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'chat:send': { ok: true },
    } });
    await flush(4);
    const w = h.window;
    saveRecipe(w.localStorage, 'flow', 'write the code\n---\nreview the code');
    const chat = w.Chat.chats.get('c1');
    chat.composer.value = '/recipe flow';
    chat.send();
    await flush(6);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload.text).toBe('write the code');
    w.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, usage: {} } });
    await flush(6);
    const card = chat.msgs.querySelector('.recipe-card');
    expect(card.textContent).toContain('Step 2 of 2');
    expect(card.textContent).toContain('review the code');
    card.querySelector('.recipe-go').click();
    await flush(6);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload.text).toBe('review the code');
  });
});

describe('/loop really starts', () => {
  it('sends the first round (a bare send() used to throw inside the timer)', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'chat:send': { ok: true },
    } });
    await flush(4);
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = '/loop 2 run the tests';
    chat.send();
    await flush(6);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload.text).toBe('run the tests');
  });
});

describe('/review really starts', () => {
  it('sends the review prompt', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
      'chat:send': { ok: true },
    } });
    await flush(4);
    const chat = h.window.Chat.chats.get('c1');
    chat.composer.value = '/review';
    chat.send();
    await flush(6);
    expect(h.calls.filter((c) => c.channel === 'chat:send').pop().payload.text).toMatch(/^Review the current changes/);
  });
});
