// Connectors panel in jsdom: status chips, Add/Remove button, GitHub extra account.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');

const PRESETS = [
  { id: 'github', name: 'GitHub', kind: 'http', url: 'https://api.githubcopilot.com/mcp/', blurb: 'Repos', supportsHeader: true },
  { id: 'supabase', name: 'Supabase', kind: 'http', url: 'https://mcp.supabase.com/mcp', blurb: 'DB', supportsHeader: false },
  { id: 'linear', name: 'Linear', kind: 'http', url: 'https://mcp.linear.app/mcp', blurb: 'Issues', supportsHeader: false },
];

const SERVERS = [
  { name: 'github', target: 'https://api.githubcopilot.com/mcp/ (HTTP)', state: 'connected', detail: 'Connected', kind: 'own' },
  { name: 'supabase', target: 'https://mcp.supabase.com/mcp (HTTP)', state: 'auth', detail: 'Needs authentication', kind: 'own' },
  { name: 'brave', target: 'npx -y server-brave-search', state: 'failed', detail: 'Failed to connect — CONNECTION_CLOSED', kind: 'own' },
  { name: 'plugin:x:y', target: 'https://p.example/mcp (HTTP)', state: 'failed', detail: 'Failed', kind: 'managed' },
];

async function open(extra = {}) {
  const h = loadRenderer({
    ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/usr/bin/claude', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: PRESETS },
      'connectors:status': { ok: true, servers: SERVERS, output: '' },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'default', provider: null },
      ...extra,
    },
  });
  await flush();
  h.window.switchView('connectors');
  await flush();
  return h;
}

const card = (h, title) => [...h.window.document.querySelectorAll('#connector-grid .card')]
  .find(c => c.querySelector('h4').textContent.includes(title));
const chip = (c) => c.querySelector('h4 .chip:last-child').textContent;
const btn = (c, label) => [...c.querySelectorAll('button')].find(b => b.textContent === label);

describe('connector status chips', () => {
  it('asks for a health check when the view opens', async () => {
    const h = await open();
    expect(h.calls.some(c => c.channel === 'connectors:status')).toBe(true);
  });

  it('shows connected, sign-in needed and not added on the right cards', async () => {
    const h = await open();
    expect(chip(card(h, 'GitHub'))).toBe('● connected');
    expect(chip(card(h, 'Supabase'))).toBe('● sign-in needed');
    expect(chip(card(h, 'Linear'))).toBe('not added');
  });

  it('turns Add into Remove for an added connector, and explains the sign-in', async () => {
    const h = await open();
    expect(btn(card(h, 'GitHub'), 'Remove')).toBeTruthy();
    expect(btn(card(h, 'Linear'), 'Add connector')).toBeTruthy();
    expect(card(h, 'Supabase').querySelector('.conn-hint').textContent).toMatch(/\/mcp/);
  });

  it('adds a missing connector and removes an existing one through the right calls', async () => {
    const h = await open({ 'connectors:add': { ok: true, output: 'Added' }, 'connectors:remove': { ok: true, output: '' } });
    btn(card(h, 'Linear'), 'Add connector').click();
    await flush();
    expect(h.calls.find(c => c.channel === 'connectors:add').payload.presetId).toBe('linear');
    btn(card(h, 'GitHub'), 'Remove').click();
    await flush();
    expect(h.calls.find(c => c.channel === 'connectors:remove').payload).toEqual({ name: 'github' });
  });

  it('shows a yellow "connected, slow" chip for a server whose tool list timed out', async () => {
    const slow = { name: 'github', target: 'https://api.githubcopilot.com/mcp/ (HTTP)', state: 'degraded', detail: 'Connected · tools fetch failed — Request timed out', kind: 'own' };
    const h = await open({ 'connectors:status': { ok: true, servers: [slow], output: '' } });
    const c = card(h, 'GitHub');
    expect(chip(c)).toBe('● connected, slow');
    expect(c.querySelector('h4 .chip:last-child').className).toContain('mcp-warn');
    expect(c.querySelector('.conn-hint').textContent).toMatch(/tool list timed out/);
  });

  it('survives a failed health check', async () => {
    const h = await open({ 'connectors:status': { ok: false, error: 'claude missing' } });
    expect(h.window.document.querySelector('#mcp-list').textContent).toMatch(/claude missing/);
  });
});

describe('your connectors list', () => {
  it('lists your own servers with a status and a Remove button', async () => {
    const h = await open();
    const rows = [...h.window.document.querySelectorAll('#mcp-list > .mcp-row')];
    expect(rows.map(r => r.querySelector('b').textContent)).toEqual(['github', 'supabase', 'brave']);
    expect(rows[2].textContent).toMatch(/CONNECTION_CLOSED/);
    // "connect to chat" attaches the connector to the open session so its
    // tools are callable; Remove deletes it from the CLI config.
    expect([...rows[0].querySelectorAll('button')].map(b => b.textContent)).toEqual(['connect to chat', 'Remove']);
  });

  it('connects a connector to the open chat on click', async () => {
    const h = await open({ 'chat:mcp': { ok: true, added: ['github'], servers: [] } });
    const rows = [...h.window.document.querySelectorAll('#mcp-list > .mcp-row')];
    [...rows[0].querySelectorAll('button')].find(b => b.textContent === 'connect to chat').click();
    await flush();
    const call = h.calls.find(c => c.channel === 'chat:mcp' && c.payload.op === 'connect');
    expect(call.payload).toEqual({ id: 'c1', op: 'connect', name: 'github' });
  });

  it('tucks plugin servers away without a Remove button', async () => {
    const h = await open();
    const d = h.window.document.querySelector('#mcp-list details.mcp-managed');
    expect(d.textContent).toMatch(/plugin:x:y/);
    expect(d.querySelector('button')).toBeNull();
  });
});

describe('plugin services that only need a sign-in', () => {
  const many = [
    { name: 'github', target: 'g (HTTP)', state: 'connected', detail: 'Connected', kind: 'own' },
    { name: 'plugin:sb:shopify', target: 's (HTTP)', state: 'connected', detail: 'Connected', kind: 'managed' },
    { name: 'plugin:data:definite', target: 'd (HTTP)', state: 'failed', detail: 'MCP endpoint not found', kind: 'managed' },
    ...['paypal', 'stripe', 'zapier'].map(n => ({ name: 'plugin:sb:' + n, target: n + ' (HTTP)', state: 'auth', detail: 'Needs authentication', kind: 'managed' })),
  ];
  const openMany = () => open({ 'connectors:status': { ok: true, servers: many, output: '' } });

  it('fold into one closed group, below the connected and failing ones', async () => {
    const h = await openMany();
    const d = h.window.document.querySelector('#mcp-list details.mcp-managed');
    expect(d.querySelector(':scope > summary').textContent).toMatch(/1 connected, 1 failing, 3 need sign-in/);
    const direct = [...d.querySelectorAll(':scope > .mcp-row b')].map(b => b.textContent);
    expect(direct).toEqual(['plugin:sb:shopify', 'plugin:data:definite']);
    const g = d.querySelector('details.mcp-signins');
    expect(g.open).toBe(false);
    expect(g.querySelector('summary').textContent).toMatch(/^3 services need a sign-in/);
    expect([...g.querySelectorAll('.mcp-row b')].map(b => b.textContent)).toEqual(['plugin:sb:paypal', 'plugin:sb:stripe', 'plugin:sb:zapier']);
    // The how-to is said once, in the summary, not on every row.
    expect(g.querySelectorAll('.mcp-why')).toHaveLength(0);
  });

  it('stay open after a refresh if the user opened them', async () => {
    const h = await openMany();
    const doc = h.window.document;
    doc.querySelector('details.mcp-managed').open = true;
    doc.querySelector('details.mcp-signins').open = true;
    doc.querySelector('#btn-mcp-refresh').click();
    await flush(6);
    expect(doc.querySelector('details.mcp-managed').open).toBe(true);
    expect(doc.querySelector('details.mcp-signins').open).toBe(true);
  });
});

describe('GitHub — another account', () => {
  const ghCard = (h) => card(h, 'another account');
  const fill = (h, name, token) => {
    const [n, t] = ghCard(h).querySelectorAll('input');
    n.value = name; t.value = token;
  };

  it('adds a named server with the preset URL and the pasted token', async () => {
    const h = await open({ 'connectors:addCustom': { ok: true, output: 'Added' } });
    fill(h, 'github-work', 'ghp_abc123');
    btn(ghCard(h), 'Add GitHub account').click();
    await flush();
    const call = h.calls.find(c => c.channel === 'connectors:addCustom');
    expect(call.payload).toMatchObject({ name: 'github-work', url: 'https://api.githubcopilot.com/mcp/', header: 'ghp_abc123' });
  });

  it('refuses an empty token and a name that already exists', async () => {
    const h = await open({ 'connectors:addCustom': { ok: true } });
    fill(h, 'github-work', '');
    btn(ghCard(h), 'Add GitHub account').click();
    fill(h, 'github', 'ghp_abc123');
    btn(ghCard(h), 'Add GitHub account').click();
    await flush();
    expect(h.calls.some(c => c.channel === 'connectors:addCustom')).toBe(false);
  });

  it('clears the token field after a successful add', async () => {
    const h = await open({ 'connectors:addCustom': { ok: true, output: 'Added' } });
    fill(h, 'github-work', 'ghp_abc123');
    btn(ghCard(h), 'Add GitHub account').click();
    await flush();
    expect(ghCard(h).querySelectorAll('input')[1].value).toBe('');
  });
});
