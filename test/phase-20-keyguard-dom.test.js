// @vitest-environment jsdom
// The pasted-key guard on real DOM: it holds the send, and each button does what it says.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CCESecrets = require('../src/shared/secrets.js');
const src = readFileSync(path.join(__dirname, '..', 'src/renderer/chat/keyguard.js'), 'utf8');
const body = src.slice(src.indexOf('export function guardSecrets'));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
// eslint-disable-next-line no-new-func
const guard = new Function('el', 'scrollDownSoft', 'CCESecrets', body.replace('export function', 'return function'))(el, () => {}, CCESecrets);

const KEY = 'sk-ant-api03-' + 'z'.repeat(40);
let chat; let sent;
beforeEach(() => {
  chat = { msgs: document.createElement('div'), composer: Object.assign(document.createElement('textarea'), { value: 'use ' + KEY }) };
  sent = 0;
});
const click = (label) => [...chat.msgs.querySelectorAll('button')].find((b) => b.textContent.startsWith(label)).click();

describe('guardSecrets', () => {
  it('lets a normal message through', () => {
    expect(guard(chat, 'hello', () => sent++)).toBe(false);
    expect(chat.msgs.children.length).toBe(0);
  });
  it('holds a message with a key and shows one card', () => {
    expect(guard(chat, 'use ' + KEY, () => sent++)).toBe(true);
    expect(guard(chat, 'use ' + KEY, () => sent++)).toBe(true);
    expect(chat.msgs.querySelectorAll('.key-guard')).toHaveLength(1);
    expect(sent).toBe(0);
  });
  it('"Hide the key and send" puts the redacted text in the box and resends', () => {
    guard(chat, chat.composer.value, () => { sent++; expect(guard(chat, chat.composer.value, () => {})).toBe(false); });
    click('Hide the key');
    expect(chat.composer.value).toBe('use «anthropic key hidden»');
    expect(sent).toBe(1);
    expect(chat.msgs.querySelector('.key-guard')).toBeNull();
  });
  it('"Send anyway" resends the text untouched, once', () => {
    guard(chat, chat.composer.value, () => sent++);
    click('Send anyway');
    expect(sent).toBe(1);
    expect(chat.composer.value).toContain(KEY);
    expect(chat._keyOk).toBe(true);
  });
  it("\"Don't send\" sends nothing and keeps the text", () => {
    guard(chat, chat.composer.value, () => sent++);
    click("Don't send");
    expect(sent).toBe(0);
    expect(chat.composer.value).toContain(KEY);
    expect(chat.msgs.querySelector('.key-guard')).toBeNull();
  });
});
