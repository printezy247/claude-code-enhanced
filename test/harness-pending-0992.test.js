// Follow-ups from the 0.9.91 harness review: waiting on CI is not a loop,
// generic words do not switch on unrelated connectors, a connector picked for
// one message is kept for the next one, and workflows can say how to finish.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { cleanOptions, buildPrompt, mergeOptions, BASE_OPTIONS, FINISH_LINES } from '../src/renderer/chat/wfoptions.js';

const require = createRequire(import.meta.url);
const { createLoopGuard } = require('../src/main/loopguard.js');
const connectorauto = require('../src/main/connectorauto.js');

let n = 0;
const call = (name, input) => ({ id: 'id' + (++n), name, input });
const run = (g, block, out = 'same result') => { const t = g.record(block, ''); g.result(block.id, out, false); return t; };

describe('polling is waiting, not looping', () => {
  it('the same status check with a sleep in between never trips', () => {
    const g = createLoopGuard();
    const check = () => call('mcp__github__pull_request_read', { method: 'get_check_runs', pullNumber: 107 });
    for (let i = 0; i < 6; i++) {
      expect(run(g, call('Bash', { command: 'sleep ' + (60 + i) })).tripped).toBe(false);
      expect(run(g, check(), '{"status":"in_progress"}').tripped).toBe(false);
    }
  });

  it('the same sleep-then-check shell command several times never trips', () => {
    const g = createLoopGuard();
    for (let i = 0; i < 6; i++) expect(run(g, call('Bash', { command: 'sleep 30; gh run view 1' })).tripped).toBe(false);
  });

  it('a connector status tool is waited on even without a sleep', () => {
    const g = createLoopGuard();
    for (let i = 0; i < 5; i++) expect(run(g, call('mcp__ci__get_job_status', { job: 3 })).tripped).toBe(false);
  });

  it('the same read three times with no wait is still a loop', () => {
    const g = createLoopGuard();
    const read = () => call('Read', { file_path: '/a' });
    run(g, read()); run(g, read());
    expect(run(g, read()).tripped).toBe(true);
  });
});

describe('connector topic words', () => {
  const want = (s) => connectorauto.words(s);
  it('generic words do not pull in Slack, Sentry or Notion', () => {
    const prompt = want('fix this error message in the thread, then update the doc page and the workflow');
    for (const name of ['slack', 'sentry', 'notion']) expect(connectorauto.scoreServer({ name, tools: [] }, prompt)).toBe(0);
  });

  it('specific words still do', () => {
    expect(connectorauto.scoreServer({ name: 'sentry', tools: [] }, want('look at the latest crash stacktrace'))).toBeGreaterThan(0);
    expect(connectorauto.scoreServer({ name: 'github', tools: [] }, want('git ops please'))).toBeGreaterThan(0);
  });
});

describe('a connector picked for one message stays for the next', () => {
  const servers = [{ name: 'linear', status: 'connected', tools: [{ name: 'mcp__linear__create_issue' }] }];
  it('"go ahead" after a message that picked a connector keeps it', () => {
    const d = connectorauto.plan({ servers, prompt: 'go ahead', pick: true, sticky: ['linear'] });
    expect(d.show.has('linear')).toBe(true);
  });

  it('without the earlier pick it is hidden as not needed', () => {
    const d = connectorauto.plan({ servers, prompt: 'go ahead', pick: true });
    expect(d.hide.has('linear')).toBe(true);
  });
});

describe('workflow "finish with" option', () => {
  const wf = { fill: false };
  it('is off by default', () => {
    expect(BASE_OPTIONS.finish).toBe('');
    expect(mergeOptions(wf, {}, {}, 'k').finish).toBe('');
  });

  it('keeps only known values', () => {
    expect(cleanOptions({ finish: 'test' }).finish).toBe('test');
    expect(cleanOptions({ finish: 'summary' }).finish).toBe('summary');
    expect(cleanOptions({ finish: 'rm -rf' }).finish).toBeUndefined();
  });

  it('adds the finishing step to the prompt', () => {
    const o = { ...BASE_OPTIONS, finish: 'test' };
    expect(buildPrompt('Do the thing.', wf, o)).toContain(FINISH_LINES.test);
    const s = { ...BASE_OPTIONS, finish: 'summary' };
    expect(buildPrompt('Fix: ', { fill: true }, s, 'the bug')).toContain(FINISH_LINES.summary);
  });
});
