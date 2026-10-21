// Elicitation cards test (B7): accepts, declines, and cancels connector requests.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const ipcFor = (chatRes = {}, extra = {}) => ({
  'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1.2.3' }, home: '/home/test' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null, ...chatRes },
  'chat:elicit-answer': { ok: true },
  ...extra,
});

let h;
beforeEach(() => {
  h = loadRenderer({ ipc: ipcFor() });
});

describe('elicitation cards (B7)', () => {
  it('renders a url-mode elicitation card with Open, Authorized, Decline and Cancel buttons', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'elicitation', requestId: 'e1', mode: 'url',
      displayName: 'GitHub Connector', url: 'https://github.com/login/oauth/authorize?client_id=123',
    });
    const pane = h.window.document.querySelector('.chat-pane');
    const card = pane.querySelector('.perm-card.elic');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('GitHub Connector');
    const buttons = [...card.querySelectorAll('button')].map(b => b.textContent.trim());
    expect(buttons).toContain('Open authorization page');
    expect(buttons).toContain('I have authorized');
    expect(buttons).toContain('Decline');
    expect(buttons).toContain('Cancel');
  });

  it('renders a form-mode elicitation card with Submit, Decline and Cancel buttons', () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'elicitation', requestId: 'e2', mode: 'form',
      displayName: 'Jira Connector',
      message: 'Enter credentials',
      requestedSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', title: 'API Token' },
        },
      },
    });
    const pane = h.window.document.querySelector('.chat-pane');
    const card = pane.querySelector('.perm-card.elic');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Jira Connector');
    const buttons = [...card.querySelectorAll('button')].map(b => b.textContent.trim());
    expect(buttons).toContain('Submit');
    expect(buttons).toContain('Decline');
    expect(buttons).toContain('Cancel');
  });

  it('clicking Cancel sends action: cancel to chat:elicit-answer', async () => {
    h.window.Chat.handleEvent({
      id: 'c1', kind: 'elicitation', requestId: 'e3', mode: 'url',
      displayName: 'Slack Connector', url: 'https://slack.com/oauth',
    });
    const pane = h.window.document.querySelector('.chat-pane');
    const card = pane.querySelector('.perm-card.elic');
    const cancelBtn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel');
    expect(cancelBtn).toBeTruthy();
    cancelBtn.click();
    await flush();
    const calls = h.calls.filter(c => c.channel === 'chat:elicit-answer');
    expect(calls.length).toBe(1);
    expect(calls[0].payload.action).toBe('cancel');
    expect(calls[0].payload.requestId).toBe('e3');
  });
});
