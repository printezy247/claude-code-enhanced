// 0.25.1 fixes: chat scrollbar setting, connector counts and the "not ready" note,
// skill text drawn as a user message, a plan card that ignored the composer, and a
// false "no auth" label.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { classifyUserText } = require('../src/shared/usertext.js');
const G = require('../src/shared/mcpgroup.js');
const { normalizeScrollbar, normalizeNoticeScope } = require('../src/shared/uiprefs.js');
const { permTimeoutMs } = require('../src/main/chats.js');

const root = path.join(__dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const css = read('src/renderer/styles.css');
const rule = (selector) => {
  const at = css.indexOf(selector + ' {');
  expect(at, 'rule missing: ' + selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

describe('chat scrollbar setting', () => {
  it('only accepts accent, hidden or default; anything else is accent', () => {
    expect(normalizeScrollbar('hidden')).toBe('hidden');
    expect(normalizeScrollbar('default')).toBe('default');
    expect(normalizeScrollbar('accent')).toBe('accent');
    expect(normalizeScrollbar('neon')).toBe('accent');
    expect(normalizeScrollbar(undefined)).toBe('accent');
  });
  it('is stored, validated on save, applied at boot and offered in Settings', () => {
    expect(read('src/main/store.js')).toMatch(/scrollbar: 'accent'/);
    expect(read('src/main/main.js')).toMatch(/incoming\.scrollbar = normalizeScrollbar/);
    expect(read('src/renderer/main.js')).toMatch(/applyScrollbar\(state\.settings\.scrollbar\)/);
    expect(read('src/renderer/app/settings.js')).toMatch(/Chat scrollbar/);
    expect(read('src/renderer/app/settings.js')).toMatch(/scrollbar: sbSel\.value/);
  });
  it('styles the conversation: orange see-through, or hidden', () => {
    expect(rule('html[data-scrollbar="accent"] .chat-msgs')).toMatch(/scrollbar-color:[^;]*var\(--accent\)[^;]*transparent/);
    expect(rule('html[data-scrollbar="hidden"] .chat-msgs')).toMatch(/scrollbar-width:\s*none/);
    expect(rule('html[data-scrollbar="hidden"] .chat-msgs::-webkit-scrollbar')).toMatch(/display:\s*none/);
  });
  it('keeps the jump rail clear of a visible scrollbar', () => {
    expect(css).toMatch(/html:not\(\[data-scrollbar="hidden"\]\) \.req-rail:not\(\.empty\) \{ right: 12px; \}/);
  });
});

const plug = (plugin, svc, status) => ({ name: 'plugin:' + plugin + ':' + svc, status });
const many = [
  { name: 'github', status: 'connected' },
  { name: 'my-db', status: 'failed' },
  { name: 'old', status: 'disabled' },
  ...['sales', 'finance', 'legal', 'data'].map((p) => plug(p, 'google-calendar', 'failed')),
  ...['sales', 'finance', 'legal'].map((p) => plug(p, 'slack', 'needs-auth')),
];

describe('connector grouping', () => {
  it('folds plugin copies into one row per connector and status', () => {
    const g = G.groupServers(many);
    const cal = g.groups.find((x) => x.label === 'google-calendar');
    expect(cal.count).toBe(4);
    expect(cal.plugins).toEqual(['sales', 'finance', 'legal', 'data']);
    expect(g.groups.filter((x) => x.label === 'slack')).toHaveLength(1);
  });
  it('counts only working and broken connectors in the badge', () => {
    const g = G.groupServers(many);
    expect(g.counts).toMatchObject({ live: 1, failed: 5, auth: 3, off: 1 });
    expect(g.badge).toBe('1/6');
    expect(G.summaryText(g.counts)).toBe('1 live · 5 failed · 3 sign-in');
  });
  it('shows 0 when nothing is judged', () => {
    expect(G.groupServers([]).badge).toBe('0');
    expect(G.groupServers([{ name: 'a', status: 'needs-auth' }]).badge).toBe('0');
  });
  it('orders working first, then failed, then sign-in, then off', () => {
    expect(G.groupServers(many).groups.map((x) => x.bucket)).toEqual(['live', 'failed', 'failed', 'auth', 'off']);
  });
});

describe('"connectors not ready" note', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => plug('p' + i, 'google-calendar', i % 2 ? 'failed' : 'needs-auth'));
  it('is one short line with the names folded, never the whole list', () => {
    const n = G.notReadyNotice([...many, ...hundred], 'all');
    expect(n.summary.length).toBeLessThan(120);
    expect(n.summary).not.toMatch(/plugin:/);
    expect(n.lines.some((l) => l.includes('google-calendar ×'))).toBe(true);
    expect(n.lines.length).toBeLessThan(10);
  });
  it("'mine' leaves plugin copies out and keeps the user's own connectors", () => {
    const n = G.notReadyNotice(many, 'mine');
    expect(n.lines).toEqual(['my-db (failed)']);
    expect(G.notReadyNotice(hundred, 'mine')).toBeNull();
  });
  it('says nothing when everything is fine or switched off', () => {
    expect(G.notReadyNotice([{ name: 'a', status: 'connected' }, { name: 'b', status: 'disabled' }], 'all')).toBeNull();
  });
  it('scope setting is validated', () => {
    expect(normalizeNoticeScope('all')).toBe('all');
    expect(normalizeNoticeScope('x')).toBe('mine');
  });
  it('is drawn as a rounded box, not a pill, so wrapped text cannot turn into an oval', () => {
    expect(rule('.sys-note.multi')).toMatch(/border-radius:\s*10px/);
    expect(read('src/renderer/chat/events.js')).toMatch(/'sys-note multi mcp-notice'/);
    expect(read('src/renderer/chat/events.js')).not.toMatch(/MCP not ready: '/);
  });
  it('the Overview card uses the grouping for its badge', () => {
    expect(read('src/renderer/app/overview.js')).toMatch(/groupServers\(servers\)/);
    expect(read('src/renderer/app/overview.js')).toMatch(/conn\.badge\.textContent = grouped\.badge/);
  });
});

describe('skill text is not a user message', () => {
  const body = 'Base directory for this skill: /home/jack/.cache/skills/caveman\n\nRespond terse like smart caveman.';
  it('a live record flagged isSynthetic becomes a folded note with a label', () => {
    const k = classifyUserText(body, { isSynthetic: true });
    expect(k.kind).toBe('note');
    expect(k.label).toBe('skill instructions · caveman');
  });
  it('is recognised by its text even without a flag', () => {
    expect(classifyUserText(body).kind).toBe('note');
  });
  it('isMeta is still skipped and real prompts are untouched', () => {
    expect(classifyUserText('x', { isMeta: true }).kind).toBe('skip');
    expect(classifyUserText('fix the bug')).toEqual({ kind: 'prompt', text: 'fix the bug' });
  });
});

describe('plan card and the composer', () => {
  it('a plan or a question waits 30 minutes, other tools 6', () => {
    expect(permTimeoutMs('ExitPlanMode')).toBe(30 * 60_000);
    expect(permTimeoutMs('AskUserQuestion')).toBe(30 * 60_000);
    expect(permTimeoutMs('Bash')).toBe(6 * 60_000);
  });
  it('text typed while a plan card waits goes to it as keep-planning feedback', () => {
    expect(read('src/renderer/chat/permissions.js')).toMatch(/export function answerPlanWithText/);
    expect(read('src/renderer/chat/permissions.js')).toMatch(/card\._keepPlanning = keepPlanning/);
    expect(read('src/renderer/chat/session.js')).toMatch(/answerPlanWithText\(chat, text\)/);
  });
});

describe('sign-in label', () => {
  it('"none" is an account login unless a sign-in actually failed', () => {
    const src = read('src/renderer/chat/status.js');
    const fn = src.slice(src.indexOf('export function authLabel'), src.indexOf('export function setStatusLine'));
    // eslint-disable-next-line no-new-func
    const authLabel = new Function(fn.replace('export function', 'return function'))();
    expect(authLabel('none', false, false)).toBe('account login');
    expect(authLabel('none', false, true)).toMatch(/^no auth/);
    expect(authLabel('none', true, false)).toBe('provider key');
    expect(authLabel('user', false, false)).toBe('user');
  });
});
