// The output-filter budget as the STORE holds it.
//
// The Settings row promises a budget of 500…100000 characters. The main
// process clamps the number where it is used and where it is written, but the
// store itself used to keep whatever a hand-edited config.json said — so the
// number box showed 999999 while the model never read more than 100000. These
// tests pin the store's own copy.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const stub = require('electron');
const { Store } = require('../src/main/store.js');

/** Write a config.json holding the given settings into the userData dir. */
function writeConfig(settings) {
  const dir = stub.__userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ configVersion: 2, providers: [], settings }),
  );
}

/** Load the store fresh from the config.json on disk. */
function loadStore() {
  const store = new Store();
  store.init();
  return store;
}

beforeEach(() => {
  // init() saves what it loaded, so each case starts from a clean file.
  const file = path.join(stub.__userDataDir(), 'config.json');
  try { fs.rmSync(file); } catch { /* nothing there */ }
});

describe('the store and the output-filter budget', () => {
  it('clamps a hand-edited budget that is above the range', () => {
    writeConfig({ outputFilterMaxChars: 999999 });
    expect(loadStore().settings.outputFilterMaxChars).toBe(100000);
  });

  it('clamps a hand-edited budget that is below the range', () => {
    writeConfig({ outputFilterMaxChars: 10 });
    expect(loadStore().settings.outputFilterMaxChars).toBe(500);
  });

  it('keeps a budget that is inside the range', () => {
    writeConfig({ outputFilterMaxChars: 12345 });
    expect(loadStore().settings.outputFilterMaxChars).toBe(12345);
  });

  it('writes the normalised budget back to the config file', () => {
    // The store is what the Settings box reads: the file on disk must not keep
    // the out-of-range number either.
    writeConfig({ outputFilterMaxChars: 999999 });
    loadStore();
    const saved = JSON.parse(
      fs.readFileSync(path.join(stub.__userDataDir(), 'config.json'), 'utf8'));
    expect(saved.settings.outputFilterMaxChars).toBe(100000);
  });

  it('leaves the other settings alone', () => {
    writeConfig({ outputFilterMaxChars: 999999, fontSize: 18, theme: 'light' });
    const s = loadStore().settings;
    expect(s.fontSize).toBe(18);
    expect(s.theme).toBe('light');
  });
});
