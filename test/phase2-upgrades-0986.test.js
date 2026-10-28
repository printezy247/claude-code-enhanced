// Phase 2 of the 26-item upgrade pass (0.9.86):
//  6. a board of every live chat (busy / needs you / idle)
//  7. task → PR pipeline: worktree, run, commit, push, open the PR
//  8. background job queue with concurrency and cancel
//  9. Allow/Deny straight from the permission notification
// 10. interrupted runs are recorded and offered back on the next start
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Main is booted once per file: require() is cached, so a second __reset()
// would clear the handlers map without re-registering anything. Tests that
// need a clean notifications array clear it themselves.
let booted = null;
async function bootMain() {
  if (booted) return booted;
  const stub = require('electron');
  stub.__reset();
  require('../src/main/main.js');
  await sleep(250);
  booted = stub;
  return stub;
}

describe('session board (6)', () => {
  it('chats:board lists every live chat with busy and needsYou counts', async () => {
    const stub = await bootMain();
    const { chats } = require('../src/main/main.js');
    // Two live chats; one has a pending permission.
    chats.chats.set('c1', { cwd: '/tmp/a', busy: true, model: 'opus', sessionId: 's1' });
    chats.chats.set('c2', { cwd: '/tmp/b', busy: false, model: 'sonnet', sessionId: 's2' });
    chats.pendingPerms.set('r1', { chatId: 'c1', requestId: 'r1', toolName: 'Bash', input: {}, resolve: () => {}, suggestions: [] });
    try {
      const board = stub.__state.handlers.get('chats:board');
      expect(board, 'chats:board handler missing').toBeTruthy();
      const r = await board(null, {});
      expect(r.ok).toBe(true);
      const c1 = r.rows.find(x => x.id === 'c1');
      const c2 = r.rows.find(x => x.id === 'c2');
      expect(c1).toMatchObject({ busy: true, needsYou: 1, model: 'opus', sessionId: 's1' });
      expect(c2).toMatchObject({ busy: false, needsYou: 0 });
      expect(c1.cwd).toBe('/tmp/a');
    } finally {
      chats.chats.delete('c1');
      chats.chats.delete('c2');
      chats.pendingPerms.delete('r1');
    }
  });

  it('the renderer has a Board view wired into the nav and the switcher', () => {
    const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
    expect(html).toMatch(/data-view="board"/);
    expect(html).toMatch(/id="view-board"/);
    const board = fs.readFileSync(path.join(root, 'src', 'renderer', 'app', 'board.js'), 'utf8');
    expect(board).toMatch(/chats:board/);
    const tabs = fs.readFileSync(path.join(root, 'src', 'renderer', 'app', 'tabs.js'), 'utf8');
    expect(tabs).toMatch(/view === 'board'/);
  });
});

describe('task → PR pipeline (7)', () => {
  const { runToPR } = require('../src/main/pipeline.js');

  it('runs worktree → chat → commit → push → PR in order', async () => {
    const steps = [];
    const r = await runToPR({
      worktree: async () => { steps.push('worktree'); return { path: '/wt', root: '/wt', branch: 'cce/x', top: '/repo' }; },
      createChat: async (o) => { steps.push('chat'); return { id: 'c9', cwd: o.cwd }; },
      send: async (id, text) => { steps.push('send'); expect(text).toBe('do the thing'); },
      waitIdle: async (id) => { steps.push('wait'); },
      git: async (args, cwd) => { steps.push('git:' + args[0]); if (args[0] === 'remote') return 'git@github.com:me/repo.git\n'; return ''; },
      hasGh: async () => { steps.push('hasGh'); return true; },
      ghPr: async (args, cwd) => { steps.push('pr'); return 'https://github.com/me/repo/pull/1\n'; },
    }, { cwd: '/repo', prompt: 'do the thing', title: 'T' });
    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe('https://github.com/me/repo/pull/1');
    expect(steps).toEqual(['worktree', 'chat', 'send', 'wait', 'git:add', 'git:commit', 'git:push', 'hasGh', 'pr']);
  });

  it('falls back to a compare URL when gh is not installed', async () => {
    const r = await runToPR({
      worktree: async () => ({ path: '/wt', root: '/wt', branch: 'cce/y', top: '/repo' }),
      createChat: async () => ({ id: 'c1' }),
      send: async () => {},
      waitIdle: async () => {},
      git: async (args) => { if (args[0] === 'remote') return 'https://github.com/me/repo.git\n'; return ''; },
      hasGh: async () => false,
      ghPr: async () => { throw new Error('gh missing'); },
    }, { cwd: '/repo', prompt: 'p', title: 'T' });
    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe('https://github.com/me/repo/compare/cce/y');
  });

  it('stops before any git work when the worktree cannot be made', async () => {
    await expect(runToPR({
      worktree: async () => ({ error: 'not a git repository: /x' }),
      createChat: async () => { throw new Error('must not run'); },
      send: async () => {},
      waitIdle: async () => {},
      git: async () => { throw new Error('must not run'); },
      hasGh: async () => false,
      ghPr: async () => {},
    }, { cwd: '/x', prompt: 'p', title: 'T' })).rejects.toThrow(/not a git repository/);
  });
});

describe('background job queue (8)', () => {
  const { JobQueue } = require('../src/main/jobqueue.js');

  it('runs jobs one at a time and tracks their states', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const events = [];
    q.on('update', j => events.push([j.id, j.state]));
    const order = [];
    const a = q.add({ label: 'a', run: async () => { await sleep(30); order.push('a'); return 'A'; } });
    const b = q.add({ label: 'b', run: async () => { order.push('b'); return 'B'; } });
    await q.waitForIdle();
    expect(order).toEqual(['a', 'b']);   // concurrency 1: serial
    expect(a.state).toBe('done');
    expect(a.result).toBe('A');
    expect(b.state).toBe('done');
    expect(q.list().map(j => j.label)).toEqual(['a', 'b']);
    expect(events).toContainEqual([a.id, 'running']);
    expect(events).toContainEqual([a.id, 'done']);
  });

  it('a failing job is marked failed and the queue keeps going', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const bad = q.add({ label: 'bad', run: async () => { throw new Error('boom'); } });
    const good = q.add({ label: 'good', run: async () => 'ok' });
    await q.waitForIdle();
    expect(bad.state).toBe('failed');
    expect(bad.error).toMatch(/boom/);
    expect(good.state).toBe('done');
  });

  it('cancel stops a queued job before it ever runs', async () => {
    const q = new JobQueue({ concurrency: 1 });
    let ran = false;
    const first = q.add({ label: 'slow', run: () => sleep(40) });
    const second = q.add({ label: 'never', run: async () => { ran = true; } });
    expect(q.cancel(second.id)).toBe(true);
    await q.waitForIdle();
    expect(ran).toBe(false);
    expect(second.state).toBe('canceled');
    expect(first.state).toBe('done');
  });
});

describe('permission notification: Allow / Deny (9)', () => {
  it('a permission event raises a notification whose action answers the request', async () => {
    const stub = await bootMain();
    const { chats } = require('../src/main/main.js');
    let resolved = null;
    chats.pendingPerms.set('r9', {
      chatId: 'c9', requestId: 'r9', toolName: 'Bash',
      input: { command: 'ls' }, resolve: (v) => { resolved = v; }, suggestions: [],
    });
    try {
      stub.__state.notifications.length = 0;
      chats.emit('event', 'c9', { kind: 'permission', requestId: 'r9', toolName: 'Bash', input: { command: 'ls' } });
      const n = stub.__state.notifications.at(-1);
      expect(n, 'no notification was raised for the permission').toBeTruthy();
      expect(n.opts.actions, 'notification has no Allow/Deny actions').toBeTruthy();
      expect(n.opts.actions.map(a => a.text)).toEqual(['Allow', 'Deny']);
      // The user clicks Allow on the notification (Windows/macOS; Linux keeps click-to-focus).
      n.emit('action', { actionIndex: 0 });
      expect(resolved, 'Allow did not answer the pending permission').toBeTruthy();
      expect(resolved.behavior).toBe('allow');
      expect(chats.pendingPerms.has('r9')).toBe(false);
    } finally {
      chats.pendingPerms.delete('r9');
    }
  });

  it('the Deny action denies the tool call', async () => {
    const stub = await bootMain();
    const { chats } = require('../src/main/main.js');
    let resolved = null;
    chats.pendingPerms.set('r9b', {
      chatId: 'c9b', requestId: 'r9b', toolName: 'Bash',
      input: {}, resolve: (v) => { resolved = v; }, suggestions: [],
    });
    try {
      stub.__state.notifications.length = 0;
      chats.emit('event', 'c9b', { kind: 'permission', requestId: 'r9b', toolName: 'Bash' });
      const n = stub.__state.notifications.at(-1);
      n.emit('action', { actionIndex: 1 });
      expect(resolved).toBeTruthy();
      expect(resolved.behavior).toBe('deny');
    } finally {
      chats.pendingPerms.delete('r9b');
    }
  });
});

describe('interrupted-run resume (10)', () => {
  it('records a busy chat to disk and clears it when the turn ends', async () => {
    const stub = await bootMain();
    const { chats } = require('../src/main/main.js');
    const file = path.join(stub.__userDataDir(), 'interrupted-runs.json');
    try { fs.rmSync(file, { force: true }); } catch { /* absent */ }
    chats.chats.set('c10', { cwd: '/tmp/longrun', busy: false, model: 'opus', sessionId: 'sess-10' });
    try {
      chats.emit('event', 'c10', { kind: 'status', busy: true });
      let onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(onDisk.c10).toMatchObject({ cwd: '/tmp/longrun', sessionId: 'sess-10' });
      chats.emit('event', 'c10', { kind: 'status', busy: false });
      onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(onDisk.c10).toBeUndefined();
    } finally {
      chats.chats.delete('c10');
      try { fs.rmSync(file, { force: true }); } catch { /* absent */ }
    }
  });

  it('runs:interrupted lists what the last run left behind, and runs:ack forgets it', async () => {
    const stub = await bootMain();
    const file = path.join(stub.__userDataDir(), 'interrupted-runs.json');
    // What an interrupted previous run left on disk (no live chat holds the id).
    fs.writeFileSync(file, JSON.stringify({
      ghost: { id: 'ghost', cwd: '/tmp/ghost', sessionId: 'sess-ghost', model: 'sonnet', at: 1 },
    }));
    const list = stub.__state.handlers.get('runs:interrupted');
    expect(list, 'runs:interrupted handler missing').toBeTruthy();
    const r = await list(null, {});
    expect(r.ok).toBe(true);
    expect(r.runs.some(x => x.id === 'ghost' && x.sessionId === 'sess-ghost')).toBe(true);
    const ack = stub.__state.handlers.get('runs:ack');
    expect(ack, 'runs:ack handler missing').toBeTruthy();
    await ack(null, { id: 'ghost' });
    const r2 = await list(null, {});
    expect(r2.runs.some(x => x.id === 'ghost')).toBe(false);
  });

  it('the board view offers a Resume button per interrupted run', () => {
    const board = fs.readFileSync(path.join(root, 'src', 'renderer', 'app', 'board.js'), 'utf8');
    expect(board).toMatch(/runs:interrupted/);
    expect(board).toMatch(/Resume/);
    // Resume goes through the session API, which invokes chat:create with the
    // saved session id (src/renderer/chat/session.js).
    expect(board).toMatch(/createSession/);
    expect(fs.readFileSync(path.join(root, 'src', 'renderer', 'chat', 'session.js'), 'utf8')).toMatch(/chat:create/);
  });
});

describe('new IPC channels are in both halves (drift)', () => {
  it('preload allowlists exactly the new channels main handles', () => {
    const stub = require('electron');
    const prev = process.env.CCE_DEV;
    process.env.CCE_DEV = '1';
    try {
      delete require.cache[require.resolve('../src/preload/preload.js')];
      require('../src/preload/preload.js');
    } finally {
      if (prev == null) delete process.env.CCE_DEV; else process.env.CCE_DEV = prev;
    }
    const ccx = stub.__state.exposed.get('ccx');
    for (const ch of ['chats:board', 'jobs:list', 'jobs:add', 'jobs:cancel', 'pipeline:start', 'runs:interrupted', 'runs:ack']) {
      expect(ccx.__invokeChannels, 'preload missing ' + ch).toContain(ch);
    }
  });

  it('main registers a handler for each new channel', async () => {
    const stub = await bootMain();
    for (const ch of ['chats:board', 'jobs:list', 'jobs:add', 'jobs:cancel', 'pipeline:start', 'runs:interrupted', 'runs:ack']) {
      expect(stub.__state.handlers.has(ch), 'main missing handler ' + ch).toBe(true);
    }
  });
});
