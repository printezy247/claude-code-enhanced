// scripts/lint.sh remembers a clean lintian run by a fingerprint of the .deb's
// payload, so a build that only changed the .desktop entry or the control
// metadata does not pay for lintian again. Real .deb files (dpkg-deb), a
// stand-in lintian on PATH that counts its runs.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(__dirname, '..');
const haveDpkg = spawnSync('dpkg-deb', ['--version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-lint-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp */ } });

const bin = path.join(tmp, 'bin');
const runs = path.join(tmp, 'lintian-runs');
fs.mkdirSync(bin);
let lintianExit = 0;
const writeLintian = () => fs.writeFileSync(path.join(bin, 'lintian'), `#!/bin/sh\necho x >> "${runs}"\nexit ${lintianExit}\n`, { mode: 0o755 });
const lintianRuns = () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0);

let n = 0;
/** A .deb in its own dist folder: { binary, desktop, version } decide what differs. */
function makeDeb({ binary = 'ELF-1', desktop = '[Desktop Entry]\nName=App\n', version = '1.0.0' } = {}) {
  const dir = path.join(tmp, 'pkg' + (++n));
  fs.mkdirSync(path.join(dir, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'opt', 'app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'usr', 'share', 'applications'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'DEBIAN', 'control'), `Package: app\nVersion: ${version}\nArchitecture: all\nMaintainer: t <t@example.com>\nDescription: app ${version}\n`);
  fs.writeFileSync(path.join(dir, 'opt', 'app', 'app'), binary);
  fs.writeFileSync(path.join(dir, 'usr', 'share', 'applications', 'app.desktop'), desktop);
  const dist = path.join(tmp, 'dist' + n);
  fs.mkdirSync(dist);
  const r = spawnSync('dpkg-deb', ['--root-owner-group', '--build', dir, path.join(dist, 'app.deb')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return dist;
}

function lint(dist, cache, env = {}) {
  return spawnSync('bash', [path.join(root, 'scripts', 'lint.sh')], {
    encoding: 'utf8', env: { PATH: bin + ':' + process.env.PATH, HOME: tmp, LINT_DIST: dist, LINT_CACHE: cache, ...env },
  });
}
const fingerprint = (dist) => spawnSync('bash', [path.join(root, 'scripts', 'payload-fingerprint.sh'), path.join(dist, 'app.deb')], { encoding: 'utf8' }).stdout.trim();

describe.skipIf(!haveDpkg)('lint.sh payload cache', () => {
  it('fingerprint ignores the .desktop entry and the version, not the payload', () => {
    const a = fingerprint(makeDeb());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(makeDeb({ desktop: '[Desktop Entry]\nName=Renamed\nComment=x\n' }))).toBe(a);
    expect(fingerprint(makeDeb({ version: '2.0.0' }))).toBe(a);
    expect(fingerprint(makeDeb({ binary: 'ELF-2' }))).not.toBe(a);
  });

  it('runs lintian once, then skips it while the payload is the same', () => {
    lintianExit = 0; writeLintian(); fs.rmSync(runs, { force: true });
    const cache = path.join(tmp, 'cache1');
    const first = lint(makeDeb(), cache);
    expect(first.status).toBe(0);
    expect(lintianRuns()).toBe(1);
    // a new build that only changed the menu entry and the version
    const second = lint(makeDeb({ desktop: '[Desktop Entry]\nName=New name\n', version: '1.0.1' }), cache);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('lintian skipped');
    expect(lintianRuns()).toBe(1);
  });

  it('runs lintian again when a shipped file changed, or when forced', () => {
    lintianExit = 0; writeLintian(); fs.rmSync(runs, { force: true });
    const cache = path.join(tmp, 'cache2');
    lint(makeDeb(), cache);
    lint(makeDeb({ binary: 'ELF-changed' }), cache);
    expect(lintianRuns()).toBe(2);
    lint(makeDeb({ binary: 'ELF-changed' }), cache, { LINT_FORCE: '1' });
    expect(lintianRuns()).toBe(3);
  });

  it('a lintian run that failed is not remembered, and is reported', () => {
    lintianExit = 1; writeLintian(); fs.rmSync(runs, { force: true });
    const cache = path.join(tmp, 'cache3');
    const dist = makeDeb();
    const r = lint(dist, cache);
    expect(r.status).toBe(0);                       // reported, not fatal by default
    expect(r.stderr).toContain('lintian exited with status 1');
    expect(fs.existsSync(path.join(cache, 'lintian.ok'))).toBe(false);
    lint(dist, cache);
    expect(lintianRuns()).toBe(2);                  // nothing was cached, so it ran again
    expect(lint(dist, cache, { LINT_STRICT: '1' }).status).toBe(1);
  });

  it('says so when there is no deb', () => {
    const empty = path.join(tmp, 'empty-dist'); fs.mkdirSync(empty);
    const r = lint(empty, path.join(tmp, 'cache4'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no deb');
  });
});
