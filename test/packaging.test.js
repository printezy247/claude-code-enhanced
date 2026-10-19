// The installed app had no tray icon (and no window icon): build/icon.png was
// not in the packaged files, so closing to tray hid the app with nothing to
// click. These pin the packaging and the no-tray fallback.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

describe('app icon ships with the app', () => {
  it('build/icon.png is in the packaged files and exists', () => {
    expect(pkg.build.files).toContain('build/icon.png');
    expect(fs.statSync(path.join(root, 'build/icon.png')).size).toBeGreaterThan(1000);
  });

  it('the tray and window take the icon from the app root, not a dev-only path', () => {
    expect(main).toMatch(/app\.getAppPath\(\), 'build', 'icon\.png'/);
    expect(main).toMatch(/new Tray\(icon\)/);
    expect(main).toMatch(/icon: appIcon\(\)/);
  });
});

describe('closing never strands the app', () => {
  it('minimizes instead of hiding when there is no usable tray item', () => {
    expect(main).toMatch(/if \(!trayUsable\(\)\) \{ win\.minimize\(\); return; \}/);
  });

  it('Ctrl+Q quits from the window', () => {
    expect(main).toMatch(/before-input-event[\s\S]{0,200}input\.control[\s\S]{0,120}'q'[\s\S]{0,80}app\.quit\(\)/);
  });
});
