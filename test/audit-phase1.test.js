// Regression tests for the 2026-10 audit, phase 1 (hardening).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const plugins = require('../src/main/plugins.js');
const tools = require('../src/main/tools.js');
const atomic = require('../src/main/atomic.js');
const connectors = require('../src/main/connectors.js');

const noRun = async () => ({ ok: true, output: '', error: null });

describe('plugin names', () => {
  it.each(['.', '..', '.hidden'])('uninstall rejects %s and keeps the plugins dir', async (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-audit-'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    const res = await plugins.uninstallPlugin({ name, targetDir: dir, run: noRun });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'keep.txt'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('zip bomb', () => {
  it('inflate is capped', () => {
    expect(plugins.MAX_ENTRY_BYTES).toBeGreaterThan(0);
    const bomb = zlib.deflateRawSync(Buffer.alloc(plugins.MAX_ENTRY_BYTES + 1024));
    expect(() => plugins.safeInflate(bomb, 10)).toThrow();
  });
});

describe('tool policy', () => {
  it('treats NotebookEdit as a write tool with a notebook_path target', () => {
    expect(tools.WRITE_TOOLS.has('NotebookEdit')).toBe(true);
    expect(tools.targetFilePath('NotebookEdit', { notebook_path: '/x/a.ipynb' })).toBe('/x/a.ipynb');
  });
});

describe('atomicWrite', () => {
  it('removes the temp file when the rename fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-audit-'));
    const target = path.join(dir, 'sub'); // a directory: rename onto it fails
    fs.mkdirSync(path.join(target, 'x'), { recursive: true });
    expect(() => atomic.atomicWrite(target, 'hi')).toThrow();
    expect(fs.readdirSync(dir)).toEqual(['sub']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('connectors.remove', () => {
  it('refuses a flag-shaped name without spawning anything', async () => {
    const res = await connectors.remove('/nonexistent/claude', { name: '--help' });
    expect(res.ok).toBe(false);
    expect(String(res.error || res.output)).toMatch(/invalid/i);
  });
});
