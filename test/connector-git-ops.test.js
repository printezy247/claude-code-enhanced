// A connector that is switched off has no tool list, so only its name was
// scored. "git ops" / "merge the PR" never matched `github`, so it stayed off
// and the model said the GitHub tool was disconnected.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ca = require('../src/main/connectorauto.js');

const off = { name: 'github', status: 'disabled', tools: [] };
const other = { name: 'notion', status: 'disabled', tools: [] };

describe('disabled well-known connectors are found by what they do', () => {
  for (const prompt of ['git ops', 'merge the pull request', 'push my commit', 'check the repo issues']) {
    it('scores github for: ' + prompt, () => {
      expect(ca.scoreServer(off, ca.words(prompt))).toBeGreaterThan(0);
      expect(ca.scoreServer(other, ca.words(prompt))).toBe(0);
    });
  }

  it('plan switches github back on for "git ops" when picking is active', () => {
    const d = ca.plan({ servers: [off, other], prompt: 'git ops', pick: true, toolBudget: 45 });
    expect(d.show.has('github')).toBe(true);
    expect(d.hide.has('notion')).toBe(true);
  });

  it('uses remembered tools of a disabled server', () => {
    const tools = [{ name: 'create_ticket', description: 'Open a ticket' }];
    expect(ca.scoreServer({ name: 'tracker', tools: [] }, ca.words('open a ticket'))).toBe(0);
    expect(ca.scoreServer({ name: 'tracker', tools }, ca.words('open a ticket'))).toBeGreaterThan(0);
  });
});

describe('loop guard: errors that differ only in numbers', () => {
  it('count as the same error', () => {
    const g = require('../src/main/loopguard.js').createLoopGuard();
    for (let i = 1; i <= 3; i++) {
      g.record({ id: 't' + i, name: 'Bash', input: { command: 'make x' + i } });
      g.result('t' + i, 'ERROR: build failed at 12:0' + i + ' pid ' + (900 + i), true);
    }
    expect(g.record({ id: 't4', name: 'Bash', input: { command: 'make y' } }).tripped).toBe(true);
  });
});
