// localmodels: binary context search, per-model force override.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const lm = require('../src/main/localmodels.js');

const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', r));
const close = (server) => new Promise(r => server.close(r));

/**
 * Fake Ollama whose /api/generate only accepts num_ctx at or under `maxOk`.
 * Counts every load attempt.
 */
async function fakeOllama({ maxOk, native = 131072 }) {
  let attempts = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    const json = (o, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'GET' && req.url === '/api/tags') return json({ models: [{ name: 'm1', size: 1e9 }] });
    if (req.url === '/api/show') return json({
      model_info: {
        'llama.context_length': native, 'llama.block_count': 32,
        'llama.attention.head_count_kv': 8, 'llama.attention.key_length': 128,
      },
    });
    if (req.url === '/api/generate') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        attempts++;
        let ctx = 0;
        try { ctx = JSON.parse(body).options.num_ctx; } catch { /* ignore */ }
        seen.push(ctx);
        if (ctx <= maxOk) return json({ done: true });
        return json({ error: 'model runner OOM' }, 500);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await listen(server);
  return { server, base: 'http://127.0.0.1:' + server.address().port, stats: () => ({ attempts, seen: seen.slice() }), close: () => close(server) };
}

describe('warmOllamaModel search (#10)', () => {
  it('settles near the largest loadable context in few attempts', async () => {
    const f = await fakeOllama({ maxOk: 81920 });
    const r = await lm.warmOllamaModel(f.base, 'm1', 131072);
    await f.close();
    expect(r.ok).toBe(true);
    expect(r.ctx).toBeLessThanOrEqual(81920);
    expect(r.ctx).toBeGreaterThan(70000);
    // Binary search: ~3 loads, not the 5+ of the old 15% step-down.
    expect(f.stats().attempts).toBeLessThanOrEqual(4);
  });

  it('fails cleanly when even the floor will not load', async () => {
    const f = await fakeOllama({ maxOk: 1000 });
    const r = await lm.warmOllamaModel(f.base, 'm1', 131072);
    await f.close();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('could not load');
  });
});

describe('per-model force override (#11)', () => {
  it('loads exactly the forced size, skipping the floor', async () => {
    const f = await fakeOllama({ maxOk: 131072, native: 32768 });
    const r = await lm.warmOllamaModel(f.base, 'm1', 131072, { forceCtx: 32768 });
    await f.close();
    expect(r.ok).toBe(true);
    expect(r.ctx).toBe(32768);
    expect(f.stats().seen).toEqual([32768]);
  });

  it('still enforces the floor without an override', async () => {
    const f = await fakeOllama({ maxOk: 131072, native: 32768 });
    const r = await lm.warmOllamaModel(f.base, 'm1', 131072);
    await f.close();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('serves only');
  });
});
describe('warmOllamaModel when the server is down', () => {
  it('fails fast with a start-it hint for a local base', async () => {
    const r = await lm.warmOllamaModel('http://127.0.0.1:1', 'm1', 131072, { local: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ollama serve');
  });
  it('does not block non-local providers on a network error', async () => {
    const r = await lm.warmOllamaModel('http://127.0.0.1:1', 'm1', 131072, {});
    expect(r.ok).toBe(true);
  });
});
