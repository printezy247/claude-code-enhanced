// Phase 2.1 + 2.2: model routing by task size (off unless switched on, never on a
// pinned chat) and the /loop and /goal slash commands.
import { describe, it, expect } from 'vitest';
import { classifyTask, routeFor, DEFAULT_TIERS } from '../src/renderer/chat/route.js';

describe('classifyTask', () => {
  it.each([
    ['fix the typo in README', 'trivial'],
    ['what does this function do?', 'trivial'],
    ['rename foo to bar', 'trivial'],
    ['add a loading spinner to the settings page and wire it to the save button so users see progress', 'medium'],
    ['refactor the auth module', 'heavy'],
    ['migrate the whole project from CommonJS to ESM across all files', 'heavy'],
    ['1. add the table\n2. write the migration\n3. update the API\n4. add tests\n5. update docs', 'heavy'],
  ])('%s -> %s', (text, level) => expect(classifyTask(text)).toBe(level));

  it('a long prompt is heavy and a code fence is never trivial', () => {
    expect(classifyTask('x '.repeat(700))).toBe('heavy');
    expect(classifyTask('fix:\n```js\nfoo(\n```')).not.toBe('trivial');
  });
  it('images lift trivial to medium', () => {
    expect(classifyTask('what is this?', { images: 1 })).toBe('medium');
  });
  it('empty text is medium', () => expect(classifyTask('')).toBe('medium'));
});

describe('routeFor', () => {
  const on = { enabled: true };
  it('does nothing while the flag is off', () => {
    expect(routeFor({ enabled: false }, { model: '', provider: null }, 'fix typo')).toBe(null);
    expect(routeFor(undefined, { model: '', provider: null }, 'fix typo')).toBe(null);
  });
  it('never touches a chat with a pinned model', () => {
    expect(routeFor(on, { model: 'opus', provider: null }, 'fix typo')).toBe(null);
  });
  it('maps trivial, medium and heavy to the tier models', () => {
    const chat = { model: '', provider: null };
    expect(routeFor(on, chat, 'fix the typo in README')).toBe(DEFAULT_TIERS.trivial);
    expect(routeFor(on, chat, 'add a loading spinner to the settings page and wire it to the save button so users see progress')).toBe(DEFAULT_TIERS.medium);
    expect(routeFor(on, chat, 'refactor the auth module')).toBe(DEFAULT_TIERS.heavy);
  });
  it('honours custom tiers and an empty tier means "leave it"', () => {
    const chat = { model: '', provider: null };
    expect(routeFor({ enabled: true, tiers: { trivial: 'my-small', medium: '', heavy: 'my-big' } }, chat, 'fix the typo in README')).toBe('my-small');
    expect(routeFor({ enabled: true, tiers: { trivial: 'my-small', medium: '', heavy: 'my-big' } }, chat, 'add a loading spinner to the settings page and wire it to the save button so users see progress')).toBe(null);
  });
  it('skips slash commands and chats on a custom provider or another engine', () => {
    expect(routeFor(on, { model: '', provider: null }, '/compact')).toBe(null);
    expect(routeFor(on, { model: '', provider: { uid: 'x', baseUrl: 'http://127.0.0.1:1' } }, 'fix typo')).toBe(null);
    expect(routeFor(on, { model: '', provider: null, engine: 'codex' }, 'fix typo')).toBe(null);
  });
});

import { parseLoop, parseGoal, loopAfterTurn, MAX_LOOPS } from '../src/renderer/chat/loopgoal.js';

describe('/loop and /goal parsing', () => {
  it('/loop needs a number and a prompt', () => {
    expect(parseLoop('/loop')).toMatchObject({ error: expect.any(String) });
    expect(parseLoop('/loop abc do x')).toMatchObject({ error: expect.any(String) });
    expect(parseLoop('/loop 3')).toMatchObject({ error: expect.any(String) });
    expect(parseLoop('/loop 0 x')).toMatchObject({ error: expect.any(String) });
    expect(parseLoop('/loop 3 run the tests')).toEqual({ n: 3, prompt: 'run the tests' });
  });
  it('/loop caps the count', () => {
    expect(parseLoop('/loop 999 x')).toEqual({ n: MAX_LOOPS, prompt: 'x' });
  });
  it('/goal sets, shows or clears', () => {
    expect(parseGoal('/goal')).toEqual({ show: true });
    expect(parseGoal('/goal clear')).toEqual({ clear: true });
    expect(parseGoal('/goal ship the login page')).toEqual({ goal: 'ship the login page' });
  });
});

describe('loopAfterTurn', () => {
  it('re-queues until the count is used up', () => {
    const chat = { loop: { left: 2, prompt: 'p' }, pendingMsgs: [] };
    expect(loopAfterTurn(chat, { stopped: false })).toBe('p');
    expect(chat.loop.left).toBe(1);
    expect(loopAfterTurn(chat, { stopped: false })).toBe('p');
    expect(chat.loop).toBe(null);
  });
  it('a stop or an error clears the loop', () => {
    const chat = { loop: { left: 5, prompt: 'p' } };
    expect(loopAfterTurn(chat, { stopped: true })).toBe(null);
    expect(chat.loop).toBe(null);
    const c2 = { loop: { left: 5, prompt: 'p' } };
    expect(loopAfterTurn(c2, { error: true })).toBe(null);
    expect(c2.loop).toBe(null);
  });
  it('no loop, nothing to do', () => expect(loopAfterTurn({ loop: null }, {})).toBe(null));
});
