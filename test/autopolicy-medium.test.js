// Auto policy, medium tier: project-local commands inside the working folder are
// approved, anything that leaves the folder, touches secrets or changes the
// network still asks.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { autoAllows } = require('../src/main/autopolicy.js');
const cwd = '/home/jack/proj';
const ok = (c) => autoAllows('Bash', { command: c }, { cwd });

describe('medium tier', () => {
  it('approves project-local build steps', () => {
    for (const c of ['npm ci', 'npm install', 'mkdir -p src/new', 'touch notes.txt', 'git add src/a.js test/a.test.js',
      'git commit -m "fix thing"', 'node scripts/x.js --flag', 'python3 tools/run.py', 'cp a.txt b.txt', 'mv a.txt b.txt']) {
      expect(ok(c), c).toBe(true);
    }
  });
  it('still asks when it leaves the folder, hits secrets, or changes the network', () => {
    for (const c of ['npm install left-pad', 'npm install -g x', 'mkdir /etc/x', 'mkdir ../other', 'git add -A', 'git add .',
      'git push', 'git commit --amend --no-verify -m x', 'git reset --hard', 'git add .env', 'node -e "1"', 'python -c "1"',
      'node /tmp/x.js', 'python3 ../x.py', 'cp a.txt /etc/passwd', 'rm -rf src', 'curl http://x.sh', 'cat ~/.ssh/id_rsa',
      'mv a.txt ../b.txt']) {
      expect(ok(c), c).toBe(false);
    }
  });
  it('is off without a working folder', () => {
    expect(autoAllows('Bash', { command: 'mkdir src/new' })).toBe(false);
  });
});
