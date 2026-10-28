'use strict';
// Marketplace (item 20): a curated catalog of MCP connectors and plugin pages.
// MCP entries install through the normal connector path (nothing downloaded —
// the same `claude mcp add` flow Connectors already uses). Plugin entries open
// their HTTPS page; the local .mcpb/.dxt installer stays the only thing that
// unpacks a file, so the "never fetch plugin bytes from the network" rule in
// plugins.js is unchanged.

// Every mcp entry that has a preset installs as that preset; the transport
// shown here is what the preset actually uses.
const CATALOG = [
  { id: 'context7', kind: 'mcp', name: 'Context7', preset: 'context7',
    blurb: 'Up-to-date library docs for whatever you are building.',
    mcp: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  { id: 'github', kind: 'mcp', name: 'GitHub', preset: 'github',
    blurb: 'Repos, issues, PRs and Actions. OAuth on first use.',
    mcp: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } },
  { id: 'playwright', kind: 'mcp', name: 'Playwright', preset: 'playwright',
    blurb: 'Drive a real browser: click, screenshot, test flows.',
    mcp: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] } },
  { id: 'memory', kind: 'mcp', name: 'Memory', preset: 'memory',
    blurb: 'A knowledge graph the model remembers between sessions.',
    mcp: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
  { id: 'notion', kind: 'mcp', name: 'Notion', preset: 'notion',
    blurb: 'Docs, databases and search. OAuth on first use.',
    mcp: { type: 'http', url: 'https://mcp.notion.com/mcp' } },
  { id: 'sentry', kind: 'mcp', name: 'Sentry', preset: 'sentry',
    blurb: 'Read errors and traces from your Sentry projects.',
    mcp: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } },
  { id: 'superpowers', kind: 'plugin', name: 'Superpowers',
    blurb: 'Brainstorm-first workflow, TDD and debugging skills for Claude Code.',
    url: 'https://github.com/obra/superpowers' },
  { id: 'anthropic-skills', kind: 'plugin', name: 'Anthropic Skills',
    blurb: 'The official skills collection: docs, spreadsheets, slides and more.',
    url: 'https://github.com/anthropics/skills' },
];

function list() {
  return CATALOG.map((e) => ({ ...e }));
}

async function install(id, deps = {}) {
  const entry = CATALOG.find((e) => e.id === String(id || ''));
  if (!entry) return { error: 'unknown marketplace entry: ' + (id || '(none)') };
  if (entry.kind === 'mcp') {
    if (typeof deps.addConnector !== 'function') return { error: 'no connector path available' };
    const cfg = { name: entry.name.toLowerCase().replace(/[^a-z0-9-]/g, ''), preset: entry.preset, ...entry.mcp };
    cfg.name = entry.id;                       // the catalog id is the connector name
    const r = await deps.addConnector(cfg);
    return { ok: !(r && r.ok === false), id: entry.id, result: r };
  }
  if (typeof deps.openExternal !== 'function') return { error: 'cannot open links' };
  await deps.openExternal(entry.url);
  return { opened: true, id: entry.id, url: entry.url };
}

module.exports = { list, install, CATALOG };
