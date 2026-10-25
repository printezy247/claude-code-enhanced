// Phase 7 (0.9.74): connectors switch on and off by themselves.
//
// The scorer, the per-project memory, the Auto / Always on / Off choices,
// duplicate handling and reconnects are tested as logic; the chat manager is
// tested against a fake engine (does a new chat in the same project start with
// the right connectors?); the Overview card is tested in jsdom (no switch).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ca = require('../src/main/connectorauto.js');
const tokencount = require('../src/main/tokencount.js');
const ChatManager = require('../src/main/chats.js');
const { loadRenderer, flush } = require('./helpers/renderer.js');

const tool = (name, description = '') => ({ name, description });
const github = { name: 'github', status: 'connected', tools: [tool('list_issues', 'List issues in a repository'), tool('create_pull_request', 'Open a pull request'), tool('get_file_contents', 'Read a file from a repo')] };
const linear = { name: 'linear', status: 'connected', tools: [tool('list_issues', 'Issues in a team'), tool('create_issue', 'Create a ticket'), tool('list_cycles', 'Sprints')] };
const notion = { name: 'notion', status: 'connected', tools: [tool('search', 'Search pages and databases'), tool('create_page', 'New page')] };
const sentry = { name: 'sentry', status: 'connected', tools: [tool('get_issue_details', 'Stacktrace for an error'), tool('list_releases', 'Releases')] };

describe('words and scoring', () => {
  it('splits camel, snake and kebab case, drops filler, keeps plurals and gerunds findable', () => {
    const w = ca.words('Please list the openIssues for my_repo and check-releases while searching');
    expect(w.has('open')).toBe(true);
    expect(w.has('issues')).toBe(true);
    expect(w.has('issue')).toBe(true);
    expect(w.has('repo')).toBe(true);
    expect(w.has('releases')).toBe(true);
    expect(w.has('search')).toBe(true);
    expect(w.has('the')).toBe(false);
    expect(w.has('please')).toBe(false);
  });

  it('puts the connector the message names first, then the one whose tools match', () => {
    const want = ca.words('open a pull request on github for this branch');
    expect(ca.scoreServer(github, want)).toBeGreaterThan(ca.scoreServer(linear, want));
    expect(ca.scoreServer(github, want)).toBeGreaterThan(ca.scoreServer(notion, want));
    expect(ca.scoreServer(notion, want)).toBe(0);
  });

  it('adds history: use in this project, use in this chat, use a moment ago', () => {
    const want = ca.words('hello');
    expect(ca.scoreServer(notion, want)).toBe(0);
    expect(ca.scoreServer(notion, want, { projectUses: 7 })).toBeGreaterThan(0);
    expect(ca.scoreServer(notion, want, { chatUses: 1 })).toBe(3);
    expect(ca.scoreServer(notion, want, { recent: true })).toBe(3);
    expect(ca.scoreServer(notion, want, { projectUses: 1000000 })).toBeLessThanOrEqual(6);
  });
});

describe('when picking is needed', () => {
  it('only for a small window, or when tool search is not available', () => {
    expect(ca.needsPick({ contextTokens: 32768, toolSearchOn: true })).toBe(true);
    expect(ca.needsPick({ contextTokens: 127999, toolSearchOn: true })).toBe(true);
    expect(ca.needsPick({ contextTokens: 200000, toolSearchOn: true })).toBe(false);
    expect(ca.needsPick({ contextTokens: 0, toolSearchOn: true })).toBe(false);
    expect(ca.needsPick({ contextTokens: 200000, toolSearchOn: false })).toBe(true);
  });
  it('can be forced either way from Settings', () => {
    expect(ca.needsPick({ contextTokens: 8000, toolSearchOn: false, setting: 'off' })).toBe(false);
    expect(ca.needsPick({ contextTokens: 1000000, toolSearchOn: true, setting: 'always' })).toBe(true);
  });
  it('gives a smaller window a smaller tool budget', () => {
    expect(ca.toolBudgetFor(16000, true)).toBeLessThan(ca.toolBudgetFor(48000, true));
    expect(ca.toolBudgetFor(48000, true)).toBeLessThan(ca.toolBudgetFor(100000, true));
    expect(ca.toolBudgetFor(1000000, true)).toBe(0);
    expect(ca.toolBudgetFor(1000000, false)).toBeGreaterThan(0);
  });
});

describe('the plan for one message', () => {
  const all = [github, linear, notion, sentry];

  it('shows everything when picking is off', () => {
    const p = ca.plan({ servers: all, prompt: 'hello', cwd: '/p', pick: false });
    expect([...p.show].sort()).toEqual(['github', 'linear', 'notion', 'sentry']);
    expect(p.hide.size).toBe(0);
  });

  it('shows only the connector the message needs when picking is on', () => {
    const p = ca.plan({ servers: all, prompt: 'open a pull request on github', cwd: '/p', pick: true, toolBudget: 12 });
    expect([...p.show]).toEqual(['github']);
    expect([...p.hide].sort()).toEqual(['linear', 'notion', 'sentry']);
    expect(p.why.notion).toBe('not needed');
  });

  it('stops at the tool budget, best fit first', () => {
    const p = ca.plan({ servers: all, prompt: 'github issues and linear issues and notion search', cwd: '/p', pick: true, toolBudget: 4 });
    expect(p.show.size).toBe(1);
    expect(Object.values(p.why)).toContain('over budget');
    const roomy = ca.plan({ servers: all, prompt: 'github issues and linear issues and notion search', cwd: '/p', pick: true, toolBudget: 20 });
    expect(roomy.show.has('github') && roomy.show.has('linear') && roomy.show.has('notion')).toBe(true);
  });

  it('starts a new chat with what the project used before, when the message names nothing', () => {
    const p = ca.plan({ servers: all, prompt: '', cwd: '/p', pick: true, toolBudget: 12, projectUsage: { sentry: 9, github: 2 } });
    expect(p.show.has('sentry')).toBe(true);
    expect(p.show.has('notion')).toBe(false);
  });

  it('keeps a connector the chat used a moment ago', () => {
    const p = ca.plan({ servers: all, prompt: 'and now add a test', cwd: '/p', pick: true, toolBudget: 12, recent: ['sentry'], chatUses: { sentry: 2 } });
    expect(p.show.has('sentry')).toBe(true);
  });

  it('touches only a connector that is up or that was switched off', () => {
    const down = { name: 'broken', status: 'failed', tools: [] };
    const auth = { name: 'gated', status: 'needs-auth', tools: [] };
    const p = ca.plan({ servers: [github, down, auth], prompt: 'github', cwd: '/p', pick: true });
    expect(p.hide.has('broken')).toBe(false);
    expect(p.show.has('gated')).toBe(false);
  });

  it('a duplicate pair loses its weaker copy, but not for a shared generic name', () => {
    const copy = { ...github, name: 'github-project' };
    const p = ca.plan({ servers: [github, copy, notion], prompt: '', cwd: '/p', projectUsage: { github: 5 } });
    expect(p.hide.has('github-project')).toBe(true);
    expect(p.show.has('github')).toBe(true);
    expect(p.why['github-project']).toMatch(/duplicate of github/);
    // linear and github share only `list_issues`: two different connectors.
    expect(ca.duplicatePairs([github, linear])).toEqual([]);
    const q = ca.plan({ servers: [github, linear], prompt: '', cwd: '/p' });
    expect(q.hide.size).toBe(0);
  });

  it('a duplicate pair keeps the better fit for the message', () => {
    const copy = { ...github, name: 'gh-work' };
    const p = ca.plan({ servers: [github, copy], prompt: 'use gh-work to list issues', cwd: '/p' });
    expect(p.show.has('gh-work')).toBe(true);
    expect(p.hide.has('github')).toBe(true);
  });
});

describe('Auto / Always on / Off', () => {
  const all = [github, linear, notion];
  it('Off is hidden, Always on is shown and survives picking', () => {
    const modes = { global: { linear: 'off', notion: 'on' }, projects: {} };
    const p = ca.plan({ servers: all, prompt: 'linear issues', cwd: '/p', modes, pick: true, toolBudget: 3 });
    expect(p.hide.has('linear')).toBe(true);
    expect(p.show.has('notion')).toBe(true);
    expect(p.why.notion).toBe('pinned');
    expect(p.why.linear).toBe('off');
  });
  it('a project choice beats the global one', () => {
    const modes = { global: { linear: 'off' }, projects: { '/work': { linear: 'on' } } };
    expect(ca.modeFor(modes, '/work', 'linear')).toBe('on');
    expect(ca.modeFor(modes, '/other', 'linear')).toBe('off');
    expect(ca.modeFor(modes, '/work', 'github')).toBe('auto');
  });
  it('setting Auto removes the entry, and an emptied project disappears', () => {
    let m = ca.setMode(null, '/work', 'linear', 'off');
    expect(m.projects['/work']).toEqual({ linear: 'off' });
    m = ca.setMode(m, 'global', 'notion', 'on');
    m = ca.setMode(m, '/work', 'linear', 'auto');
    expect(m.projects['/work']).toBeUndefined();
    expect(m.global).toEqual({ notion: 'on' });
  });
  it('cleans what is stored', () => {
    const m = ca.normalizeModes({ global: { a: 'off', b: 'auto', c: 'bogus', d: 7 }, projects: { '/x': { e: 'on', f: 'maybe' }, '/y': {}, '': { g: 'on' } } });
    expect(m).toEqual({ global: { a: 'off' }, projects: { '/x': { e: 'on' } } });
    expect(ca.normalizeModes(undefined)).toEqual({ global: {}, projects: {} });
    expect(ca.normalizeModes('nope')).toEqual({ global: {}, projects: {} });
  });
  it('an Always-on copy is never dropped as a duplicate', () => {
    const copy = { ...github, name: 'gh-copy' };
    const p = ca.plan({ servers: [github, copy], prompt: '', cwd: '/p', modes: { global: { 'gh-copy': 'on' }, projects: {} }, projectUsage: { github: 99 } });
    expect(p.show.has('gh-copy')).toBe(true);
  });
});

describe('remembered per project', () => {
  it('counts a use and keeps projects apart', () => {
    let u = ca.recordUse({}, '/a', 'github');
    u = ca.recordUse(u, '/a', 'github');
    u = ca.recordUse(u, '/b', 'notion');
    expect(u).toEqual({ '/a': { github: 2 }, '/b': { notion: 1 } });
  });
  it('is bounded in projects, never dropping the one just used', () => {
    let u = {};
    for (let i = 0; i < 80; i++) u = ca.recordUse(u, '/p' + i, 's');
    expect(Object.keys(u).length).toBeLessThanOrEqual(60);
    expect(u['/p79']).toBeTruthy();
  });
  it('cleans a stored record', () => {
    expect(ca.normalizeUsage({ '/a': { x: 3, y: -1, z: 'q' }, '/b': {}, '': { x: 1 } })).toEqual({ '/a': { x: 3 } });
  });
  it('names the server of a connector tool', () => {
    expect(ca.serverOf('mcp__github__list_issues')).toBe('github');
    expect(ca.serverOf('mcp__my-server__do__thing')).toBe('my-server');
    expect(ca.serverOf('Bash')).toBe('');
  });
});

describe('reconnect delays', () => {
  it('grow, then stop', () => {
    const d = [0, 1, 2, 3, 4, 5].map(ca.reconnectDelay);
    expect(d.slice(0, 5)).toEqual([5, 15, 45, 120, 300]);
    expect(d[5]).toBe(0);
  });
});

/* ---------------- the chat manager against a fake engine ---------------- */

let servers = [];
let toggles = [];
let reconnects = [];
let lastOptions = null;
let pushed = [];

const fakeSdk = {
  query: ({ options }) => {
    lastOptions = options;
    const ctrl = {
      interrupt: vi.fn(async () => ({ still_queued: [] })),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      getContextUsage: vi.fn(async () => ({ totalTokens: 10, maxTokens: 100, percentage: 10 })),
      mcpServerStatus: vi.fn(async () => servers.map((s) => ({ ...s }))),
      toggleMcpServer: vi.fn(async (name, enabled) => {
        toggles.push([name, enabled]);
        const s = servers.find((x) => x.name === name);
        if (s) s.status = enabled ? 'connected' : 'disabled';
      }),
      reconnectMcpServer: vi.fn(async (name) => {
        reconnects.push(name);
        const s = servers.find((x) => x.name === name);
        if (s) s.status = 'connected';
      }),
    };
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1', model: 'm' };
      await new Promise(() => {});
    })();
    return Object.assign(gen, ctrl);
  },
};

const until = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return pred();
};

const SMALL = { uid: 'p', protocol: 'openai', baseUrl: 'https://x.example/v1', model: 'small' };

function manager(extra = {}) {
  const mgr = new ChatManager({ proxyToken: 't', sdk: fakeSdk, contextOf: () => 32768, ...extra });
  const events = [];
  mgr.on('event', (id, e) => events.push({ id, ...e }));
  return { mgr, events };
}

async function open(mgr, settings = {}, cwd = '/work/app') {
  const r = await mgr.create({ cwd, providerInstance: SMALL, settings, model: 'small' });
  const chat = mgr.chats.get(r.id);
  const realPush = chat.push;
  chat.push = (f) => { pushed.push(f); return realPush(f); };
  await until(() => chat.connectorsStarted);
  await chat.tickChain;
  return { id: r.id, chat };
}

beforeEach(() => {
  servers = [
    { ...github, tools: github.tools.map((t) => ({ ...t })) },
    { ...linear, tools: linear.tools.map((t) => ({ ...t })) },
    { ...notion, tools: notion.tools.map((t) => ({ ...t })) },
    { ...sentry, tools: sentry.tools.map((t) => ({ ...t })) },
  ];
  toggles = []; reconnects = []; pushed = []; lastOptions = null;
});
afterEach(() => vi.useRealTimers());

describe('a chat on a small model', () => {
  it('starts with no connector switched off by hand, and only those it needs shown', async () => {
    const { mgr, events } = manager();
    const { id } = await open(mgr);
    // no history and no prompt yet: nothing is relevant, so nothing is loaded
    expect(servers.every((s) => s.status === 'disabled')).toBe(true);
    mgr.send(id, 'open a pull request on github');
    await until(() => pushed.length === 1);
    expect(servers.find((s) => s.name === 'github').status).toBe('connected');
    expect(servers.filter((s) => s.status === 'connected').map((s) => s.name)).toEqual(['github']);
    expect(events.some((e) => e.kind === 'connectors-changed')).toBe(true);
  });

  it('switches the message in only after the connectors are chosen', async () => {
    const { mgr } = manager();
    const { id } = await open(mgr);
    mgr.send(id, 'search notion for the roadmap');
    expect(pushed.length).toBe(0);
    await until(() => pushed.length === 1);
    expect(servers.find((s) => s.name === 'notion').status).toBe('connected');
  });

  it('a following message about something else swaps the connectors', async () => {
    const { mgr } = manager();
    const { id } = await open(mgr);
    mgr.send(id, 'list github issues'); await until(() => pushed.length === 1);
    mgr.send(id, 'what does sentry say about this error'); await until(() => pushed.length === 2);
    const up = servers.filter((s) => s.status === 'connected').map((s) => s.name);
    expect(up).toContain('sentry');
  });

  it('never touches a window large enough for tool search', async () => {
    const { mgr } = manager({ contextOf: () => 1000000 });
    const { id } = await open(mgr);
    mgr.send(id, 'hello');
    expect(pushed.length).toBe(1);   // synchronous: nothing to decide first
    expect(toggles).toEqual([]);
  });

  it('Settings can turn picking off', async () => {
    const { mgr } = manager();
    const { id } = await open(mgr, { connectorPick: 'off' });
    mgr.send(id, 'hello');
    expect(pushed.length).toBe(1);
    expect(toggles).toEqual([]);
  });
});

describe('a new chat in the same project', () => {
  it('starts with the connectors that project used, not the ones another project used', async () => {
    const memory = (() => {
      let u = {};
      return { usage: (c) => u[c] || {}, note: (c, s) => { u = ca.recordUse(u, c, s); } };
    })();
    const { mgr } = manager({ connectorMemory: memory });
    // The first chat in /work/app uses sentry; /other uses notion.
    memory.note('/work/app', 'sentry'); memory.note('/work/app', 'sentry'); memory.note('/other', 'notion');
    await open(mgr, {}, '/work/app');
    expect(servers.filter((s) => s.status === 'connected').map((s) => s.name)).toEqual(['sentry']);
    servers.forEach((s) => { s.status = 'connected'; }); toggles = [];
    await open(mgr, {}, '/other');
    expect(servers.filter((s) => s.status === 'connected').map((s) => s.name)).toEqual(['notion']);
  });

  it('counts a connector tool call in the project memory', async () => {
    const calls = [];
    const memory = { usage: () => ({}), note: (c, s) => calls.push([c, s]) };
    const local = { ...fakeSdk, query: (a) => {
      const q = fakeSdk.query(a);
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's', model: 'm' };
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__github__list_issues', input: {} }] } };
        await new Promise(() => {});
      })();
      return Object.assign(gen, { mcpServerStatus: q.mcpServerStatus, toggleMcpServer: q.toggleMcpServer, reconnectMcpServer: q.reconnectMcpServer, interrupt: q.interrupt });
    } };
    const mgr = new ChatManager({ proxyToken: 't', sdk: local, contextOf: () => 1000000, connectorMemory: memory });
    await mgr.create({ cwd: '/work/app', providerInstance: SMALL, settings: {}, model: 'small' });
    await until(() => calls.length === 1);
    expect(calls).toEqual([['/work/app', 'github']]);
  });
});

describe('your choices', () => {
  it('Off stays off and Always on stays on, even for a large window', async () => {
    const { mgr } = manager({ contextOf: () => 1000000 });
    const modes = { global: { linear: 'off' }, projects: { '/work/app': { notion: 'on' } } };
    servers.find((s) => s.name === 'notion').status = 'disabled';
    const { id } = await open(mgr, { connectorModes: modes });
    expect(servers.find((s) => s.name === 'linear').status).toBe('disabled');
    expect(servers.find((s) => s.name === 'notion').status).toBe('connected');
    expect(servers.find((s) => s.name === 'github').status).toBe('connected');
    const st = await mgr.mcpStatus(id);
    expect(st.find((s) => s.name === 'linear').how).toBe('off');
    expect(st.find((s) => s.name === 'notion').how).toBe('pinned');
  });

  it('the status line says how each connector is being used', async () => {
    const { mgr } = manager({ contextOf: () => 1000000 });
    const { id, chat } = await open(mgr);
    chat.connectorUses.github = 3;
    const st = await mgr.mcpStatus(id);
    expect(st.find((s) => s.name === 'github').how).toBe('used 3×');
    expect(st.find((s) => s.name === 'notion').how).toBe('auto · loaded');
  });

  it('a connector CCE switched off reads as idle, not as disabled by you', async () => {
    const { mgr } = manager();
    const { id } = await open(mgr);
    const st = await mgr.mcpStatus(id);
    expect(st.every((s) => s.how === 'auto · idle')).toBe(true);
  });
});

describe('recovery', () => {
  it('reconnects a failed connector on its own, with growing waits, and leaves "needs sign-in" for the user', async () => {
    vi.useFakeTimers();
    servers[0].status = 'failed';
    servers[1].status = 'needs-auth';
    const { mgr } = manager({ contextOf: () => 1000000 });
    await mgr.create({ cwd: '/w', providerInstance: SMALL, settings: {}, model: 'small' });
    await vi.advanceTimersByTimeAsync(10);
    expect(reconnects).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconnects).toEqual(['github']);
    expect(servers[1].status).toBe('needs-auth');
    expect(servers[0].status).toBe('connected');
  });

  it('keeps trying a stubborn one a few times, then gives up', async () => {
    vi.useFakeTimers();
    servers[0].status = 'failed';
    let n = 0;
    const stubborn = { ...fakeSdk, query: (a) => {
      const q = fakeSdk.query(a);
      q.reconnectMcpServer = vi.fn(async () => { n++; servers[0].status = 'failed'; });
      return q;
    } };
    const mgr = new ChatManager({ proxyToken: 't', sdk: stubborn, contextOf: () => 1000000 });
    await mgr.create({ cwd: '/w', providerInstance: SMALL, settings: {}, model: 'small' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(n).toBe(5);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(n).toBe(5);
  });

  it('stops when the chat is closed', async () => {
    vi.useFakeTimers();
    servers[0].status = 'failed';
    const { mgr } = manager({ contextOf: () => 1000000 });
    const r = await mgr.create({ cwd: '/w', providerInstance: SMALL, settings: {}, model: 'small' });
    await vi.advanceTimersByTimeAsync(10);
    mgr.close(r.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconnects).toEqual([]);
  });
});

describe('tool search for every provider', () => {
  it('is on for the default login and Anthropic\'s API, and for translated providers', () => {
    const { toolSearchApplies } = ChatManager;
    expect(toolSearchApplies(null, {})).toBe(true);
    expect(toolSearchApplies({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }, {})).toBe(true);
    expect(toolSearchApplies({ protocol: 'openai', baseUrl: 'https://x.example/v1' }, {})).toBe(true);
    expect(toolSearchApplies({ protocol: 'anthropic', baseUrl: 'https://gateway.example' }, {})).toBe(false);
    expect(toolSearchApplies(null, { toolSearch: false })).toBe(false);
  });
});

describe('what it saves in the context (12 connectors)', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    name: 'conn' + i, status: 'connected',
    tools: Array.from({ length: 14 }, (_, j) => ({ name: 'tool_' + i + '_' + j, description: 'Does thing ' + j + ' for service ' + i + ' with a fairly long description of the arguments it takes' })),
  }));
  const defs = (list) => tokencount.estimateText(JSON.stringify(list.flatMap((s) => s.tools.map((t) => ({ name: 'mcp__' + s.name + '__' + t.name, description: t.description, input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } })))));

  it('shows a small model far fewer tool definitions than all twelve', () => {
    const before = defs(many);
    const p = ca.plan({ servers: many, prompt: 'use conn3 to run tool_3_2', cwd: '/p', pick: true, toolBudget: ca.toolBudgetFor(32768, true) });
    const after = defs(many.filter((s) => p.show.has(s.name)));
    expect(p.show.has('conn3')).toBe(true);
    expect(after).toBeLessThan(before / 5);
    // eslint-disable-next-line no-console
    console.log('[smoke] 12 connectors: all loaded = ' + before + ' tokens, picked = ' + after + ' tokens');
  });
});

/* ---------------- the Overview card ---------------- */

describe('Overview connectors card', () => {
  const SERVERS = [
    { name: 'github', status: 'connected', tools: [tool('list_issues'), tool('create_pr')], how: 'used 3×' },
    { name: 'linear', status: 'disabled', tools: [tool('list_issues')], how: 'auto · idle' },
    { name: 'notion', status: 'connected', tools: [tool('search')], how: 'auto · loaded' },
    { name: 'supabase', status: 'needs-auth', tools: [], how: '' },
    { name: 'brave', status: 'failed', tools: [], how: '', error: 'CONNECTION_CLOSED' },
  ];
  async function overview() {
    const h = loadRenderer({
      ipc: {
        'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '', version: '' }, home: '/home/test' },
        'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
        'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
        'connectors:presets': { ok: true, presets: [] },
        'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
        'chat:mcp': { ok: true, servers: SERVERS },
      },
    });
    await flush();
    h.window.__connCache = {};
    h.window.renderOverview();
    await new Promise((r) => setTimeout(r, 1700));
    await flush();
    return h;
  }
  const cardOf = (h) => h.window.document.querySelector('#overview-body [data-card="connectors"]');

  it('has no per-chat switch, and shows how each connector is being used', async () => {
    const h = await overview();
    const c = cardOf(h);
    expect(c).toBeTruthy();
    expect(c.querySelectorAll('.switch').length).toBe(0);
    expect(c.querySelectorAll('[role="switch"]').length).toBe(0);
    expect([...c.querySelectorAll('button')].some((b) => /^(enable|disable)$/.test(b.textContent))).toBe(false);
    const how = [...c.querySelectorAll('.conn-how')].map((n) => n.textContent);
    expect(how).toEqual(['used 3×', 'auto · idle', 'auto · loaded']);
  });

  it('offers Sign in and Reconnect only where a connector needs them, and a link to Settings', async () => {
    const h = await overview();
    const c = cardOf(h);
    const labels = [...c.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels.filter((l) => l === 'Sign in').length).toBe(1);
    expect(labels.filter((l) => l === 'Reconnect').length).toBe(1);
    expect(labels).toContain('Manage connectors →');
  });

  it('no longer tells you to disconnect unused connectors', async () => {
    const h = await overview();
    expect(cardOf(h).textContent).not.toMatch(/disconnect unused/i);
  });
});
