// Phase 3 (0.9.70): the loop guard judges work by its results. A repeat only
// counts when nothing new came back; a file change (including a shell edit)
// is progress; polling is waiting; subagents have their own history; the
// same error again and again is a loop; the first trip redirects, the second
// stops.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLoopGuard } = require('../src/main/loopguard.js');

let n = 0;
const call = (name, input) => ({ id: 'tu' + ++n, name, input });
const bash = (command) => call('Bash', { command });
const read = (p) => call('Read', { file_path: p });

// Record a call, then give back its result.
function run(g, block, result = 'ok', isError = false, scope = '') {
  const trip = g.record(block, scope);
  g.result(block.id, result, isError);
  return trip;
}

describe('repeats are judged by result', () => {
  it('trips when the same call keeps returning the same thing', () => {
    const g = createLoopGuard();
    const trips = [0, 1, 2].map(() => run(g, bash('gh run list'), 'in_progress'));
    expect(trips.map((t) => t.tripped)).toEqual([false, false, true]);
    expect(trips[2].reason).toMatch(/Bash call 3 times/);
  });
  it('does not trip when the result keeps changing (watching a build)', () => {
    const g = createLoopGuard();
    const results = ['queued', 'in_progress 1/5', 'in_progress 3/5', 'in_progress 5/5', 'success'];
    const trips = results.map((r) => run(g, bash('gh run list'), r));
    expect(trips.map((t) => t.tripped)).not.toContain(true);
  });
  it('still trips when the result stops changing after it had changed', () => {
    const g = createLoopGuard();
    const r = ['a', 'b', 'b', 'b'].map((x) => run(g, bash('check'), x));
    expect(r.map((t) => t.tripped)).toEqual([false, false, false, true]);
  });
  it('parallel calls with no result yet still count', () => {
    const g = createLoopGuard();
    const t = [g.record(read('/a')), g.record(read('/a')), g.record(read('/a'))];
    expect(t[2].tripped).toBe(true);
  });
});

describe('progress', () => {
  it('a shell edit clears the history like an Edit does', () => {
    for (const cmd of ['echo hi > out.txt', 'sed -i "s/a/b/" f.js', 'cat x | tee out.log', 'mv a b', 'git commit -m x']) {
      const g = createLoopGuard();
      run(g, bash('npm test'), 'fail'); run(g, bash('npm test'), 'fail');
      run(g, bash(cmd));
      expect(run(g, bash('npm test'), 'fail').tripped).toBe(false);
    }
  });
  it('2>&1 and /dev/null are not edits', () => {
    const g = createLoopGuard();
    run(g, bash('npm test 2>&1'), 'fail'); run(g, bash('npm test 2>&1 >/dev/null'), 'fail');
    run(g, bash('npm test 2>&1'), 'fail');
    run(g, bash('ls 2>/dev/null'), 'x'); run(g, bash('ls 2>/dev/null'), 'x');
    expect(run(g, bash('ls 2>/dev/null'), 'x').tripped).toBe(true);
  });
  it('test, edit, test, edit, test is a fix cycle', () => {
    const g = createLoopGuard();
    const edit = (i) => call('Edit', { file_path: '/a', old_string: 'x' + i });
    const seq = [bash('npm test'), edit(1), bash('npm test'), edit(2), bash('npm test'), edit(3), bash('npm test')];
    expect(seq.map((b) => run(g, b, 'FAIL').tripped)).not.toContain(true);
  });
});

describe('polling is waiting', () => {
  it('never trips on a polling tool', () => {
    const g = createLoopGuard();
    for (let i = 0; i < 12; i++) {
      expect(run(g, call('TaskOutput', { task_id: 't1' }), 'still running').tripped).toBe(false);
    }
  });
});

describe('subagents have their own guard', () => {
  it('a subagent repeating itself does not trip the main agent, or the reverse', () => {
    const g = createLoopGuard();
    run(g, read('/a'), 'x', false, 'sub1'); run(g, read('/a'), 'x', false, 'sub1');
    expect(run(g, read('/a'), 'x', false, '').tripped).toBe(false);
    expect(run(g, read('/a'), 'x', false, 'sub1').tripped).toBe(true);
  });
  it('two subagents are judged separately', () => {
    const g = createLoopGuard();
    run(g, read('/a'), 'x', false, 's1'); run(g, read('/a'), 'x', false, 's2');
    run(g, read('/a'), 'x', false, 's1');
    expect(run(g, read('/a'), 'x', false, 's2').tripped).toBe(false);
  });
});

describe('the same error again and again', () => {
  it('trips the next call after three identical errors, even from different calls', () => {
    const g = createLoopGuard();
    run(g, bash('make a'), 'ERROR: no rule', true);
    run(g, bash('make b'), 'ERROR: no rule', true);
    run(g, bash('make c'), 'ERROR: no rule', true);
    const next = g.record(bash('make d'));
    expect(next.tripped).toBe(true);
    expect(next.reason).toMatch(/same error 3 times/);
  });
  it('different errors do not add up, and a success resets the count', () => {
    const g = createLoopGuard();
    run(g, bash('a'), 'ERROR: one', true); run(g, bash('b'), 'ERROR: two', true);
    run(g, bash('c'), 'fine'); run(g, bash('d'), 'ERROR: one', true);
    run(g, bash('e'), 'ERROR: one', true);
    expect(g.record(bash('f')).tripped).toBe(false);
  });
  it('an Edit that keeps failing the same way is caught', () => {
    const g = createLoopGuard();
    for (let i = 0; i < 3; i++) run(g, call('Edit', { file_path: '/a', old_string: 'q' + i }), 'ERROR: file has not been read yet', true);
    expect(g.record(call('Edit', { file_path: '/a', old_string: 'z' })).tripped).toBe(true);
  });
});

describe('redirect, then stop', () => {
  const loop = (g) => { let t; for (let i = 0; i < 3; i++) t = run(g, bash('same'), 'same'); return t; };
  it('the first trip is strike 1; looping again without progress is strike 2', () => {
    const g = createLoopGuard();
    expect(loop(g).strike).toBe(1);
    expect(loop(g).strike).toBe(2);
  });
  it('denial() names the reason for the tripped call only, and only at strike 1', () => {
    const g = createLoopGuard();
    let last;
    for (let i = 0; i < 3; i++) { last = bash('same'); g.record(last); g.result(last.id, 'same'); }
    expect(g.known(last.id)).toBe(true);
    expect(g.denial(last.id)).toMatch(/same Bash call/);
    let again;
    for (let i = 0; i < 3; i++) { again = bash('same'); g.record(again); g.result(again.id, 'same'); }
    expect(g.denial(again.id)).toBe('');   // strike 2 stops the turn instead
  });
  it('progress after a redirect gives the agent a fresh start', () => {
    const g = createLoopGuard();
    loop(g);
    run(g, call('Edit', { file_path: '/a', old_string: 'x' }), 'ok');
    expect(loop(g).strike).toBe(1);
  });
  it('recording the same call id twice returns the first verdict', () => {
    const g = createLoopGuard();
    const b = bash('x');
    expect(g.record(b)).toBe(g.record(b));
  });
  it('reset forgets everything', () => {
    const g = createLoopGuard();
    loop(g);
    g.reset();
    expect(loop(g).strike).toBe(1);
  });
});

describe('what the earlier guard already guaranteed', () => {
  it('trips on a run of echo-only shell calls with different text', () => {
    const g = createLoopGuard();
    let r;
    for (let i = 0; i < 5; i++) r = run(g, bash('echo "status ' + i + '"'));
    expect(r.tripped).toBe(true);
  });
  it('never stops a long run of different reads', () => {
    const g = createLoopGuard();
    const trips = [];
    for (let i = 0; i < 30; i++) trips.push(run(g, call(i % 2 ? 'Grep' : 'Read', { file_path: '/f' + i })).tripped);
    expect(trips).not.toContain(true);
  });
});
