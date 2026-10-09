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

/** Fake Ollama that implements /api/create and /api/ps, and reloads at 4096 for requests without num_ctx on a plain model. */
async function fakeOllamaWithCreate({ maxOk = 262144 } = {}) {
  const models = { m1: { ctx: 4096 } };
  let loaded = null;          // { name, ctx }
  const log = [];
  const server = http.createServer((req, res) => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const b = body ? JSON.parse(body) : {};
      if (req.url === '/api/tags') return json({ models: Object.keys(models).map(name => ({ name, size: 1e9 })) });
      if (req.url === '/api/show') return json({ model_info: { 'llama.context_length': 262144, 'llama.block_count': 32, 'llama.attention.head_count_kv': 8, 'llama.attention.key_length': 128 } });
      if (req.url === '/api/ps') return json({ models: loaded ? [{ name: loaded.name, context_length: loaded.ctx }] : [] });
      if (req.url === '/api/create') {
        log.push(['create', b.model, b.from, b.parameters && b.parameters.num_ctx]);
        models[b.model] = { ctx: b.parameters.num_ctx };
        return json({ status: 'success' });
      }
      if (req.url === '/api/generate') {
        if (b.keep_alive === 0) { log.push(['unload', b.model]); if (loaded && loaded.name === b.model) loaded = null; return json({ done: true }); }
        const want = (b.options && b.options.num_ctx) || (models[b.model] && models[b.model].ctx) || 4096;
        if (want > maxOk) return json({ error: 'OOM' }, 500);
        log.push(['load', b.model, want]);
        loaded = { name: b.model, ctx: want };
        return json({ done: true });
      }
      res.writeHead(404); res.end();
    });
  });
  await listen(server);
  return { base: 'http://127.0.0.1:' + server.address().port, log, models, loaded: () => loaded, close: () => close(server) };
}

describe('context-pinned variant (Ollama reloads at 4096 otherwise)', () => {
  it('names variants and recognises them', () => {
    expect(lm.variantName('qwen3:4b', 65536)).toBe('qwen3:4b-cce64k');
    expect(lm.variantName('llama3', 32768)).toBe('llama3:cce32k');
    expect(lm.variantName('qwen3:4b-cce32k', 65536)).toBe('qwen3:4b-cce64k');   // never nests
    expect(lm.isCtxVariant('qwen3:4b-cce64k')).toBe(true);
    expect(lm.isCtxVariant('qwen3:4b')).toBe(false);
    expect(lm.baseModelName('llama3:cce32k')).toBe('llama3');
  });

  it('creates the variant, loads it at the pinned context and unloads the plain copy', async () => {
    const f = await fakeOllamaWithCreate({ maxOk: 98304 });
    const r = await lm.warmOllamaModel(f.base, 'm1', 131072);
    expect(r.ok).toBe(true);
    expect(r.model).toMatch(/^m1:cce\d+k$/);
    expect(r.corrected).toBe(r.model);
    const create = f.log.find(e => e[0] === 'create');
    expect(create[2]).toBe('m1');                 // derived from the plain model
    expect(create[3]).toBe(r.ctx);                // with the context that fit
    expect(f.log.some(e => e[0] === 'unload' && e[1] === 'm1')).toBe(true);
    expect(f.loaded().name).toBe(r.model);
    expect(f.loaded().ctx).toBe(r.ctx);           // the engine's next request keeps this context
    await f.close();
  });

  it('is a no-op the second time while the variant is resident', async () => {
    const f = await fakeOllamaWithCreate();
    const a = await lm.warmOllamaModel(f.base, 'm1', 131072);
    const before = f.log.length;
    const b = await lm.warmOllamaModel(f.base, 'm1', 131072);
    expect(b.model).toBe(a.model);
    expect(f.log.length).toBe(before);
    await f.close();
  });

  it('accepts a variant name and warms its base instead of nesting', async () => {
    const f = await fakeOllamaWithCreate();
    f.models['m1-cce32k'] = { ctx: 32768 };
    const r = await lm.warmOllamaModel(f.base, 'm1-cce32k', 131072);
    expect(r.ok).toBe(true);
    expect(r.model).not.toMatch(/cce\d+k-cce/);
    await f.close();
  });
});
