// Dictation: audio goes to a local speech engine (a venv on this machine) and
// nothing else. The engine is stubbed here; no model is needed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createDictation, MAX_BYTES } = require('../src/main/dictation.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dict-'));
const b64 = (s) => Buffer.from(s).toString('base64');

function make(over = {}) {
  const dir = tmp();
  const py = path.join(dir, 'python');
  fs.writeFileSync(py, '');
  const seen = { calls: [] };
  const execFile = over.execFile || ((cmd, args, opts, cb) => {
    seen.calls.push({ cmd, args, opts, exists: fs.existsSync(args[args.length - 1]), mode: fs.statSync(args[args.length - 1]).mode & 0o777 });
    cb(null, 'log line\n{"text":"hello world"}\n', '');
  });
  return { seen, dir, d: createDictation({ python: over.python || py, tmpDir: dir, execFile }) };
}

describe('dictation', () => {
  it('status says whether the engine is installed', () => {
    expect(make().d.status()).toEqual({ ok: true, ready: true });
    expect(make({ python: '/nope/python' }).d.status().ready).toBe(false);
  });
  it('transcribes through the stub, offline, with a private temp file that is removed', async () => {
    const { d, seen, dir } = make();
    const r = await d.transcribe({ audio: b64('RIFFdata') });
    expect(r).toEqual({ ok: true, text: 'hello world' });
    const c = seen.calls[0];
    expect(c.exists).toBe(true);
    expect(c.mode).toBe(0o600);
    expect(c.opts.env.HF_HUB_OFFLINE).toBe('1');
    expect(c.args[0]).toBe('-I');
    expect(fs.readdirSync(dir).filter((f) => f !== 'python')).toEqual([]);
  });
  it('refuses empty and oversized audio without running the engine', async () => {
    const { d, seen } = make();
    expect((await d.transcribe({ audio: '' })).ok).toBe(false);
    expect((await d.transcribe({ audio: Buffer.alloc(MAX_BYTES + 1).toString('base64') })).ok).toBe(false);
    expect(seen.calls.length).toBe(0);
  });
  it('says so when the engine is missing', async () => {
    const r = await make({ python: '/nope/python' }).d.transcribe({ audio: b64('x') });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not installed/i);
  });
  it('engine failure or junk output gives an error, and still cleans up', async () => {
    const bad = make({ execFile: (c, a, o, cb) => cb(new Error('boom'), '', 'trace') });
    expect((await bad.d.transcribe({ audio: b64('x') })).ok).toBe(false);
    expect(fs.readdirSync(bad.dir)).toEqual(['python']);
    const junk = make({ execFile: (c, a, o, cb) => cb(null, 'not json', '') });
    expect((await junk.d.transcribe({ audio: b64('x') })).ok).toBe(false);
  });
});
