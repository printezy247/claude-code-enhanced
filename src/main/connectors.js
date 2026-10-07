// Claude-Desktop-style connector manager: OAuth-capable remote MCP servers.
//
// Endpoints verified against official sources (Oct 2026):
//   GitHub   https://api.githubcopilot.com/mcp/   (docs.github.com; OAuth or PAT header)
//   Supabase https://mcp.supabase.com/mcp         (supabase.com remote-MCP announcement; OAuth)
//   Lovable  https://mcp.lovable.dev             (github.com/lovablelabs/mcp; OAuth)
//   Linear   https://mcp.linear.app/mcp          (mcp.linear.app; OAuth)
//   Notion   https://mcp.notion.com/mcp          (mcp.notion.com; OAuth)
//
// OAuth itself is performed by the claude CLI: after adding a server, run
// /mcp inside a session and pick "Authenticate". We surface that hint in the UI.
'use strict';
const { execFile } = require('child_process');

const PRESETS = [
  {
    id: 'github', name: 'GitHub', kind: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    blurb: 'Repos, issues, PRs, Actions. OAuth on first use — or paste a PAT below.',
    supportsHeader: true, headerHint: 'Authorization: Bearer ghp_xxxx',
  },
  {
    id: 'supabase', name: 'Supabase', kind: 'http',
    url: 'https://mcp.supabase.com/mcp',
    blurb: 'Projects, databases, edge functions. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'lovable', name: 'Lovable', kind: 'http',
    url: 'https://mcp.lovable.dev',
    blurb: 'Lovable Cloud: run SQL, change schema, deploy. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'linear', name: 'Linear', kind: 'http',
    url: 'https://mcp.linear.app/mcp',
    blurb: 'Issues, projects, cycles. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'notion', name: 'Notion', kind: 'http',
    url: 'https://mcp.notion.com/mcp',
    blurb: 'Docs, databases, search. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'playwright', name: 'Playwright (local)', kind: 'stdio',
    stdioCmd: ['npx', '-y', '@playwright/mcp@latest'],
    blurb: 'Drive a real browser from your agent. Runs locally via npx.',
    supportsHeader: false,
  },
  {
    id: 'context7', name: 'Context7 (local)', kind: 'stdio',
    stdioCmd: ['npx', '-y', '@upstash/context7-mcp'],
    blurb: 'Up-to-date library docs injected into context.',
    supportsHeader: false,
  },
  {
    id: 'slack', name: 'Slack', kind: 'http',
    url: 'https://slack.com/api/mcp',
    blurb: 'Read and post in channels, search messages. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'sentry', name: 'Sentry', kind: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    blurb: 'Issues, stacktraces, releases for your projects. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'stripe', name: 'Stripe', kind: 'http',
    url: 'https://mcp.stripe.com',
    blurb: 'Payments, customers, subscriptions, invoices. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'cloudflare', name: 'Cloudflare', kind: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
    blurb: 'Workers, DNS, R2, observability. OAuth on first use.',
    supportsHeader: false,
  },
  {
    id: 'memory', name: 'Memory (local)', kind: 'stdio',
    stdioCmd: ['npx', '-y', '@modelcontextprotocol/server-memory'],
    blurb: 'Persistent knowledge graph memory for the agent. Runs locally via npx.',
    supportsHeader: false,
  },
  {
    id: 'filesystem', name: 'Filesystem (local)', kind: 'stdio',
    stdioCmd: ['npx', '-y', '@modelcontextprotocol/server-filesystem', require('os').homedir()],
    blurb: 'Explicit file read/write tools scoped to your home folder. Runs locally.',
    supportsHeader: false,
  },
  {
    id: 'puppeteer', name: 'Puppeteer (local)', kind: 'stdio',
    stdioCmd: ['npx', '-y', '@modelcontextprotocol/server-puppeteer'],
    blurb: 'Headless Chrome screenshots and page automation. Runs locally.',
    supportsHeader: false,
  },
  {
    id: 'brave', name: 'Brave Search (local)', kind: 'stdio',
    stdioCmd: ['npx', '-y', '@modelcontextprotocol/server-brave-search'],
    blurb: 'Web search via Brave. Needs BRAVE_API_KEY exported in your shell profile.',
    supportsHeader: false,
  },
];

function run(claudePath, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(claudePath, args, {
      cwd: opts.cwd || process.env.HOME,
      timeout: opts.timeout || 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stdout || '') + (stderr ? '\n' + stderr : ''), error: err ? String(err.message) : null });
    });
  });
}

async function add(claudePath, { preset, scope = 'user', header = '' }) {
  const args = ['mcp', 'add', '--scope', scope];
  if (preset.kind === 'http') {
    args.push('--transport', 'http', preset.id, preset.url);
    if (header && preset.supportsHeader) args.push('--header', header);
  } else {
    args.push(preset.id, '--', ...preset.stdioCmd);
  }
  return run(claudePath, args, { timeout: 30_000 });
}

// User-defined connectors — e.g. a second GitHub account: same HTTP server URL,
// different server name + PAT header, so both accounts can be connected at once.
async function addCustom(claudePath, { name, url, header = '', scope = 'user' }) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new Error('Name must be letters, digits, - or _ (max 40)');
  if (!/^https:\/\//.test(url)) throw new Error('URL must start with https://');
  const args = ['mcp', 'add', '--scope', scope, '--transport', 'http', name, url];
  if (header) args.push('--header', header);
  return run(claudePath, args, { timeout: 30_000 });
}

async function remove(claudePath, { name }) {
  // Try global removal, then fall back through scopes.
  let res = await run(claudePath, ['mcp', 'remove', name], { timeout: 30_000 });
  if (res.ok) return res;
  for (const scope of ['user', 'local', 'project']) {
    res = await run(claudePath, ['mcp', 'remove', name, '--scope', scope], { timeout: 30_000 });
    if (res.ok) return res;
  }
  return res;
}

function list(claudePath) {
  return run(claudePath, ['mcp', 'list'], { timeout: 120_000 });
}

module.exports = { PRESETS, add, addCustom, remove, list };
