import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoopGuard, isEditCall } = require('../src/main/loopguard.js');

let n = 0;
const run = (g, name, input, out = 'ok', err = false) => {
  const id = 'x' + (++n);
  const t = g.record({ id, name, input });
  g.result(id, out, err);
  return t;
};

describe('loop guard v2', () => {
  it('trips on the same edit made three times', () => {
    const g = createLoopGuard();
    const edit = { file_path: '/a.js', old_string: 'a', new_string: 'b' };
    expect(run(g, 'Edit', edit).tripped).toBe(false);
    run(g, 'Bash', { command: 'npm test' }, 'FAIL 1');
    expect(run(g, 'Edit', edit).tripped).toBe(false);
    run(g, 'Bash', { command: 'npm test' }, 'FAIL 1');
    expect(run(g, 'Edit', edit).tripped).toBe(true);
  });

  it('different edits are still progress', () => {
    const g = createLoopGuard();
    for (let i = 0; i < 6; i++) expect(run(g, 'Edit', { file_path: '/a.js', old_string: 'a' + i, new_string: 'b' }).tripped).toBe(false);
  });

  it('a shell edit with the same output three times is a repeat', () => {
    const g = createLoopGuard();
    const cmd = { command: 'npm test 2>&1 | tee log.txt' };
    run(g, 'Bash', cmd, 'FAIL'); run(g, 'Bash', cmd, 'FAIL');
    expect(run(g, 'Bash', cmd, 'FAIL').tripped).toBe(true);
  });

  it('catches a loop of four different calls', () => {
    const g = createLoopGuard();
    let tripped = false;
    for (let r = 0; r < 4 && !tripped; r++) {
      for (const f of ['a', 'b', 'c', 'd']) tripped = run(g, 'Read', { file_path: '/' + f }, 'same ' + f).tripped || tripped;
    }
    expect(tripped).toBe(true);
  });

  it('isEditCall knows writes and shell edits', () => {
    expect(isEditCall({ name: 'Write', input: {} })).toBe(true);
    expect(isEditCall({ name: 'Bash', input: { command: 'sed -i s/a/b/ f' } })).toBe(true);
    expect(isEditCall({ name: 'Bash', input: { command: 'ls' } })).toBe(false);
  });
});

describe('turn budget', () => {
  const { createBudget } = require('../src/main/loopguard.js');
  it('trips after N calls with no file change, and an edit resets the count', () => {
    const b = createBudget(5);
    for (let i = 0; i < 4; i++) expect(b.note({ name: 'Read', input: {} })).toBe(false);
    b.note({ name: 'Write', input: {} });
    for (let i = 0; i < 4; i++) expect(b.note({ name: 'Grep', input: {} })).toBe(false);
    expect(b.note({ name: 'Grep', input: {} })).toBe(true);
  });
  it('polling tools do not count; limit 0 is off', () => {
    const b = createBudget(2);
    for (let i = 0; i < 10; i++) expect(b.note({ name: 'TaskOutput', input: {} })).toBe(false);
    const off = createBudget(0);
    for (let i = 0; i < 500; i++) expect(off.note({ name: 'Read', input: {} })).toBe(false);
  });
});
