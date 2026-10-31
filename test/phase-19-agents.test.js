// 0.28.0: agent board, take back control, audit recipes, health score, budget notification.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseRecipeCmd, allRecipes, fillSteps, BUILTIN_RECIPES, saveRecipe, loadRecipes } from '../src/renderer/chat/recipes.js';

const require = createRequire(import.meta.url);
const B = require('../src/shared/agentboard.js');
const D = require('../src/shared/doctor.js');
const read = (p) => readFileSync(path.join(__dirname, '..', p), 'utf8');

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

describe('agent board', () => {
  const T0 = 1_000_000;
  const tools = [
    ['a1', { name: 'Agent', input: { description: 'Explore code', subagent_type: 'Explore' }, status: 'done', startedAt: T0, endedAt: T0 + 65_000, output: 'x'.repeat(4000) }],
    ['b1', { name: 'Bash', input: { command: 'ls' }, status: 'done', startedAt: T0 }],
    ['a2', { name: 'Task', input: { description: 'Nested job', model: 'haiku' }, status: 'running', startedAt: T0 + 10_000, parentId: 'a1' }],
    ['a3', { name: 'Agent', input: { subagent_type: 'Plan' }, status: 'err', startedAt: T0 + 20_000, endedAt: T0 + 21_000 }],
  ];
  it('lists only subagents, parents before children, with depth', () => {
    const b = B.boardRows(tools, T0 + 30_000);
    expect(b.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
    expect(b.rows.map((r) => r.depth)).toEqual([0, 1, 0]);
    expect(b).toMatchObject({ total: 3, running: 1, failed: 1 });
  });
  it('shows state, type, model, duration and a rough answer size', () => {
    const [a1, a2, a3] = B.boardRows(tools, T0 + 30_000).rows;
    expect(a1).toMatchObject({ state: 'done', type: 'Explore', ms: 65_000, tokens: 1000, title: 'Explore code' });
    expect(a2).toMatchObject({ state: 'running', model: 'haiku', ms: 20_000 });
    expect(a3).toMatchObject({ state: 'failed', title: 'Plan' });
  });
  it('survives a parent loop', () => {
    const loop = [['x', { name: 'Agent', input: {}, status: 'running', startedAt: 1, parentId: 'y' }], ['y', { name: 'Agent', input: {}, status: 'running', startedAt: 2, parentId: 'x' }]];
    expect(() => B.boardRows(loop, 10)).not.toThrow();
  });
  it('formats durations', () => {
    expect([B.fmtMs(4000), B.fmtMs(125_000), B.fmtMs(3_720_000)]).toEqual(['4s', '2m 05s', '1h 02m']);
  });
  it('is drawn as an Overview card and fed by the tool cards', () => {
    expect(read('src/renderer/app/overview.js')).toMatch(/card\('agents', 'Agents', 'bot'\)/);
    expect(read('src/renderer/chat/tools.js')).toMatch(/startedAt: Date\.now\(\), endedAt: 0/);
  });
});

describe('take back control', () => {
  it('stops Claude and switches to plan mode, shown only while it works', () => {
    const s = read('src/renderer/chat/session.js');
    expect(s).toMatch(/chat-takeback/);
    expect(s).toMatch(/chat:interrupt[\s\S]{0,200}chat:set-mode[\s\S]{0,80}mode: 'plan'/);
    expect(read('src/renderer/chat/status.js')).toMatch(/takeBtn\.classList\.toggle\('hidden', !busy\)/);
  });
});

describe('audit recipes', () => {
  it('come ready-made and end in a graded report with a fixed title', () => {
    expect(Object.keys(BUILTIN_RECIPES)).toEqual(['seo-audit', 'security-audit', 'a11y-audit']);
    for (const r of Object.values(BUILTIN_RECIPES)) {
      const last = r.steps[r.steps.length - 1];
      expect(last).toMatch(/First line: "# /);
      expect(last).toMatch(/score out of 100/);
      expect(last).toMatch(/Critical, Warnings and Passed/);
      expect(r.steps.length).toBeLessThanOrEqual(8);
    }
    expect(BUILTIN_RECIPES['seo-audit'].needsArg).toBeTruthy();
  });
  it('/recipe name <argument> splits the argument from the name', () => {
    expect(parseRecipeCmd('/recipe seo-audit https://example.com')).toMatchObject({ action: 'run', head: 'seo-audit', args: 'https://example.com' });
    expect(parseRecipeCmd('/recipe seo-audit')).toEqual({ action: 'run', name: 'seo-audit' });
  });
  it('fills {arg}, or names the current project', () => {
    expect(fillSteps(['a {arg} b {arg}'], ' https://x.io ')).toEqual(['a https://x.io b https://x.io']);
    expect(fillSteps(['Review {arg}'], '')).toEqual(['Review the current project']);
  });
  it("the user's recipe wins a name clash and ready-made ones are never written to storage", () => {
    const store = mem();
    saveRecipe(store, 'seo-audit', 'my own step');
    expect(allRecipes(store)['seo-audit'].steps).toEqual(['my own step']);
    expect(Object.keys(loadRecipes(store))).toEqual(['seo-audit']);
    expect(allRecipes(mem())['security-audit'].builtin).toBe(true);
    expect(loadRecipes(mem())).toEqual({});
  });
  it('a recipe that needs a URL refuses to start without one', () => {
    expect(read('src/renderer/chat/slash.js')).toMatch(/rec\.needsArg && !arg\.trim\(\)/);
  });
});

describe('health score and suggestions', () => {
  it('warns about many idle connectors and a big memory', () => {
    const base = { claude: { found: true }, auth: 'ok', sandbox: true };
    const lv = (d) => Object.fromEntries(D.buildChecks({ ...base, ...d }).map((c) => [c.name, c.level]));
    expect(lv({ mcp: { live: 2, failed: 0, auth: 30, off: 0 } })['Idle connectors']).toBe('warn');
    expect(lv({ mcp: { live: 2, failed: 0, auth: 3, off: 1 } })['Idle connectors']).toBeUndefined();
    expect(lv({ memoryTokens: 9000 })['Memory size']).toBe('warn');
    expect(lv({ memoryTokens: 100 })['Memory size']).toBeUndefined();
  });
  it('the Overview shows the score once /doctor has run', () => {
    expect(read('src/renderer/app/overview.js')).toMatch(/\['health', chat\.healthScore/);
    expect(read('src/renderer/chat/doctorcmd.js')).toMatch(/chat\.healthScore = CCEDoctor\.score\(checks\)/);
  });
});

describe('budget alerts', () => {
  it('also raise a desktop notification, unless notifications are off', () => {
    const s = read('src/renderer/chat/events.js');
    expect(s).toMatch(/new Notification\('Budget alert'/);
    expect(s).toMatch(/notifyOnDone !== false/);
  });
});
