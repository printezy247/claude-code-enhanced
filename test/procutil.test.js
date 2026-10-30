import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { terminate, appendTail, tail, capOutput, textOf, stubQuery } = require('../src/main/procutil');
const { aliasOf } = require('../src/main/toolcalls');
const { REGISTRY } = require('../src/main/engines');
const { frames } = require('../src/main/enginechat');
const ChatManager = require('../src/main/chats');

describe('procutil', () => {
  it('capOutput keeps head and tail of a long output and says what was left out', () => {
    const big = 'a'.repeat(30) + 'b'.repeat(100) + 'c'.repeat(30);
    const out = capOutput(big, 60);
    expect(out.startsWith('a'.repeat(30))).toBe(true);
    expect(out.endsWith('c'.repeat(30))).toBe(true);
    expect(out).toMatch(/100 characters left out/);
    expect(capOutput('short', 60)).toBe('short');
    expect(capOutput(null)).toBe('');
  });
  it('a tool result is capped, not passed through whole', () => {
    const f = frames.toolResult('s', 't1', 'x'.repeat(100_000), false);
    expect(f.message.content[0].content.length).toBeLessThan(41_000);
  });
  it('appendTail keeps the last characters; tail trims and marks a cut', () => {
    expect(appendTail('abc', 'def', 4)).toBe('cdef');
    expect(tail('  hi  ')).toBe('hi');
    expect(tail('x'.repeat(700), 10)).toBe('…' + 'x'.repeat(10));
  });
  it('textOf flattens a string, text blocks, and anything else', () => {
    expect(textOf('a')).toBe('a');
    expect(textOf([{ text: 'a' }, { type: 'image' }, { text: 'b' }])).toBe('a\n\nb');
    expect(textOf(null)).toBe('');
  });
  it('terminate stops the child and its whole process group', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    const exited = new Promise((r) => child.on('exit', r));
    terminate(child, { graceMs: 500 });
    await exited;
    expect(child.killedByUser).toBe(true);
    expect(() => process.kill(-child.pid, 0)).toThrow();   // the group is gone
  });
  it('stubQuery answers the panels and names the engine for anything else', async () => {
    const q = stubQuery('Codex', { interrupt: () => 'int', usage: () => ({ totalTokens: 5 }) });
    expect(await q.supportedModels()).toEqual([]);
    expect(await q.getContextUsage()).toEqual({ totalTokens: 5 });
    expect(q.interrupt()).toBe('int');
    await expect(q.setModel('x')).rejects.toThrow(/Codex chats do not support setModel/);
  });
});

describe('tool-name aliases', () => {
  it('aliasOf maps loose and short names to the built-in tool', () => {
    expect(aliasOf('bash')).toBe('Bash');
    expect(aliasOf('read_file')).toBe('Read');
    expect(aliasOf('webfetch')).toBe('WebFetch');
    expect(aliasOf('mystery')).toBe('');
  });
});

describe('engine registry drives the chat', () => {
  it('every engine says what its chat can do', () => {
    for (const e of REGISTRY) {
      expect(typeof e.images).toBe('boolean');
      expect(typeof e.approvals).toBe('boolean');
      expect(typeof e.providers).toBe('boolean');
      if (e.chat) expect(typeof require('../src/main/' + e.chat.module)[e.chat.cls]).toBe('function');
    }
  });
  it('createEngine returns the registry capabilities and a notification title', () => {
    const cm = new ChatManager({});
    const made = cm.createEngine({ engine: 'antigravity', command: '/bin/true', cwd: '/tmp', env: {} });
    expect(made.capabilities).toMatchObject({
      images: false, approvals: false, model: true, effort: true, compact: false, context: false, folder: true, workflows: true,
    });
    expect(made.capabilities.modes.map((m) => m[0])).toEqual(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);
    expect(cm.chats.get(made.id).title).toBe('Antigravity CLI');
    cm.close(made.id);
    expect(() => cm.createEngine({ engine: 'nope', command: 'x', cwd: '/tmp', env: {} })).toThrow(/unknown engine/);
  });
});
