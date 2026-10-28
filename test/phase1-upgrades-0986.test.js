// Phase 1 of the 26-item upgrade pass (0.9.86):
//  1. auth store must not call a keyring-less backend "encryption"
//  2. packaged binary ships with the hardening fuses flipped
//  3. machine resume re-checks the things sleep broke
//  4. native crashes leave a local dump instead of nothing
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('auth store: basic_text is not encryption', () => {
  function storeWith({ available, backend }) {
    const { AuthStore } = require('../src/main/authstore.js');
    return new AuthStore({
      safeStorage: {
        isEncryptionAvailable: () => available,
        ...(backend !== undefined ? { getSelectedStorageBackend: () => backend } : {}),
        encryptString: (s) => Buffer.from('ENC:' + s),
        decryptString: (b) => String(b).replace(/^ENC:/, ''),
      },
    });
  }

  it('reports unavailable when Electron fell back to basic_text', () => {
    expect(storeWith({ available: true, backend: 'basic_text' }).encryptionAvailable).toBe(false);
  });

  it('reports available when a real keyring backend is selected', () => {
    expect(storeWith({ available: true, backend: 'gnome_libsecret' }).encryptionAvailable).toBe(true);
    expect(storeWith({ available: true, backend: 'kwallet5' }).encryptionAvailable).toBe(true);
  });

  it('falls back to isEncryptionAvailable when the backend query is missing', () => {
    expect(storeWith({ available: true, backend: undefined }).encryptionAvailable).toBe(true);
    expect(storeWith({ available: false, backend: undefined }).encryptionAvailable).toBe(false);
  });

  it('stores the secret with an honest plaintext marker under basic_text', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cce-basic-'));
    const { AuthStore } = require('../src/main/authstore.js');
    const auth = new AuthStore({
      dir,
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text',
        encryptString: (s) => Buffer.from('ENC:' + s),
        decryptString: (b) => String(b).replace(/^ENC:/, ''),
      },
    });
    auth.setApiKey('p', 'sk-test-key-12345');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    expect(onDisk.providers.p.key.enc).toBe(false);
    expect(auth.get('p').key).toBe('sk-test-key-12345');   // round-trips either way
    expect(auth.hint('p')).toBe('sk-tes…2345');            // still masked
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('packaged binary hardening (fuse script)', () => {
  const hook = path.join(root, 'scripts', 'electron-fuses.js');
  const src = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : '';

  it('wires an afterPack hook in the builder config', () => {
    expect(pkg.build.afterPack, 'build.afterPack missing').toBeTruthy();
    expect(pkg.build.afterPack).toMatch(/electron-fuses\.js$/);
    expect(fs.existsSync(path.join(root, pkg.build.afterPack.replace(/^\.\//, '')))).toBe(true);
  });

  it('turns off the three privilege escapes', () => {
    for (const name of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) {
      expect(src, 'fuse script must disable ' + name).toMatch(new RegExp(name + '\\s*:\\s*false'));
    }
  });

  it('only flips the packed copy, never the dev electron binary', () => {
    expect(src).toMatch(/appOutDir/);
    expect(src).not.toMatch(/node_modules[\\/]electron/);
  });

  it('the hook module exports a function electron-builder can call', async () => {
    const mod = await import(path.join(root, 'scripts', 'electron-fuses.js'));
    expect(typeof (mod.default || mod.afterPack)).toBe('function');
  });
});

describe('machine resume', () => {
  it('broadcasts app:resumed to every window so stale checks re-run', async () => {
    const stub = require('electron');
    stub.__reset();
    require('../src/main/main.js');
    await new Promise((r) => setTimeout(r, 250));
    const { powerMonitor } = stub;
    expect(powerMonitor, 'powerMonitor stub missing').toBeTruthy();
    stub.__state.sent.length = 0;
    powerMonitor.emit('resume');
    const resumed = stub.__state.sent.filter((m) => m.channel === 'app:resumed');
    expect(resumed.length, 'no window was told the machine resumed').toBeGreaterThan(0);
  });

  it('preload exposes an onAppResumed listener, not a raw channel', () => {
    const prev = process.env.CCE_DEV;
    process.env.CCE_DEV = '1';
    try {
      require('../src/preload/preload.js');
    } finally {
      if (prev == null) delete process.env.CCE_DEV; else process.env.CCE_DEV = prev;
    }
    const ccx = require('electron').__state.exposed.get('ccx');
    expect(typeof ccx.onAppResumed).toBe('function');
    expect(typeof ccx.onAppResumed(() => {})).toBe('function');   // returns unsubscribe
  });

  it('the renderer subscribes and invalidates the stale connector status', () => {
    const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'main.js'), 'utf8');
    expect(src).toMatch(/onAppResumed\(/);
    const conn = fs.readFileSync(path.join(root, 'src', 'renderer', 'app', 'connectors.js'), 'utf8');
    expect(conn).toMatch(/function invalidateConnectorStatus\(/);
  });
});

describe('crash dumps', () => {
  it('starts the crash reporter local-only before app ready', async () => {
    const stub = require('electron');
    stub.__reset();
    require('../src/main/main.js');
    await new Promise((r) => setTimeout(r, 250));
    const started = stub.__state.crashReports || [];
    expect(started.length, 'crashReporter.start never called').toBeGreaterThan(0);
    expect(started[0].uploadToServer).toBe(false);
    expect(started[0].compress).toBe(true);
  });
});
