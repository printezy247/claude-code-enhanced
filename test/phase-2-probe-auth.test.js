// Phase 2.4: the context-window probe sends the provider's key in the right
// header, never calls a provider with no base URL, and fails closed with a
// message a person can act on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mc = require('../src/main/modelcontext.js');

let server, base, seen;
const start = (handler) => new Promise((res) => {
  server = http.createServer((req, r) => { seen.push({ url: req.url, headers: req.headers }); handler(req, r); });
  server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; res(); });
});
beforeEach(() => { seen = []; mc.clearProbeFailures(); mc.contextCache.clear(); });
afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

describe('context probe', () => {
  it('sends the key as a bearer by default and reads the window', async () => {
    await start((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ data: [{ id: 'm1', context_length: 64000 }] })); });
    const n = await mc.probeContextWindow({ baseUrl: base, apiKey: 'k1', id: 'p-bearer' }, 'm1');
    expect(n).toBe(64000);
    expect(seen[0].headers.authorization).toBe('Bearer k1');
  });
  it('uses x-api-key and a version for the anthropic protocol', async () => {
    await start((q, r) => { r.end('{"data":[]}'); });
    await mc.probeContextWindow({ baseUrl: base, apiKey: 'k2', protocol: 'anthropic', id: 'p-ant' }, 'm1');
    expect(seen[0].headers['x-api-key']).toBe('k2');
    expect(seen[0].headers['anthropic-version']).toBeTruthy();
    expect(seen[0].headers.authorization).toBeUndefined();
  });
  it('never calls out for a provider with no base URL', async () => {
    expect(await mc.probeContextWindow({ id: 'none' }, 'm1')).toBe(0);
  });
  it('fails closed and says why: key rejected', async () => {
    await start((q, r) => { r.statusCode = 401; r.end('no'); });
    const p = { baseUrl: base, apiKey: 'bad', id: 'p-401' };
    expect(await mc.probeContextWindow(p, 'm1')).toBe(0);
    expect(mc.probeProblem(p, 'm1')).toMatch(/key.*(rejected|not accepted)/i);
  });
  it('fails closed and says why: no /models endpoint', async () => {
    await start((q, r) => { r.statusCode = 404; r.end('no'); });
    const p = { baseUrl: base, id: 'p-404' };
    expect(await mc.probeContextWindow(p, 'm1')).toBe(0);
    expect(mc.probeProblem(p, 'm1')).toMatch(/built-in/i);
  });
  it('does not ask again right after a failure', async () => {
    await start((q, r) => { r.statusCode = 500; r.end('x'); });
    const p = { baseUrl: base, id: 'p-500' };
    await mc.probeContextWindow(p, 'm1');
    await mc.probeContextWindow(p, 'm1');
    expect(seen.length).toBe(1);
  });
  it('no problem is reported for a model that was never probed', () => {
    expect(mc.probeProblem({ baseUrl: 'http://x', id: 'q' }, 'zz')).toBe('');
  });
});
