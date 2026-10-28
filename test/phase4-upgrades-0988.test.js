// Phase 4 of the 26-item upgrade plan (items 15-20):
//   15. Codebase index — search code without burning context
//   16. Usage dashboard — per-model breakdown, not just per-day
//   17. Loop cost guard — a spend ceiling CCE itself enforces mid-session
//   18. Skills manager sync — diff disk vs snapshot, prune dead toggles
//   19. Auto-learn skills — propose a SKILL.md when a workflow repeats
//   20. Plugin/MCP marketplace — curated catalog, one-click add
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const codeindex = require('../src/main/codeindex.js');
const usageparse = require('../src/main/usageparse.js');
const spendguard = require('../src/main/spendguard.js');
const skilltoggle = require('../src/main/skilltoggle.js');
const autolearn = require('../src/main/autolearn.js');
const marketplace = require('../src/main/marketplace.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let booted = null;
async function bootMain() {
  if (booted) return booted;
  const stub = require('electron');
  stub.__reset();
  require('../src/main/main.js');
  await sleep(250);
  booted = stub;
  return booted;
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-p4-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'),
    'function buildBoard() {}\nclass ChatSession {}\nconst renderAll = () => {};\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk', 'x.js'), 'function shouldBeIgnored() {}\n');
  return dir;
}

// ---------- 15. codebase index -------------------------------------------------

describe('codebase index (item 15)', () => {
  it('indexes symbols, skips junk dirs, and finds them back', async () => {
    const dir = tmpProject();
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-idx-'));
    try {
      const idx = codeindex.createCodeIndex({ storeDir });
      const built = await idx.build(dir);
      expect(built.files).toBeGreaterThanOrEqual(2);       // app.js + README.md
      expect(built.symbols).toBeGreaterThanOrEqual(3);     // buildBoard, ChatSession, renderAll
      const hits = idx.search(dir, 'buildBoard');
      expect(hits.some((h) => h.path.endsWith('src/app.js'))).toBe(true);
      expect(hits.some((h) => h.path.includes('node_modules'))).toBe(false);
      const sym = idx.search(dir, 'ChatSession');
      expect(sym[0].symbol).toBe('ChatSession');
      // A query that matches nothing is an empty list, not a crash.
      expect(idx.search(dir, 'zzz-no-such-thing')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('the index MCP server is offered to chats when the setting is on', () => {
    const chatsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'chats.js'), 'utf8');
    expect(chatsSrc).toMatch(/codebaseIndex/);
    expect(chatsSrc).toMatch(/cce_index/);
    expect(chatsSrc).toMatch(/search_codebase/);
  });

  it('the IPC surface exists and preload allowlists it', async () => {
    const stub = await bootMain();
    const h = stub.__state.handlers;
    for (const ch of ['codeindex:build', 'codeindex:status', 'codeindex:search']) {
      expect(typeof h.get(ch), ch).toBe('function');
    }
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    for (const ch of ['codeindex:build', 'codeindex:status', 'codeindex:search']) {
      expect(preload).toContain("'" + ch + "'");
    }
  });
});

// ---------- 16. usage per-model ------------------------------------------------

describe('usage dashboard per-model (item 16)', () => {
  it('parses one transcript line-set into tokens, cost and model', () => {
    const text = [
      '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":50}}}',
      '{"type":"assistant","message":{"model":"claude-haiku-5","usage":{"input_tokens":10,"output_tokens":5}}}',
      '{"type":"result","total_cost_usd": 0.0123}',
    ].join('\n');
    const r = usageparse.parseTranscript(text);
    expect(r.msgs).toBe(2);
    expect(r.inTok).toBe(110);
    expect(r.outTok).toBe(55);
    expect(r.cost).toBeCloseTo(0.0123);
    expect(r.models['claude-opus-5']).toEqual({ tokens: 150, cost: 0 });
    expect(r.models['claude-haiku-5'].tokens).toBe(15);
  });

  it('usage:scan returns a models breakdown alongside the days', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    expect(src).toMatch(/usageparse\.parseTranscript/);
    expect(src).toMatch(/models:/);   // the handler returns { days, total, sessions, models }
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    expect(preload).toContain("'usage:scan'");   // already allowed; guard against accidental removal
    const usage = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app', 'usage.js'), 'utf8');
    expect(usage).toMatch(/usage-models/);
  });
});

// ---------- 17. spend / loop cost guard -----------------------------------------

describe('spend ceiling (item 17)', () => {
  it('trips once when cumulative cost crosses the ceiling', () => {
    const g = spendguard.createSpendGuard({ limitUsd: 1 });
    expect(g.add(0.4).tripped).toBe(false);
    const t = g.add(0.7);
    expect(t.tripped).toBe(true);
    expect(t.spent).toBeCloseTo(1.1);
    // It does not trip again on the next observation.
    expect(g.add(0.1).tripped).toBe(false);
  });

  it('no ceiling means never trips; a bad ceiling is ignored', () => {
    expect(spendguard.createSpendGuard({}).add(9999).tripped).toBe(false);
    expect(spendguard.createSpendGuard({ limitUsd: -5 }).add(9999).tripped).toBe(false);
  });

  it('chats.js accumulates total_cost_usd and emits cost-guard', () => {
    const chatsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'chats.js'), 'utf8');
    expect(chatsSrc).toMatch(/spendguard/);
    expect(chatsSrc).toMatch(/cost-guard/);
    const events = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat', 'events.js'), 'utf8');
    expect(events).toMatch(/cost-guard/);
  });
});

// ---------- 18. skills sync ------------------------------------------------------

describe('skills manager sync (item 18)', () => {
  it('diffs disk against the last snapshot and prunes dead toggles', () => {
    const r = skilltoggle.syncState({
      onDisk: ['a', 'b', 'c'],
      snapshot: ['a', 'b', 'old-skill'],
      disabled: ['old-skill', 'b'],
    });
    expect(r.added).toEqual(['c']);
    expect(r.removed).toEqual(['old-skill']);
    expect(r.pruned).toEqual(['old-skill']);      // dead toggle dropped
    expect(r.disabledAfter).toEqual(['b']);
  });

  it('skills:sync handler is registered and preload allowlists it', async () => {
    const stub = await bootMain();
    expect(typeof stub.__state.handlers.get('skills:sync')).toBe('function');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    expect(preload).toContain("'skills:sync'");
  });
});

// ---------- 19. auto-learn skills --------------------------------------------------

describe('auto-learn skills (item 19)', () => {
  it('parses a skill proposal and rejects junk', () => {
    const good = autolearn.parseProposals('Here: [{"name":"git-flow","description":"Commit flow","body":"Steps to commit."}]');
    expect(good.length).toBe(1);
    expect(good[0].name).toBe('git-flow');
    expect(autolearn.parseProposals('[]')).toEqual([]);
    expect(autolearn.parseProposals('not json')).toEqual([]);
    // A name with path traversal is not usable as a directory name.
    const evil = autolearn.parseProposals('[{"name":"../evil","description":"d","body":"b"}]');
    expect(evil).toEqual([]);
  });

  it('accepting a proposal writes a SKILL.md into the skills dir', async () => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-skills-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-al-'));
    try {
      const al = autolearn.createAutoLearn({ skillsDir, storeFile: path.join(storeDir, 'pending.json') });
      const queued = al.addPending([{ name: 'demo-skill', description: 'A demo', body: 'Do the thing.' }]);
      expect(queued).toBe(1);
      const pending = al.listPending();
      expect(pending[0].name).toBe('demo-skill');
      const res = await al.resolve('demo-skill', true);
      expect(res.saved).toBe(true);
      const md = fs.readFileSync(path.join(skillsDir, 'demo-skill', 'SKILL.md'), 'utf8');
      expect(md).toContain('name: demo-skill');
      expect(md).toContain('description: A demo');
      expect(md).toContain('Do the thing.');
      expect(al.listPending()).toEqual([]);
      // Rejecting removes it from pending without writing anything.
      al.addPending([{ name: 'rejected-skill', description: 'd', body: 'b' }]);
      const rej = await al.resolve('rejected-skill', false);
      expect(rej.saved).toBe(false);
      expect(fs.existsSync(path.join(skillsDir, 'rejected-skill'))).toBe(false);
    } finally {
      fs.rmSync(skillsDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('the IPC surface and the memory-panel hook exist', async () => {
    const stub = await bootMain();
    const h = stub.__state.handlers;
    for (const ch of ['skills:autolearn-prompt', 'skills:autolearn-propose', 'skills:autolearn-pending', 'skills:autolearn-resolve']) {
      expect(typeof h.get(ch), ch).toBe('function');
    }
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    for (const ch of ['skills:autolearn-prompt', 'skills:autolearn-propose', 'skills:autolearn-pending', 'skills:autolearn-resolve']) {
      expect(preload).toContain("'" + ch + "'");
    }
    const panels = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'chat', 'panels.js'), 'utf8');
    expect(panels).toMatch(/skills:autolearn-pending/);
    expect(panels).toMatch(/skills:autolearn-resolve/);
  });
});

// ---------- 20. marketplace ----------------------------------------------------------

describe('plugin/MCP marketplace (item 20)', () => {
  it('ships a curated catalog with only safe entry kinds', () => {
    const entries = marketplace.list();
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const e of entries) {
      expect(['mcp', 'plugin']).toContain(e.kind);
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.name).toBeTruthy();
      if (e.kind === 'mcp') {
        expect(['http', 'stdio']).toContain(e.mcp.type);
        if (e.mcp.type === 'http') expect(e.mcp.url).toMatch(/^https:\/\//);   // no plain http
      }
      if (e.kind === 'plugin') expect(e.url).toMatch(/^https:\/\//);
    }
  });

  it('an mcp entry installs through the connector path, a plugin opens its page', async () => {
    const added = [];
    const res = await marketplace.install('context7', {
      addConnector: async (cfg) => { added.push(cfg); return { ok: true }; },
      openExternal: async () => { throw new Error('should not open for mcp'); },
    });
    expect(res.ok).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0].name).toBe('context7');
    const plugin = marketplace.list().find((e) => e.kind === 'plugin');
    const opened = [];
    const res2 = await marketplace.install(plugin.id, {
      addConnector: async () => { throw new Error('should not add for plugin'); },
      openExternal: async (url) => { opened.push(url); },
    });
    expect(res2.opened).toBe(true);
    expect(opened[0]).toBe(plugin.url);
    const missing = await marketplace.install('no-such-entry', { addConnector: async () => ({}), openExternal: async () => {} });
    expect(missing.error).toMatch(/unknown/i);
  });

  it('the IPC surface exists and the Connectors view renders the catalog', async () => {
    const stub = await bootMain();
    expect(typeof stub.__state.handlers.get('marketplace:list')).toBe('function');
    expect(typeof stub.__state.handlers.get('marketplace:install')).toBe('function');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
    expect(preload).toContain("'marketplace:list'");
    expect(preload).toContain("'marketplace:install'");
    const conn = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app', 'connectors.js'), 'utf8');
    expect(conn).toMatch(/marketplace:list/);
    expect(conn).toMatch(/marketplace:install/);
  });
});
