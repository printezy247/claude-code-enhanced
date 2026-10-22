// Regression tests for the 2026-10 audit, phase 2 (main-process reliability).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const proxy = require('../src/main/proxy.js');
const sdkoptions = require('../src/main/sdkoptions.js');

describe('pickToolSlot', () => {
  it('keeps chunks of one call together', () => {
    const buf = new Map();
    const k1 = proxy.pickToolSlot(buf, { index: 0, id: 'a' });
    buf.set(k1, { id: 'a', real: true });
    expect(proxy.pickToolSlot(buf, { index: 0 })).toBe(k1);
    expect(proxy.pickToolSlot(buf, { index: 0, id: 'a' })).toBe(k1);
  });
  it('splits parallel calls that reuse an index with a new id', () => {
    const buf = new Map([[0, { id: 'a', real: true }]]);
    const k2 = proxy.pickToolSlot(buf, { index: 0, id: 'b' });
    expect(k2).not.toBe(0);
  });
});

describe('session mirror store', () => {
  it('implements append/load per the SDK SessionStore contract', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cce-mirror-')), 'm.jsonl');
    const store = sdkoptions.createFileSessionStore(file);
    const k = { projectKey: 'p', sessionId: 's1' };
    expect(await store.load(k)).toBeNull();
    await store.append(k, [{ uuid: '1', type: 'user' }, { uuid: '2', type: 'assistant' }]);
    await store.append({ projectKey: 'p', sessionId: 's2' }, [{ uuid: '9' }]);
    await store.append(k, [{ uuid: '1', type: 'user' }]); // replay: deduped
    expect((await store.load(k)).map((e) => e.uuid)).toEqual(['1', '2']);
  });
});
