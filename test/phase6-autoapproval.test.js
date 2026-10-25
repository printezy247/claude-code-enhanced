// Phase 6 (0.9.73): auto-approval safety.
//
// Each shell case below was run against the old policy and was approved when it
// should have asked: a command that writes a file, one that never ends, one
// that prints a stored token. WebFetch is no longer approved for every site.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSafeBash, autoAllows, isSensitivePath } = require('../src/main/autopolicy.js');
const { hostOf, normalizeDomains, isApprovedHost, MAX_DOMAINS } = require('../src/main/webdomains.js');

describe('the four proven gaps', () => {
  it.each([
    'uniq in.txt out.txt',
    'tree -o out.txt',
    'cat ~/.config/gh/hosts.yml',
    'tail -f log',
  ])('asks for %s', (cmd) => expect(isSafeBash(cmd)).toBe(false));

  it('still approves the plain forms', () => {
    for (const c of ['uniq in.txt', 'uniq -c in.txt', 'sort a | uniq -c', 'tree', 'tree -L 2 src', 'tail -n 20 log', 'tail log']) {
      expect(isSafeBash(c), c).toBe(true);
    }
  });
});

describe('commands that write or hang with the wrong arguments', () => {
  it.each([
    'tree -ao out.txt', 'tree --output out.txt',
    'tail -F log', 'tail -fn 5 log', 'tail --follow log', 'tail -n 5 --follow=name log', 'tail --retry log',
    'file -C magic', 'file --compile x', 'file -bC x',
    'date -s 12:00', 'date 010112002026', 'date --set=12:00',
    'hostname newname', 'hostname -b newname',
  ])('asks for %s', (cmd) => expect(isSafeBash(cmd), cmd).toBe(false));

  it.each([
    'file x.png', 'file -b x.png', 'date', 'date -u', 'date +%s', 'date -I', 'hostname', 'hostname -f', 'hostname -s',
  ])('approves %s', (cmd) => expect(isSafeBash(cmd), cmd).toBe(true));
});

describe('credential files', () => {
  it.each([
    'cat ~/.config/gh/hosts.yml', 'cat /home/a/.config/gcloud/credentials.db', 'cat ~/.git-credentials', 'cat ~/.docker/config.json',
    'cat ~/.kube/config', 'cat server.pem', 'cat tls/private.key', 'cat cert.p12', 'head ~/.pgpass', 'cat ~/.azure/accessTokens.json',
    'cat ~/.vault-token', 'cat ~/.bash_history', 'cat /proc/self/environ', 'grep token ~/.config/op/config', 'cat keys/id_ecdsa',
    'cat "$HOME/.ssh/id_rsa"',
  ])('shell: asks for %s', (cmd) => expect(isSafeBash(cmd), cmd).toBe(false));

  it('leaves ordinary config and similarly named files alone', () => {
    for (const c of ['cat ~/.config/nvim/init.lua', 'cat src/keyboard.js', 'cat docs/pem-format.md', 'ls ~/.config', 'cat package.json']) {
      expect(isSafeBash(c), c).toBe(true);
    }
  });

  it('the read tools do not approve a credential path either', () => {
    expect(autoAllows('Read', { file_path: '/home/a/.config/gh/hosts.yml' })).toBe(false);
    expect(autoAllows('Read', { file_path: '/home/a/.ssh/id_ed25519' })).toBe(false);
    expect(autoAllows('Read', { file_path: '/home/a/.aws/credentials' })).toBe(false);
    expect(autoAllows('Grep', { pattern: 'token', path: '/home/a/.config/gh' })).toBe(false);
    expect(autoAllows('Glob', { pattern: '**/*.pem' })).toBe(false);
    expect(autoAllows('Grep', { pattern: 'x', path: '/home/a/.docker/config.json' })).toBe(false);
  });

  it('the read tools still approve ordinary paths', () => {
    expect(autoAllows('Read', { file_path: '/repo/src/index.js' })).toBe(true);
    expect(autoAllows('Grep', { pattern: 'TODO', path: '/repo/src' })).toBe(true);
    expect(autoAllows('Glob', { pattern: 'src/**/*.ts' })).toBe(true);
    expect(autoAllows('TodoWrite', {})).toBe(true);
    expect(autoAllows('Read', undefined)).toBe(true);
  });

  it('isSensitivePath tolerates empty input', () => {
    expect(isSensitivePath('')).toBe(false);
    expect(isSensitivePath(undefined)).toBe(false);
    expect(isSensitivePath('/repo/.env')).toBe(true);
  });
});

describe('WebFetch sites', () => {
  it('reads the host of a URL, and nothing from a non-web one', () => {
    expect(hostOf('https://Docs.Python.org/3/')).toBe('docs.python.org');
    expect(hostOf('http://example.com:8080/x?y=1')).toBe('example.com');
    expect(hostOf('https://example.com./x')).toBe('example.com');
    expect(hostOf('file:///etc/passwd')).toBe('');
    expect(hostOf('ftp://example.com')).toBe('');
    expect(hostOf('not a url')).toBe('');
    expect(hostOf(undefined)).toBe('');
  });

  it('matches an exact host, or a subdomain of a wildcard, and nothing more', () => {
    const list = ['github.com', '*.example.org'];
    expect(isApprovedHost('github.com', list)).toBe(true);
    expect(isApprovedHost('api.example.org', list)).toBe(true);
    expect(isApprovedHost('a.b.example.org', list)).toBe(true);
    expect(isApprovedHost('example.org', list)).toBe(false);
    expect(isApprovedHost('github.io', list)).toBe(false);
    expect(isApprovedHost('github.com.evil.net', list)).toBe(false);
    expect(isApprovedHost('evilexample.org', list)).toBe(false);
    expect(isApprovedHost('', list)).toBe(false);
    expect(isApprovedHost('github.com', undefined, null)).toBe(false);
  });

  it('also reads this chat\'s approvals', () => {
    expect(isApprovedHost('docs.python.org', ['github.com'], new Set(['docs.python.org']))).toBe(true);
  });

  it('cleans what the user typed', () => {
    expect(normalizeDomains('https://Docs.Python.org/3/\n*.GitHub.com, example.com:8443\n\n  \nnot a host!\nexample.com'))
      .toEqual(['docs.python.org', '*.github.com', 'example.com']);
    expect(normalizeDomains(['a.com', 'A.com', 42, null, '//x'])).toEqual(['a.com']);
    expect(normalizeDomains(undefined)).toEqual([]);
    expect(normalizeDomains(Array.from({ length: 500 }, (_, i) => 'h' + i + '.com')).length).toBe(MAX_DOMAINS);
  });

  it('is never approved by the shell policy', () => {
    expect(autoAllows('WebFetch', { url: 'https://example.com' })).toBe(false);
  });
});
