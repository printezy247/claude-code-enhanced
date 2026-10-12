// Permission modes: four on offer (auto, accept edits, plan, yolo). Manual maps to
// accept edits, and auto falls back to accept edits on a third-party provider
// because the classifier that powers it would run on that provider's model.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ChatManager = require('../src/main/chats.js');
const { normalizeMode, MODES } = ChatManager;

let lastOptions = null;
let ctrl = null;
const fakeSdk = {
  query: ({ options }) => {
    lastOptions = options;
    ctrl = { setPermissionMode: vi.fn(async () => {}), interrupt: vi.fn(async () => ({})) };
    const gen = (async function* () { await new Promise(() => {}); })();
    return Object.assign(gen, ctrl);
  },
};

const THIRD_PARTY = { uid: 'p1', name: 'Alibaba', baseUrl: 'https://dashscope.example/v1', protocol: 'openai' };

let mgr;
beforeEach(() => {
  lastOptions = null;
  mgr = new ChatManager({ proxyToken: 'tok', sdk: fakeSdk });
});

describe('normalizeMode', () => {
  it('offers exactly four modes', () => {
    expect(MODES).toEqual(['auto', 'acceptEdits', 'plan', 'bypassPermissions']);
  });

  it('maps manual ("default") and unknown values to accept edits', () => {
    expect(normalizeMode('default')).toBe('acceptEdits');
    expect(normalizeMode('dontAsk')).toBe('acceptEdits');
    expect(normalizeMode(undefined)).toBe('acceptEdits');
    expect(normalizeMode('nonsense')).toBe('acceptEdits');
  });

  it('keeps the four real modes', () => {
    expect(normalizeMode('acceptEdits')).toBe('acceptEdits');
    expect(normalizeMode('plan')).toBe('plan');
    expect(normalizeMode('bypassPermissions')).toBe('bypassPermissions');
    expect(normalizeMode('auto', null)).toBe('auto');
  });

  it('lets yolo override everything', () => {
    expect(normalizeMode('plan', THIRD_PARTY, true)).toBe('bypassPermissions');
  });

  it('falls back from auto to accept edits on a third-party provider', () => {
    expect(normalizeMode('auto', THIRD_PARTY)).toBe('acceptEdits');
    expect(normalizeMode('auto', { uid: 'a', baseUrl: '' })).toBe('auto');
  });
});

describe('chat creation and switching', () => {
  it('starts a "normal" request in accept edits', async () => {
    const res = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {}, permissionMode: 'default' });
    expect(lastOptions.permissionMode).toBe('acceptEdits');
    expect(res.permissionMode).toBe('acceptEdits');
  });

  it('keeps auto for Anthropic itself and drops it for a third-party provider', async () => {
    await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {}, permissionMode: 'auto' });
    expect(lastOptions.permissionMode).toBe('auto');
    const res = await mgr.create({ cwd: '/tmp', providerInstance: THIRD_PARTY, settings: {}, permissionMode: 'auto', anthropicBaseUrl: 'http://127.0.0.1:1/p' });
    expect(lastOptions.permissionMode).toBe('acceptEdits');
    expect(res.permissionMode).toBe('acceptEdits');
  });

  it('answers a switch to auto on a third-party chat with the mode actually applied', async () => {
    const { id } = await mgr.create({ cwd: '/tmp', providerInstance: THIRD_PARTY, settings: {}, permissionMode: 'plan', anthropicBaseUrl: 'http://127.0.0.1:1/p' });
    const r = await mgr.setMode(id, 'auto');
    expect(ctrl.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(r).toEqual({ permissionMode: 'acceptEdits', changed: true });
  });

  it('applies a normal switch unchanged', async () => {
    const { id } = await mgr.create({ cwd: '/tmp', providerInstance: null, settings: {} });
    const r = await mgr.setMode(id, 'plan');
    expect(ctrl.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(r).toEqual({ permissionMode: 'plan', changed: false });
  });
});
