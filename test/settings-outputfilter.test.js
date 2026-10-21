// The output-filter budget as the MAIN process stores it.
//
// The Settings row promises a 500…100000 range, but the renderer is the only
// place that clamped it: the main process is the code that actually uses the
// number, and it accepted anything. A hand-edited config.json or any other
// writer could store an unbounded value, and the model would read it all.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const stub = require('electron');
const main = require('../src/main/main.js');

beforeAll(async () => {
  // The main process registers its IPC surface during startup, after the
  // translator proxy has bound its port.
  const deadline = Date.now() + 8000;
  while (!stub.__state.handlers.get('settings:set') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
});

describe('the output-filter budget in the main process', () => {
  it('clamps an out-of-range budget before it is stored', async () => {
    const set = stub.__state.handlers.get('settings:set');
    expect(set, 'no settings:set handler').toBeTruthy();

    const high = await set(null, { settings: { outputFilterMaxChars: 999999 } });
    expect(high.ok).toBe(true);
    expect(main.store.settings.outputFilterMaxChars).toBe(100000);

    const low = await set(null, { settings: { outputFilterMaxChars: 10 } });
    expect(low.ok).toBe(true);
    expect(main.store.settings.outputFilterMaxChars).toBe(500);
  });
});
