import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const w = require('../src/main/workers/index.js');
const impl = require('../src/main/workers/impl.js');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

describe('workers (B10)', () => {
  it('file-index worker matches in-process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-w-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'y');
    const r1 = await w.run('file-index', { dir });
    const r2 = impl.indexFiles({ dir });
    expect(r1).toEqual(r2);
  });

  it('transcript-search worker matches in-process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-w-'));
    const f = path.join(dir, 't.jsonl');
    fs.writeFileSync(f, '{"content":"hello world"}\n{"content":"other"}\n');
    const payload = { query: 'hello', files: [f] };
    const r1 = await w.run('transcript-search', payload);
    const r2 = impl.searchTranscripts(payload);
    expect(r1).toEqual(r2);
  });

  it('shell-path worker matches in-process', async () => {
    const r1 = await w.run('shell-path', { shell: '/bin/bash' });
    const r2 = impl.resolveShellPath({ shell: '/bin/bash' });
    expect(r1.shell).toBe(r2.shell);
    expect(r1.path).toBe(r2.path);
  });

  it('falls back to in-process when worker cannot spawn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-w-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const r = await w.run('file-index', { dir }, { workerScript: '/tmp/does-not-exist-worker.js' });
    expect(r).toEqual(impl.indexFiles({ dir }));
  });

  it('inProcess helper works', () => {
    const r = w.inProcess('file-index', { dir: '/tmp' });
    expect(Array.isArray(r)).toBe(true);
  });
});