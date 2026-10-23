// Regression tests for the 2026-10 audit follow-ups (0.9.42).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

describe('setBounded', () => {
  const { setBounded } = require('../src/main/boundedmap.js');
  it('evicts the oldest entry past the cap', () => {
    const m = new Map();
    for (let i = 0; i < 5; i++) setBounded(m, 'k' + i, i, 3);
    expect([...m.keys()]).toEqual(['k2', 'k3', 'k4']);
  });
  it('re-setting a key makes it the newest', () => {
    const m = new Map();
    setBounded(m, 'a', 1, 2); setBounded(m, 'b', 2, 2); setBounded(m, 'a', 3, 2); setBounded(m, 'c', 4, 2);
    expect([...m.keys()]).toEqual(['a', 'c']);
  });
});

describe('git status cache', () => {
  it('stays bounded across many directories', async () => {
    const gs = require('../src/main/gitsurface.js');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-gs-'));
    for (let i = 0; i < gs.STATUS_CACHE_MAX + 10; i++) {
      const d = path.join(base, 'd' + i); fs.mkdirSync(d);
      await gs.status(d);
    }
    expect(gs.statusCacheSize()).toBeLessThanOrEqual(gs.STATUS_CACHE_MAX);
  }, 60000);
});

describe('syncedSkillsPlugin caching', () => {
  it('does not rebuild when the skill set is unchanged', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-sync-'));
    process.env.HOME = home;
    const dir = path.join(home, '.claude', 'skills', 'synced', 'set1', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: alpha\n---\n');
    const { syncedSkillsPlugin } = require('../src/main/bootstrap.js');
    const p = syncedSkillsPlugin();
    fs.writeFileSync(path.join(p, 'marker'), 'x');
    expect(syncedSkillsPlugin()).toBe(p);
    expect(fs.existsSync(path.join(p, 'marker'))).toBe(true);
    const dir2 = path.join(home, '.claude', 'skills', 'synced', 'set1', 'beta');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'SKILL.md'), '---\nname: beta\n---\n');
    syncedSkillsPlugin();
    expect(fs.existsSync(path.join(p, 'marker'))).toBe(false);
    expect(fs.existsSync(path.join(p, 'skills', 'beta'))).toBe(true);
  });
});

describe('deviceCodeAuth onCode', () => {
  it('reports the code before polling for the token', async () => {
    const { deviceCodeAuth } = require('../src/main/mcpclient.js');
    const order = [];
    const f = async (url) => {
      if (String(url).includes('device')) {
        return new Response(JSON.stringify({ device_code: 'd', user_code: 'ABCD', verification_uri: 'https://x/v', interval: 0, expires_in: 60 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      order.push('token');
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await deviceCodeAuth({
      url: 'https://s', fetchImpl: f,
      oauth: { deviceUrl: 'https://x/device', tokenUrl: 'https://x/token' },
      onCode: (c) => order.push('code:' + c.userCode),
    });
    expect(order).toEqual(['code:ABCD', 'token']);
  });
});

describe('login shell probe', () => {
  it('parses env without a blocking call', async () => {
    const { probeLoginEnv } = require('../src/main/loginenv.js');
    const exec = (shell, args, opts, cb) => cb(null, 'PATH=/a:/b\nFOO=bar=baz\n');
    const env = await probeLoginEnv(exec, '/bin/bash');
    expect(env).toEqual({ PATH: '/a:/b', FOO: 'bar=baz' });
  });
  it('returns {} when the shell fails', async () => {
    const { probeLoginEnv } = require('../src/main/loginenv.js');
    expect(await probeLoginEnv((s, a, o, cb) => cb(new Error('boom')), '/bin/bash')).toEqual({});
  });
});

describe('swapChat (failover)', () => {
  const { swapChat } = require('../src/main/failover.js');
  it('closes the old chat then creates the new one', async () => {
    const calls = [];
    const chats = { close: (id) => calls.push('close:' + id), create: async (o) => { calls.push('create:' + o.tag); return { id: 'n' }; } };
    const r = await swapChat(chats, 'old', { tag: 'next' }, { tag: 'orig' }, 0);
    expect(r.id).toBe('n');
    expect(calls).toEqual(['close:old', 'create:next']);
  });
  it('restores the original chat when the new one fails to start', async () => {
    const calls = [];
    const chats = {
      close: () => calls.push('close'),
      create: async (o) => { calls.push('create:' + o.tag); if (o.tag === 'next') throw new Error('nope'); return { id: 'restored' }; },
    };
    await expect(swapChat(chats, 'old', { tag: 'next' }, { tag: 'orig' }, 0)).rejects.toThrow(/nope/);
    expect(calls).toEqual(['close', 'create:next', 'create:orig']);
  });
});

describe('loop guard', () => {
  const { createLoopGuard } = require('../src/main/loopguard.js');
  const bash = (command) => ({ name: 'Bash', input: { command } });
  it('trips on the same call repeated', () => {
    const g = createLoopGuard();
    expect(g.record({ name: 'Read', input: { file_path: '/a' } }).tripped).toBe(false);
    expect(g.record({ name: 'Read', input: { file_path: '/a' } }).tripped).toBe(false);
    expect(g.record({ name: 'Read', input: { file_path: '/a' } }).tripped).toBe(true);
  });
  it('trips on a run of echo-only shell calls with different text', () => {
    const g = createLoopGuard();
    let r;
    for (let i = 0; i < 5; i++) r = g.record(bash('echo "status ' + i + '"'));
    expect(r.tripped).toBe(true);
  });
  it('does not trip on normal varied work', () => {
    const g = createLoopGuard();
    const calls = [bash('ls'), { name: 'Read', input: { file_path: '/a' } }, bash('npm test'), { name: 'Edit', input: { file_path: '/a', old_string: 'x' } }, bash('echo done'), bash('git status')];
    expect(calls.map((c) => g.record(c).tripped)).not.toContain(true);
  });
  it('does not trip on a test, edit, test, edit, test fix cycle', () => {
    const g = createLoopGuard();
    const edit = (n) => ({ name: 'Edit', input: { file_path: '/a', old_string: 'x' + n } });
    const calls = [bash('npm test'), edit(1), bash('npm test'), edit(2), bash('npm test'), edit(3), bash('npm test')];
    expect(calls.map((c) => g.record(c).tripped)).not.toContain(true);
  });
  it('never stops a long run of different reads (investigating is not looping)', () => {
    const g = createLoopGuard();
    const trips = [];
    for (let i = 0; i < 30; i++) trips.push(g.record({ name: i % 2 ? 'Grep' : 'Read', input: { file_path: '/f' + i } }).tripped);
    expect(trips).not.toContain(true);
  });
  it('reset clears the history', () => {
    const g = createLoopGuard();
    g.record(bash('echo 1')); g.record(bash('echo 2')); g.record(bash('echo 3')); g.record(bash('echo 4'));
    g.reset();
    expect(g.record(bash('echo 5')).tripped).toBe(false);
  });
});

describe('shareablePath', () => {
  const { shareablePath, absFor } = require('../src/main/fileshare.js');
  it('allows only files the agent wrote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-share-'));
    const f = path.join(dir, 'out.txt'); fs.writeFileSync(f, 'hi');
    const other = path.join(dir, 'other.txt'); fs.writeFileSync(other, 'no');
    const written = new Set([absFor(dir, 'out.txt')]);
    expect(shareablePath(written, dir, 'out.txt')).toBe(fs.realpathSync(f));
    expect(shareablePath(written, dir, 'other.txt')).toBe(null);
    expect(shareablePath(written, dir, 'missing.txt')).toBe(null);
  });
  it('rejects directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-share-'));
    expect(shareablePath(new Set([dir]), dir, dir)).toBe(null);
  });
});
