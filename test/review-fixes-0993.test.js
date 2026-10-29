// Regression tests for the 0.9.93 review pass (docs/review-fixes-phases.md).
// One file per phase group so a failure names the phase it broke.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const readRoot = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

/* ---------------- helpers ---------------- */

const lineOf = (src, at) => src.slice(0, at).split('\n').length;

/**
 * `.then(...)` chains whose rejection nobody handles: not followed by
 * `.catch`/`.finally`, and not awaited, returned or assigned.
 */
function floatingThenOffenders(src) {
  const offenders = [];
  const re = /\.then\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    let depth = 0;
    let j = src.indexOf('(', start);
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (!depth) break; }
    }
    let k = j + 1;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src.startsWith('.catch', k) || src.startsWith('.finally', k)) continue;
    if (src.startsWith('.then', k)) continue;
    // Statement start: back to the previous `;`, `{` or blank line.
    let s = start;
    while (s > 0 && !/[;{}]/.test(src[s - 1])) s--;
    const stmt = src.slice(s, start);
    if (/\b(await|return)\s*$/.test(stmt) || /=\s*$/.test(stmt)) continue;
    offenders.push(lineOf(src, start));
  }
  return offenders;
}

/* ================= Phase 1 — bugs ================= */

describe('phase 1.1 repo hygiene', () => {
  const gi = readRoot('.gitignore');

  it('ignores the graphify output and local agent dirs', () => {
    expect(gi).toMatch(/^graphify-out\/$/m);
    expect(gi).toMatch(/^\.claude\/$/m);
    expect(gi).toMatch(/^claude-code-enhanced\/$/m);
  });

  it('keeps the review plan as a tracked doc', () => {
    expect(exists('docs', 'review-fixes-phases.md')).toBe(true);
  });

  it('has no nested clone in this tree', () => {
    expect(fs.existsSync(path.join(ROOT, 'claude-code-enhanced'))).toBe(false);
  });
});

describe('phase 1.3 console noise', () => {
  it.each(['main/main.js', 'main/proxy.js', 'main/chats.js'])('%s logs only through debugLog', (file) => {
    const src = read(...file.split('/'));
    const raw = src.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /console\.log\s*\(/.test(line))
      .filter(([, line]) => !/^\s*(\/\/|\*)/.test(line));
    expect(raw).toEqual([]);
  });

  it.each(['main.js', 'chat/events.js', 'chat/session.js', 'chat/picker.js', 'chat/panels.js'])(
    'renderer %s only logs behind a debug flag',
    (file) => {
      const src = read('renderer', ...file.split('/'));
      const raw = src.split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /console\.log\s*\(/.test(line))
        .filter(([, line]) => !/__CCE_SMOKE|__CCE_DEBUG/.test(line));
      expect(raw).toEqual([]);
    },
  );

  it('debug logging needs opt-in and stays quiet by default', () => {
    const debug = require('../src/main/debug.js');
    expect(debug.debugOn({})).toBe(false);
    expect(debug.debugOn({ CCE_DEBUG: '1' })).toBe(true);
    expect(debug.debugOn({ CCE_SMOKE: '1' })).toBe(true);
    const calls = [];
    const orig = console.log;
    console.log = (...a) => calls.push(a);
    try {
      debug.debugLog('silent');
      process.env.CCE_DEBUG = '1';
      debug.debugLog('loud');
    } finally {
      console.log = orig;
      delete process.env.CCE_DEBUG;
    }
    expect(calls).toEqual([['loud']]);
  });
});

describe('phase 1.4 fire-and-forget promises', () => {
  it.each([
    'chat/events.js', 'chat/panels.js', 'chat/picker.js', 'chat/transcript.js',
    'chat/qpanel.js', 'chat/status.js', 'chat/session.js',
  ])('%s handles every .then rejection', (file) => {
    expect(floatingThenOffenders(read('renderer', ...file.split('/')))).toEqual([]);
  });
});

describe('phase 1.6 credential fallback', () => {
  let home;
  const providers = require('../src/main/providers.js');
  const instance = {
    uid: 'u-envfile', presetId: 'opencode-go', name: 'OpenCode Go',
    protocol: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1',
    headers: {}, whitelist: [], blacklist: [], models: [],
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-envfile-'));
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('reads a key from ~/.env when the environment misses it', () => {
    fs.writeFileSync(path.join(home, '.env'), 'OPENCODE_API_KEY=sk-from-dotenv\n');
    const auth = { resolve: () => ({}) };
    const key = providers.resolveApiKey(instance, auth, {}, { home });
    expect(key).toBe('sk-from-dotenv');
  });

  it('reads ~/.config/claude-code-enhanced/.env too', () => {
    const dir = path.join(home, '.config', 'claude-code-enhanced');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), 'export OPENCODE_API_KEY="sk-from-config"\n');
    const auth = { resolve: () => ({}) };
    expect(providers.resolveApiKey(instance, auth, {}, { home })).toBe('sk-from-config');
  });

  it('an explicit environment value still wins', () => {
    fs.writeFileSync(path.join(home, '.env'), 'OPENCODE_API_KEY=sk-file\n');
    const auth = { resolve: () => ({}) };
    expect(providers.resolveApiKey(instance, auth, { OPENCODE_API_KEY: 'sk-env' }, { home })).toBe('sk-env');
  });
});

/* ================= Phase 2 — robustness ================= */

describe('phase 2.1 IPC argument validation', () => {
  const ipcguard = require('../src/main/ipcguard.js');
  const ipcschemas = require('../src/main/ipcschemas.js');

  it('accepts well-shaped arguments', () => {
    expect(ipcguard.checkFields({ uid: 'abc' }, { uid: 'string' })).toBeNull();
  });

  it('rejects a missing or wrongly typed field with a readable error', () => {
    expect(ipcguard.checkFields({}, { uid: 'string' })).toMatch(/uid/);
    expect(ipcguard.checkFields({ uid: 7 }, { uid: 'string' })).toMatch(/uid/);
    expect(ipcguard.checkFields({ key: '  ' }, { key: 'nonempty' })).toMatch(/key/);
    expect(ipcguard.checkFields({ type: 'nope' }, { type: { enum: ['claude', 'shell'] } })).toMatch(/type/);
    expect(ipcguard.checkFields({ id: 'x' }, { id: 'id' })).toBeNull();
    expect(ipcguard.checkFields({ id: '' }, { id: 'id' })).toMatch(/id/);
  });

  it('accepts an empty message but not a missing one for chat:send', () => {
    expect(ipcschemas.validateArgs('chat:send', { id: 'abc', text: '' })).toBeNull();
    expect(ipcschemas.validateArgs('chat:send', { id: 'abc' })).toBeNull();
    expect(ipcschemas.validateArgs('chat:send', { text: 'hi' })).toMatch(/id/);
    expect(ipcschemas.validateArgs('chat:send', { id: 'abc', text: 5 })).toMatch(/text/);
  });

  it('refuses an unknown session type and a blank key', () => {
    expect(ipcschemas.validateArgs('session:create', { type: 'chat' })).toBeNull();
    expect(ipcschemas.validateArgs('session:create', { type: 'nope' })).toMatch(/type/);
    expect(ipcschemas.validateArgs('auth:setKey', { uid: 'u1', key: '   ' })).toMatch(/key/);
    expect(ipcschemas.validateArgs('auth:setKey', { uid: 'u1', key: 'sk-1' })).toBeNull();
  });

  it('leaves channels without a schema alone', () => {
    expect(ipcschemas.validateArgs('providers:all', { anything: true })).toBeNull();
  });

  it('main.js validates before the handler runs', () => {
    const src = read('main', 'main.js');
    expect(src).toMatch(/ipcschemas\.validateArgs\(channel, payload\)/);
    expect(src).toMatch(/if \(badArgs\) return \{ ok: false, error: badArgs \}/);
  });
});

describe('phase 2.3 proxy body limit', () => {
  it('is configurable from CCE_PROXY_BODY_LIMIT', () => {
    const proxy = require('../src/main/proxy.js');
    expect(proxy.maxBodyFromEnv({})).toBe(96 * 1024 * 1024);
    expect(proxy.maxBodyFromEnv({ CCE_PROXY_BODY_LIMIT: String(2 * 1024 * 1024) })).toBe(2 * 1024 * 1024);
    expect(proxy.maxBodyFromEnv({ CCE_PROXY_BODY_LIMIT: 'not-a-number' })).toBe(96 * 1024 * 1024);
  });
});

describe('phase 2.4 connector status cache', () => {
  const connectors = require('../src/main/connectors.js');

  it('serves a cached status until it is invalidated', async () => {
    let calls = 0;
    const cache = connectors.createStatusCache({ ttl: 60_000, load: async () => { calls++; return { ok: true, n: calls }; } });
    expect((await cache.get()).n).toBe(1);
    expect((await cache.get()).n).toBe(1);
    cache.invalidate();
    expect((await cache.get()).n).toBe(2);
  });

  it('refreshes once the TTL has passed', async () => {
    let now = 1000;
    let calls = 0;
    const cache = connectors.createStatusCache({ ttl: 1000, now: () => now, load: async () => ({ ok: true, n: ++calls }) });
    expect((await cache.get()).n).toBe(1);
    now += 1001;
    expect((await cache.get()).n).toBe(2);
  });

  it('does not cache a failed scan', async () => {
    let calls = 0;
    const cache = connectors.createStatusCache({ ttl: 60_000, load: async () => ({ ok: false, n: ++calls }) });
    expect((await cache.get()).n).toBe(1);
    expect((await cache.get()).n).toBe(2);
  });

  it('main.js caches the scan, exposes a forced refresh and invalidates on mutations', () => {
    const src = read('main', 'main.js');
    expect(src).toMatch(/connectors\.createStatusCache\(/);
    expect(src).toMatch(/connectors:refresh/);
    // add / addCustom / remove each drop the cached snapshot
    const mutations = src.slice(src.indexOf("handle('connectors:add'"), src.indexOf("// ----- sessions -----"));
    expect(mutations.match(/connectorStatus\.invalidate\(\)/g) || []).toHaveLength(3);
  });
});

/* ================= Phase 4 — security ================= */

describe('phase 4.1 path traversal', () => {
  const pathsafe = require('../src/main/pathsafe.js');
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-path-'));
    fs.writeFileSync(path.join(home, 'note.txt'), 'hello');
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('allows a file inside the allowed roots', () => {
    const r = pathsafe.resolveSafe(path.join(home, 'note.txt'), { roots: [home] });
    expect(r.error).toBeUndefined();
    expect(r.path).toBe(fs.realpathSync(path.join(home, 'note.txt')));
  });

  it('refuses a ../ escape out of the roots', () => {
    const r = pathsafe.resolveSafe(path.join(home, '..', '..', 'etc', 'passwd'), { roots: [home] });
    expect(r.error).toMatch(/outside/i);
  });

  it('refuses an absolute path outside the roots', () => {
    expect(pathsafe.resolveSafe('/etc/passwd', { roots: [home] }).error).toMatch(/outside/i);
  });

  it('refuses non-strings, empty strings and NUL bytes', () => {
    expect(pathsafe.resolveSafe(null, { roots: [home] }).error).toBeTruthy();
    expect(pathsafe.resolveSafe('', { roots: [home] }).error).toBeTruthy();
    expect(pathsafe.resolveSafe(path.join(home, 'a\u0000b'), { roots: [home] }).error).toBeTruthy();
  });

  it('expands a leading ~ to the home directory', () => {
    const r = pathsafe.resolveSafe('~/note.txt', { roots: [home], home });
    expect(r.path).toBe(fs.realpathSync(path.join(home, 'note.txt')));
  });
});

describe('phase 4.2 no shell interpolation', () => {
  it('session and connector code never pass a shell string to exec', () => {
    for (const file of ['main.js', 'connectors.js', 'engines.js', 'sessions.js']) {
      const src = read('main', file);
      expect(src).not.toMatch(/execSync\s*\(/);
      expect(src).not.toMatch(/exec\s*\(\s*[`'"]/);
    }
  });
});

describe('phase 4.3 secrets in logs', () => {
  it('redactKey masks the credential in error text', () => {
    const providers = require('../src/main/providers.js');
    const out = providers.redactKey('upstream said sk-live-123 is invalid', 'sk-live-123');
    expect(out).not.toContain('sk-live-123');
    expect(out).toContain('***');
  });

  it('no log line prints a key-shaped field', () => {
    for (const file of ['main.js', 'proxy.js', 'chats.js', 'providers.js', 'authstore.js']) {
      const src = read('main', file);
      for (const [i, line] of src.split('\n').entries()) {
        if (!/debugLog\(|console\.(log|warn|error)\(/.test(line)) continue;
        expect(line, file + ':' + (i + 1)).not.toMatch(/apiKey|authToken|secret|\.key\b/i);
      }
    }
  });
});

describe('phase 4.4 CSP and sandbox', () => {
  it('index.html declares a CSP', () => {
    expect(readRoot('src', 'renderer', 'index.html')).toMatch(/Content-Security-Policy/);
  });

  it('the window is isolated and sandboxed', () => {
    const src = read('main', 'main.js');
    const block = src.slice(src.indexOf('webPreferences:'));
    expect(block.slice(0, 400)).toMatch(/contextIsolation:\s*true/);
    expect(block.slice(0, 400)).toMatch(/nodeIntegration:\s*false/);
    expect(block.slice(0, 400)).toMatch(/sandbox:\s*true/);
  });
});

/* ================= Phase 5 — UX ================= */

describe('phase 5.5 new-session modal', () => {
  const src = read('renderer', 'app', 'provider-forms.js');

  it('asks which engines exist and greys out the missing ones', () => {
    expect(src).toMatch(/engines:list/);
    expect(src).toMatch(/o\.disabled = true/);
    expect(src).toMatch(/not installed/);
  });

  it('shows the install hint inline instead of failing after launch', () => {
    expect(src).toMatch(/e\.hint/);
    expect(src).toMatch(/engineHint/);
  });
});
