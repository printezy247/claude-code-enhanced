'use strict';
// Phase 1 (0.9.68): the discipline prompt must reach the model, name only
// tools the chat has, and a failed tool result must read as a failure.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const ChatManager = require('../src/main/chats');
const adapters = require('../src/main/adapters');
const { appendPromptFor } = ChatManager;

const chatsSrc = fs.readFileSync(path.join(__dirname, '../src/main/chats.js'), 'utf8');

describe('discipline prompt', () => {
  it('travels in systemPrompt.append, not the ignored appendSystemPrompt option', () => {
    expect(chatsSrc).not.toMatch(/options\.appendSystemPrompt\s*=/);
    expect(chatsSrc).toMatch(/appendPromptFor\(options\.tools, options\.disallowedTools\)/);
    expect(chatsSrc).toMatch(/append: appendText/);
  });

  it('names a todo tool only when the chat has one', () => {
    expect(appendPromptFor(undefined, [])).toMatch(/TodoWrite/);
    // A newer engine has no TodoWrite: the default prompt must not insist on it.
    expect(appendPromptFor(undefined, [])).toMatch(/TaskCreate\/TaskUpdate, or TodoWrite if/);
    expect(appendPromptFor(['Read', 'TodoWrite'], [])).toMatch(/TodoWrite/);
    expect(appendPromptFor(['Read', 'Bash'], [])).not.toMatch(/TodoWrite|TaskCreate/);
    expect(appendPromptFor(undefined, ['TodoWrite', 'TaskCreate'])).not.toMatch(/TodoWrite|TaskCreate/);
  });

  it('does not push a review or a question into edits', () => {
    const p = appendPromptFor(undefined, []);
    expect(p).toMatch(/question, a review or an explanation/);
    expect(p).toMatch(/do not edit files unless asked/);
    expect(p).not.toMatch(/proceed immediately to implementation/);
  });

  it('the auto-lean tool list keeps TodoWrite so the prompt never names a missing tool', () => {
    const m = /options\.tools = \[([^\]]*)\];\s*\n\s*isLean = true;/.exec(chatsSrc);
    expect(m && m[1]).toMatch(/'TodoWrite'/);
  });
});

describe('failed tool results', () => {
  const build = (content, extra = {}) => adapters.buildOpenAIBody({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content, ...extra }] },
    ],
  }, false, {});
  const toolMsg = (out) => out.messages.find((m) => m.role === 'tool').content;

  it('marks an error result as ERROR for OpenAI-format providers', () => {
    expect(toolMsg(build('permission denied', { is_error: true }))).toBe('ERROR: permission denied');
  });
  it('does not double the prefix', () => {
    expect(toolMsg(build('Error: ENOENT', { is_error: true }))).toBe('Error: ENOENT');
  });
  it('an empty error still says it failed', () => {
    expect(toolMsg(build('', { is_error: true }))).toBe('ERROR: (the tool failed with no output)');
  });
  it('a successful result is untouched', () => {
    expect(toolMsg(build('ok'))).toBe('ok');
  });
});
