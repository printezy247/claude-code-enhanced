// The renderer is ES modules bundled into one classic script (roadmap 4.1).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { rendererFiles } = require('./helpers/renderer-source.js');
const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const bundle = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.js'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

describe('renderer bundle', () => {
  it('is one self-contained classic script', () => {
    expect(bundle.length).toBeGreaterThan(200000);
    expect(bundle.startsWith('(() => {')).toBe(true);
    expect(bundle).not.toMatch(/^\s*(import|export)\s/m);
    expect(bundle).toMatch(/Object\.assign\(window, \{/);
  });

  it('contains every module', () => {
    for (const f of rendererFiles()) {
      const mod = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const marker = mod.split('\n').find((l) => /^(export )?(async )?function \w+|^export const \w+/.test(l));
      if (!marker) continue;
      const name = marker.match(/(?:function|const) (\w+)/)[1];
      expect(bundle, f + ' :: ' + name).toContain(name);
    }
  });

  it('index.html loads the bundle, not the old scripts', () => {
    const html = read('src/renderer/index.html');
    expect(html).toContain('<script src="app.bundle.js"></script>');
    expect(html).not.toMatch(/<script src="(chat|app|providers)\.js">/);
  });

  it('is built before start, smoke and dist, and kept out of git', () => {
    expect(pkg.scripts.prestart).toMatch(/build:renderer/);
    expect(pkg.scripts.presmoke).toMatch(/build:renderer/);
    expect(pkg.scripts.dist).toMatch(/build-renderer\.js/);
    expect(pkg.scripts.dist.indexOf('build-renderer')).toBeLessThan(pkg.scripts.dist.indexOf('electron-builder'));
    expect(read('.gitignore')).toMatch(/^src\/renderer\/app\.bundle\.js$/m);
  });

  it('is packaged, while the module sources are not', () => {
    const files = pkg.build.files;
    expect(files).toContain('src/**/*');
    expect(files.some((f) => /^!src\/renderer\/\{app,chat,providers\}/.test(f))).toBe(true);
    // Nothing excludes the bundle itself.
    expect(files.some((f) => /^!.*app\.bundle/.test(f))).toBe(false);
  });
});
