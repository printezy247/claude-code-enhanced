// Phase 4.1: the artifact store. Content is kept once per hash, ids are
// safe file names, and nothing outside the store folder is ever read or written.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStore, KINDS, MAX_BYTES } = require('../src/main/artifacts.js');

let dir, store;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-art-')); store = createStore(dir); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('artifact store', () => {
  it('saves and reads back', () => {
    const a = store.save({ title: 'Plan', kind: 'markdown', content: '# hi' });
    expect(a.ok).toBe(true);
    expect(store.get(a.id)).toMatchObject({ ok: true, title: 'Plan', kind: 'markdown', content: '# hi' });
  });
  it('the same content is stored once', () => {
    const a = store.save({ title: 'A', kind: 'code', content: 'x = 1' });
    const b = store.save({ title: 'B', kind: 'code', content: 'x = 1' });
    expect(b.id).toBe(a.id);
    expect(b.duplicate).toBe(true);
    expect(store.list().length).toBe(1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).length).toBe(1);
  });
  it('lists newest first with a short preview', () => {
    store.save({ title: 'old', kind: 'code', content: 'a'.repeat(500) });
    store.save({ title: 'new', kind: 'code', content: 'b' });
    const l = store.list();
    expect(l[0].title).toBe('new');
    expect(l[1].preview.length).toBeLessThanOrEqual(120);
  });
  it('refuses unknown kinds, empty and oversize content', () => {
    expect(KINDS).toEqual(['markdown', 'code']);
    expect(store.save({ title: 'x', kind: 'exe', content: 'y' }).ok).toBe(false);
    expect(store.save({ title: 'x', kind: 'code', content: '' }).ok).toBe(false);
    expect(store.save({ title: 'x', kind: 'code', content: 'z'.repeat(MAX_BYTES + 1) }).ok).toBe(false);
  });
  it('only knows ids it made: no path tricks', () => {
    for (const id of ['../etc/passwd', '..', 'a/b', '', 'nope']) {
      expect(store.get(id).ok, id).toBe(false);
      expect(store.remove(id).ok, id).toBe(false);
    }
  });
  it('removes one', () => {
    const a = store.save({ title: 'A', kind: 'code', content: 'q' });
    expect(store.remove(a.id).ok).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.get(a.id).ok).toBe(false);
  });
  it('survives a restart and a damaged index', () => {
    store.save({ title: 'A', kind: 'code', content: 'q' });
    expect(createStore(dir).list().length).toBe(1);
    fs.writeFileSync(path.join(dir, 'index.json'), '{broken');
    expect(createStore(dir).list()).toEqual([]);
  });
  it('titles are trimmed and capped', () => {
    const a = store.save({ title: '  ' + 't'.repeat(300) + '  ', kind: 'code', content: 'w' });
    expect(store.get(a.id).title.length).toBeLessThanOrEqual(120);
  });
});

describe('pdfDocument', () => {
  const { pdfDocument, escapeHtml } = require('../src/main/artifacts.js');
  it('carries a policy that blocks scripts and every network request', () => {
    const d = pdfDocument('T', '<p>hi</p>');
    expect(d).toContain("default-src 'none'");
    expect(d).not.toMatch(/script-src[^;"]*(unsafe|\*)/);
    expect(d).toContain('<p>hi</p>');
  });
  it('escapes the title', () => {
    expect(pdfDocument('<b>x</b>', '')).not.toContain('<b>x</b>');
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
  it('code is shown as escaped text, never as markup', () => {
    const { codeToHtml } = require('../src/main/artifacts.js');
    expect(codeToHtml('<script>alert(1)</script>')).toBe('<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>');
  });
});

describe('wiring', () => {
  it('the channels are whitelisted and checked', () => {
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    const { schemaFor } = require('../src/main/ipcschemas.js');
    for (const ch of ['artifact:save', 'artifact:list', 'artifact:get', 'artifact:remove', 'artifact:export-pdf']) expect(preload, ch).toContain("'" + ch + "'");
    expect(schemaFor('artifact:save')).toBeTruthy();
    expect(require('../src/main/ipcschemas.js').validateArgs('artifact:save', { kind: 5, content: 'x' })).toBeTruthy();
  });
});
