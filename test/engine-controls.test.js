// Footbar controls of engine chats (model, mode, effort, context, compact): each
// CLI gets the ones it can do and the view leaves out the rest.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { argsFor, parseModelList, EngineChat } = require('../src/main/enginechat');
const { OpenCodeChat } = require('../src/main/opencodechat');
const ChatManager = require('../src/main/chats');

describe('Antigravity run flags', () => {
  const flags = (o) => argsFor('antigravity', { prompt: 'hi', ...o }).args;
  it('passes the chosen mode, model and effort on the run', () => {
    expect(flags({ mode: 'plan', model: 'gem-x', effort: 'high' })).toEqual(
      ['--output-format', 'stream-json', '--mode', 'plan', '--model', 'gem-x', '--effort', 'high', '-p=hi']);
    expect(flags({ mode: 'acceptEdits' })).toContain('accept-edits');
    expect(flags({ mode: 'auto' })).toContain('auto');
  });
  it('yolo skips permissions, and "ask" adds no mode flag', () => {
    expect(flags({ mode: 'bypassPermissions' })).toContain('--dangerously-skip-permissions');
    expect(flags({ yolo: true })).toContain('--dangerously-skip-permissions');
    expect(flags({ mode: 'default' })).not.toContain('--mode');
    expect(flags({ mode: 'default' })).not.toContain('--dangerously-skip-permissions');
  });
  it('reads the model list from `agy models` output, leaving headers out', () => {
    expect(parseModelList('Available models:\n  * gemini-3-pro  (default)\n  - gemini-3-flash\n\n')).toEqual(['gemini-3-pro', 'gemini-3-flash']);
    expect(parseModelList('')).toEqual([]);
  });
});

describe('Antigravity chat controls', () => {
  const mk = () => new EngineChat({ engine: 'antigravity', command: '/bin/true', cwd: '/tmp', env: {} });
  it('keeps what the footbar sets, for the next run', async () => {
    const ec = mk();
    await ec.q.setModel('gem-x');
    await ec.q.applyFlagSettings({ effort: 'max' });
    await ec.q.setPermissionMode('auto');
    expect([ec.model, ec.effort, ec.mode]).toEqual(['gem-x', 'max', 'auto']);
    expect(ec.effortLevels()).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    await expect(ec.q.setPermissionMode('nonsense')).rejects.toThrow(/no nonsense mode/);
  });
  it('has no compact and no context window, so the view leaves them out', () => {
    expect(mk().controls).toMatchObject({ compact: false, context: false });
  });
});

describe('OpenCode chat controls', () => {
  it('takes a typed-in model; mode, effort and compact are not offered', async () => {
    const oc = new OpenCodeChat({ command: '/bin/true', cwd: '/tmp', env: {} });
    expect(oc.controls).toEqual({ model: true, modes: null, effort: false, compact: false, context: false });
    await oc.q.setModel('cce/qwen');
    expect(oc.model).toBe('cce/qwen');
    expect(oc.effortLevels()).toEqual([]);
    await expect(oc.q.setPermissionMode('plan')).rejects.toThrow(/do not support setPermissionMode/);
  });
});

describe('the chat manager routes the footbar to the engine', () => {
  it('setModel and setMode reach the runner and keep the chat record in step', async () => {
    const cm = new ChatManager({});
    const made = cm.createEngine({ engine: 'antigravity', command: '/bin/true', cwd: '/tmp', env: {} });
    expect(await cm.setModel(made.id, 'gem-x')).toEqual({ model: 'gem-x' });
    const chat = cm.chats.get(made.id);
    expect(chat.model).toBe('Antigravity CLI · gem-x');
    expect(chat.engineMeta.model).toBe('gem-x');
    const r = await cm.setMode(made.id, 'bypassPermissions');
    expect(r.permissionMode).toBe('bypassPermissions');
    expect(chat.engineMeta.yolo).toBe(true);
    expect(chat.runner.mode).toBe('bypassPermissions');
    cm.close(made.id);
  });
  it('Codex reports every control; OpenCode only the model', () => {
    const cm = new ChatManager({});
    const cx = cm.createEngine({ engine: 'codex', command: '/bin/true', cwd: '/tmp', env: {} });
    expect(cx.capabilities).toMatchObject({ model: true, effort: true, compact: true, context: true, images: true, approvals: true });
    expect(cx.capabilities.modes.map((m) => m[0])).toEqual(['default', 'plan', 'bypassPermissions']);
    const oc = cm.createEngine({ engine: 'opencode', command: '/bin/true', cwd: '/tmp', env: {} });
    expect(oc.capabilities).toMatchObject({ model: true, modes: null, effort: false, compact: false, context: false });
    cm.close(cx.id); cm.close(oc.id);
  });
});
