// The git surface (the desktop's side panel) and the secret masking that
// keeps a credential out of a permission card.
//
//  - the diff, the stats, the commit list and one commit's patch
//  - a commit id that is not a sha never reaches git
//  - a huge patch is truncated at a line boundary
//  - the status is cached, and the cache can be dropped
//  - a URL with a credential is masked before it is put on the screen
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const gitsurface = require('../src/main/gitsurface.js');
const secrets = require('../src/shared/secrets.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-git-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leaks are fine in tmp */ } });

const git = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(() => {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
});

beforeEach(() => {
  gitsurface.invalidate();
});

describe('the git surface', () => {
  it('the diff of the working tree', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\n');
    git(['add', 'a.txt']);
    git(['commit', '-qm', 'first']);
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\ntwo\n');
    const res = await gitsurface.diff(tmp);
    expect(res.ok).toBe(true);
    expect(res.patch).toContain('+two');
    expect(res.truncated).toBe(false);
  });

  it('the diff stats count the lines', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'one\ntwo\nthree\n');
    const res = await gitsurface.diffStats(tmp);
    expect(res.ok).toBe(true);
    expect(res.insertions).toBeGreaterThan(0);
    expect(res.files.some((f) => f.file === 'a.txt')).toBe(true);
  });

  it('the commit list carries the subject and the author', async () => {
    const res = await gitsurface.commits(tmp);
    expect(res.ok).toBe(true);
    expect(res.commits.length).toBeGreaterThan(0);
    expect(res.commits[0].subject).toBe('first');
    expect(res.commits[0].author).toBe('Test');
  });

  it("one commit's patch", async () => {
    const list = await gitsurface.commits(tmp);
    const res = await gitsurface.commitDiff(tmp, { sha: list.commits[0].sha });
    expect(res.ok).toBe(true);
    expect(res.patch).toContain('a.txt');
  });

  it('a commit id that is not a sha never reaches git', async () => {
    for (const bad of ['--upload-pack=touch /tmp/pwned', 'HEAD~1; rm -rf /', '', null]) {
      const res = await gitsurface.commitDiff(tmp, { sha: bad });
      expect(res.ok, String(bad)).toBe(false);
      expect(res.error).toMatch(/not a commit id/);
    }
  });

  it('a huge patch is truncated on a line boundary', () => {
    const big = Array.from({ length: 5000 }, (_, i) => 'line ' + i).join('\n');
    const out = gitsurface.clamp(big, 1000);
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith('\n')).toBe(true);
    expect(out.text).toContain('truncated');
  });

  it('the status is cached and the cache can be dropped', async () => {
    gitsurface.invalidate();
    const first = await gitsurface.status(tmp);
    expect(first.ok).toBe(true);
    expect(first.branch).toBeTruthy();
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'new\n');
    // The cached answer still says the old state.
    const cached = await gitsurface.status(tmp);
    expect(cached.untracked).toBe(first.untracked);
    gitsurface.invalidate(tmp);
    const fresh = await gitsurface.status(tmp);
    expect(fresh.untracked).toBe(first.untracked + 1);
  });

  it('a directory that is not a repo does not throw', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-plain-'));
    const res = await gitsurface.status(plain);
    expect(res.ok).toBe(true);
    expect(res.branch).toBe('');
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

describe('the secret masking', () => {
  it('masks the password in a URL', () => {
    expect(secrets.maskUrl('https://user:ghp_secret@api.example.com/x'))
      .toBe('https://user:<hidden>@api.example.com/x');
  });

  it('masks a credential in a query parameter', () => {
    expect(secrets.maskUrl('https://api.example.com/x?token=abc123&page=2'))
      .toBe('https://api.example.com/x?token=<hidden>&page=2');
  });

  it('leaves an ordinary parameter alone', () => {
    expect(secrets.maskUrl('https://api.example.com/x?page=2&q=hello'))
      .toBe('https://api.example.com/x?page=2&q=hello');
  });

  it('masks a secret field of a tool input', () => {
    const out = secrets.maskToolInput({
      url: 'https://api.example.com/x?api_key=abc',
      apiKey: 'sk-live-123',
      path: '/tmp/a.txt',
      nested: { authorization: 'Bearer xyz', keep: 'visible' },
    });
    expect(out.apiKey).toBe('<hidden>');
    expect(out.nested.authorization).toBe('<hidden>');
    expect(out.nested.keep).toBe('visible');
    expect(out.path).toBe('/tmp/a.txt');
    expect(out.url).toContain('<hidden>');
  });

  it('a non-string value is not touched', () => {
    expect(secrets.maskToolInput({ n: 5, b: true, nil: null })).toEqual({ n: 5, b: true, nil: null });
  });
});
