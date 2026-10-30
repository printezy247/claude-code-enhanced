// Remote folders over SSH, read-only: list, read a file, show the git diff.
// Every value is quoted for the remote shell, and the commands only read.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listCommand, readCommand, diffCommand, parseListing, checkPath, createBrowser, MAX_ENTRIES, MAX_BYTES } = require('../src/main/sshbrowse.js');

describe('checkPath', () => {
  it('accepts absolute and home paths, rejects the rest', () => {
    expect(checkPath('/srv/app')).toBe('/srv/app');
    expect(checkPath('~/code')).toBe('~/code');
    expect(checkPath('~')).toBe('~');
    for (const bad of ['', 'relative/dir', '/a\nb', '/a\0b', 'x'.repeat(1001), null, 5]) expect(() => checkPath(bad)).toThrow();
  });
});

describe('commands', () => {
  it('quote the path so it cannot add a second command', () => {
    const evil = "/srv/$(touch x); echo 'y";
    for (const cmd of [listCommand(evil), readCommand(evil), diffCommand(evil)]) {
      expect(cmd).toContain("'/srv/$(touch x); echo '\\''y'");   // one quoted word, embedded quote escaped
    }
  });
  it('leave a leading ~ for the remote shell to expand', () => {
    expect(listCommand('~/my code')).toBe("cd ~/'my code' && ls -1Ap");
  });
  it('read at most MAX_BYTES and never write', () => {
    expect(readCommand('/etc/hostname')).toBe('head -c ' + MAX_BYTES + " -- '/etc/hostname'");
    expect(diffCommand('/srv/app')).toBe("cd '/srv/app' && git --no-pager diff --no-color --no-ext-diff --no-textconv | head -c " + MAX_BYTES);
    for (const c of [listCommand('/a'), readCommand('/a'), diffCommand('/a')]) expect(c).not.toMatch(/\b(rm|mv|cp|tee|dd)\b|>|git (add|commit|checkout|reset)/);
  });
});

describe('parseListing', () => {
  it('marks folders by the trailing slash, folders first, and caps the count', () => {
    const out = parseListing('b.txt\nsrc/\na.txt\n.git/\n');
    expect(out.entries).toEqual([{ name: '.git', dir: true }, { name: 'src', dir: true }, { name: 'a.txt', dir: false }, { name: 'b.txt', dir: false }]);
    const many = parseListing(Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => 'f' + i).join('\n'));
    expect(many.entries).toHaveLength(MAX_ENTRIES);
    expect(many.truncated).toBe(true);
  });
});

describe('createBrowser', () => {
  const host = { id: 'h1', host: 'box.local', user: 'jack', port: 22, identity: '' };
  const make = (stdout, err) => {
    const execFile = vi.fn((cmd, args, opts, cb) => (err ? cb(err, '', 'denied') : cb(null, stdout, '')));
    return { execFile, b: createBrowser({ execFile, env: { PATH: '/bin', SECRET_TOKEN: 'nope' } }) };
  };
  it('runs ssh with an argument array, no terminal, no password prompt, and a trimmed environment', async () => {
    const { execFile, b } = make('src/\nREADME.md\n');
    const r = await b.list(host, '/srv/app');
    expect(r.entries.map((e) => e.name)).toEqual(['src', 'README.md']);
    const [cmd, args, opts] = execFile.mock.calls[0];
    expect(cmd).toBe('ssh');
    expect(args.slice(0, 5)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']);
    expect(args).toContain('jack@box.local');
    expect(args[args.length - 1]).toBe("cd '/srv/app' && ls -1Ap");
    expect(opts.env).toEqual({ PATH: '/bin' });
    expect(opts.timeout).toBeGreaterThan(0);
  });
  it('turns a failed ssh into a plain error', async () => {
    const { b } = make('', Object.assign(new Error('x'), { code: 255 }));
    await expect(b.read(host, '/etc/hostname')).rejects.toThrow(/ssh could not|denied/);
  });
  it('flags a cut-off file', async () => {
    const { b } = make('x'.repeat(MAX_BYTES));
    expect((await b.read(host, '/big')).truncated).toBe(true);
  });
});
