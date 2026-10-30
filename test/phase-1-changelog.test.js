// Phase 1.7: each version has one heading in the CHANGELOG.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('CHANGELOG', () => {
  it('has no version heading twice', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
    const heads = text.split('\n').filter((l) => /^## \d/.test(l));
    const dup = heads.filter((h, i) => heads.indexOf(h) !== i);
    expect(dup).toEqual([]);
  });
});
