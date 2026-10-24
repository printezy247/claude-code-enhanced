// The AskUserQuestion card end to end: drawn in the chat, answers go back to the
// engine, the tool survives the lean presets, and models are told to use it.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const ChatManager = require('../src/main/chats.js');
const { sanitizeSchema } = require('../src/main/adapters.js');
const { autoAllows } = require('../src/main/autopolicy.js');

const QS = [{
  question: 'Which database?', header: 'DB', multiSelect: false,
  options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'file' }],
}, {
  question: 'Which extras?', header: 'Extras', multiSelect: true,
  options: [{ label: 'Auth' }, { label: 'Cache' }],
}];

const P1 = { uid: 'p1', name: 'P', presetId: 'a', baseUrl: '', models: [], model: '' };
const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
  'providers:all': { ok: true, presets: [], instances: [P1], defaultUid: 'p1' },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: P1 },
  'chat:permission-answer': { ok: true },
  ...extra,
});

async function ask() {
  const h = loadRenderer({ ipc: ipc() });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  h.window.Chat.handleEvent({ id: 'c1', kind: 'permission', requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: QS } });
  return { h, chat, card: chat.permSlot.querySelector('.perm-card.ask') };
}

describe('ask card in the chat', () => {
  it('draws each question with its options and keeps Send disabled until all are answered', async () => {
    const { card } = await ask();
    expect(card).toBeTruthy();
    expect(card.querySelectorAll('.ask-q')).toHaveLength(2);
    expect(card.querySelectorAll('.ask-opt')).toHaveLength(4);
    const send = [...card.querySelectorAll('button')].find((b) => /Send answers/.test(b.textContent));
    expect(send.disabled).toBe(true);
  });

  it('sends the picked labels back to the engine, multi-select as a list', async () => {
    const { h, card } = await ask();
    const opts = [...card.querySelectorAll('.ask-opt')];
    opts[1].click();            // SQLite
    opts[2].click(); opts[3].click();   // Auth + Cache
    const send = [...card.querySelectorAll('button')].find((b) => /Send answers/.test(b.textContent));
    expect(send.disabled).toBe(false);
    send.click();
    await flush(6);
    const call = h.calls.find((c) => c.channel === 'chat:permission-answer');
    expect(call.payload).toMatchObject({ id: 'c1', requestId: 'r1', decision: 'allow' });
    expect(call.payload.answers).toEqual({ 'Which database?': 'SQLite', 'Which extras?': ['Auth', 'Cache'] });
  });

  it('Skip denies the question', async () => {
    const { h, card } = await ask();
    [...card.querySelectorAll('button')].find((b) => /Skip/.test(b.textContent)).click();
    await flush(6);
    expect(h.calls.find((c) => c.channel === 'chat:permission-answer').payload.decision).toBe('deny');
  });
});

describe('answers reach the engine', () => {
  it('resolves the pending request as allow with updatedInput.answers', () => {
    const mgr = new ChatManager({ proxyToken: 't', sdk: {} });
    const resolve = vi.fn();
    mgr.pendingPerms.set('r1', { chatId: 'c1', requestId: 'r1', toolName: 'AskUserQuestion', input: { questions: QS }, resolve, suggestions: [] });
    const r = mgr.answer('c1', 'r1', 'allow', { 'Which database?': 'SQLite' });
    expect(r.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith({ behavior: 'allow', updatedInput: { questions: QS, answers: { 'Which database?': 'SQLite' } } });
  });

  it('is never auto-approved by the auto policy (a question needs a human)', () => {
    expect(autoAllows('AskUserQuestion', { questions: QS })).toBe(false);
  });
});

describe('models are given the tool and told to use it', () => {
  it('the lean presets keep AskUserQuestion', () => {
    const src = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('const LEAN_PRESETS'), src.indexOf('const LEAN_ALL_TOOLS'));
    expect(block).toMatch(/lean: \{[^}]*AskUserQuestion/);
    expect(block).toMatch(/readOnly: \{[^}]*AskUserQuestion/);
  });

  it('the system prompt asks for the question card, unless the tool is unavailable', () => {
    const { appendPromptFor } = ChatManager;
    expect(appendPromptFor(undefined, [])).toMatch(/AskUserQuestion/);
    expect(appendPromptFor(['Read', 'AskUserQuestion'], [])).toMatch(/instead of asking in plain text/);
    expect(appendPromptFor(['Read', 'Bash'], [])).not.toMatch(/AskUserQuestion/);
    expect(appendPromptFor(undefined, ['AskUserQuestion'])).not.toMatch(/AskUserQuestion/);
  });

  it('its schema survives every dialect the translation layer speaks', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
      required: ['questions'],
      properties: { questions: { type: 'array', minItems: 1, maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['question', 'options'],
        properties: { question: { type: 'string' }, header: { type: 'string', maxLength: 12 }, multiSelect: { type: 'boolean', default: false },
          options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' } } } } } } } },
    };
    for (const d of ['openai', 'gemini']) {
      const out = sanitizeSchema(schema, d);
      expect(JSON.stringify(out)).not.toMatch(/\$schema/);
      if (d === 'gemini') expect(JSON.stringify(out)).not.toMatch(/additionalProperties/);
      expect(out.properties.questions.items.properties.options.items.properties.label.type).toBe('string');
    }
  });
});
