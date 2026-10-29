// Batch A (1.0.0): engine IPC schema, ANSI cleanup in engine replies,
// interrupted-run recovery for engine chats, and the path-safety fixes.
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const { validateArgs } = require('../src/main/ipcschemas.js');
const { stripAnsi } = require('../src/main/ansi.js');
const { frames } = require('../src/main/enginechat.js');
const { createInterruptedStore } = require('../src/main/interrupted.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-batch-a-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp */ } });

describe('chat:create schema', () => {
  it('accepts what the renderer sends', () => {
    expect(validateArgs('chat:create', { cwd: '/p', providerUid: null, model: '', permissionMode: 'acceptEdits', resume: 'last', worktree: false })).toBeNull();
    expect(validateArgs('chat:create', { cwd: '/p', engine: 'codex', yolo: true, cliDefault: true })).toBeNull();
    expect(validateArgs('chat:create', {})).toBeNull();
  });
  it('refuses junk before it reaches the handler', () => {
    expect(validateArgs('chat:create', { engine: 'rm -rf' })).toMatch(/unknown engine/);
    expect(validateArgs('chat:create', { yolo: 'yes' })).toMatch(/true or false/);
    expect(validateArgs('chat:create', { permissionMode: 'wide-open' })).toMatch(/unknown permission mode/);
    expect(validateArgs('chat:create', { cwd: 7 })).toMatch(/string/);
    expect(validateArgs('chat:create', { model: { a: 1 } })).toMatch(/string/);
  });
  it('session:create takes the new model fields', () => {
    expect(validateArgs('session:create', { type: 'claude', model: 'm', cliDefault: true })).toBeNull();
    expect(validateArgs('session:create', { type: 'claude', cliDefault: 'x' })).toMatch(/true or false/);
  });
});

describe('ANSI in engine replies', () => {
  it('strips colour, cursor and OSC sequences', () => {
    expect(stripAnsi('\u001b[32mgreen\u001b[0m and \u001b[1;31mred\u001b[0m')).toBe('green and red');
    expect(stripAnsi('\u001b]0;title\u0007text')).toBe('text');
    expect(stripAnsi('\u001b[2K\u001b[1Gdone')).toBe('done');
    expect(stripAnsi(null)).toBe('');
  });
  it('every frame an engine runner builds is clean', () => {
    const dirty = '\u001b[31mfail\u001b[0m';
    expect(frames.textMsg('s', dirty).message.content[0].text).toBe('fail');
    expect(frames.thinkingMsg('s', dirty).message.content[0].thinking).toBe('fail');
    expect(frames.toolResult('s', 'i', dirty, true).message.content[0].content).toBe('fail');
    expect(frames.resultMsg('s', { ok: false, text: dirty, usage: {} }).result).toBe('fail');
  });
});

describe('interrupted engine runs', () => {
  it('keeps the session id an engine reports after the run started', () => {
    const store = createInterruptedStore(path.join(tmp, 'runs.json'));
    store.record({ id: 'c1', cwd: '/p', sessionId: null, engine: 'codex', providerUid: 'u1', model: 'm', yolo: false });
    store.touchSession('c1', 'thread-9');
    expect(store.list()[0]).toMatchObject({ engine: 'codex', sessionId: 'thread-9', providerUid: 'u1', model: 'm' });
    store.touchSession('gone', 'x');   // an unknown run is ignored
    store.forget('c1');
    expect(store.list()).toEqual([]);
  });
});

describe('path safety in the main process', () => {
  let loaded = null;
  // main.js registers its handlers once per require; reset only before the first.
  async function handlers() {
    if (!loaded) {
      const stub = require('electron');
      stub.__reset();
      require('../src/main/main.js');
      await new Promise((r) => setTimeout(r, 200));
      loaded = stub.__state.handlers;
    }
    return loaded;
  }

  it('skills:read reads a skill folder but not an arbitrary file', async () => {
    const h = await handlers();
    const read = h.get('skills:read');
    expect(read, 'skills:read missing').toBeTruthy();
    for (const p of ['/etc/hostname', '/etc/passwd', '~/.ssh/id_rsa', path.join(tmp, 'secret.txt')]) {
      const r = await read(null, { path: p });
      expect(r.ok, 'must refuse ' + p).toBe(false);
    }
  });

  it('shell:reveal refuses a path outside the tool-results folder, and a symlink out of it', async () => {
    const h = await handlers();
    const reveal = h.get('shell:reveal');
    expect((await reveal(null, { path: '/etc/hostname' })).ok).toBe(false);
    const spill = path.join(os.homedir(), '.claude', 'tool-results');
    fs.mkdirSync(spill, { recursive: true });
    const link = path.join(spill, 'cce-test-link-' + process.pid);
    try {
      fs.symlinkSync(tmp, link);
      expect((await reveal(null, { path: path.join(link, 'x.txt') })).ok).toBe(false);
    } finally { try { fs.unlinkSync(link); } catch { /* gone */ } }
  });

  it('memory:save will not write through a symlinked folder to another place', async () => {
    const h = await handlers();
    const save = h.get('memory:save');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-outside-'));
    const home = process.env.HOME || os.homedir();
    const dir = fs.mkdtempSync(path.join(home, '.cce-sym-'));
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'));
      const r = await save(null, { path: path.join(dir, 'link', 'CLAUDE.md'), content: 'x' });
      expect(r.ok).toBe(false);
      expect(fs.existsSync(path.join(outside, 'CLAUDE.md'))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
