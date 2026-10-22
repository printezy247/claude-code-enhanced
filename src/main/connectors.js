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

// Accept a full "Header: value" line or a bare token (ghp_…, github_pat_…, or any
// opaque key) and return the "Header: value" form `claude mcp add --header` wants.
function normalizeHeader(raw) {
  const h = String(raw || '').trim();
  if (!h) return '';
  if (/^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(h)) return h;
  return 'Authorization: Bearer ' + h.replace(/^Bearer\s+/i, '');
}

// `claude mcp add` failures echo the whole command line, which would put a PAT in
// the toast and in logs. Blank every secret before the result leaves this module.
function redact(res, secrets) {
  const bits = (secrets || []).filter(s => s && s.length > 3);
  const scrub = (t) => bits.reduce((s, secret) => s.split(secret).join('<hidden>'), String(t || ''));
  const out = { ...res, output: scrub(res.output), error: res.error ? scrub(res.error) : res.error };
  const m = /MCP server (\S+) already exists/.exec(out.output + ' ' + (out.error || ''));
  if (m) out.error = `${m[1]} is already added. Remove it first (Remove button) to change its URL or token.`;
  return out;
}

// Every form the CLI might echo back: the whole header line, the bare value, and
// the value without its "Bearer " prefix.
function secretsOf(header) {
  const value = String(header || '').replace(/^[^:]+:\s*Bearer\s+/i, '').replace(/^[^:]+:\s*/, '');
  return value ? [String(header), value] : [];
}

async function add(claudePath, { preset, scope = 'user', header = '' }) {
  const hdr = preset.supportsHeader ? normalizeHeader(header) : '';
  const args = ['mcp', 'add', '--scope', scope];
  if (preset.kind === 'http') {
    args.push('--transport', 'http', preset.id, preset.url);
    if (hdr) args.push('--header', hdr);
  } else {
    args.push(preset.id, '--', ...preset.stdioCmd);
  }
  return redact(await run(claudePath, args, { timeout: 30_000 }), secretsOf(hdr));
}

// User-defined connectors — e.g. a second GitHub account: same HTTP server URL,
// different server name + PAT header, so both accounts can be connected at once.
async function addCustom(claudePath, { name, url, header = '', scope = 'user' }) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new Error('Name must be letters, digits, - or _ (max 40)');
  if (!/^https:\/\//.test(url)) throw new Error('URL must start with https://');
  const hdr = normalizeHeader(header);
  const args = ['mcp', 'add', '--scope', scope, '--transport', 'http', name, url];
  if (hdr) args.push('--header', hdr);
  return redact(await run(claudePath, args, { timeout: 30_000 }), secretsOf(hdr));
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

/**
 * `claude mcp get <name>` prints the server definition, not just its health:
 *
 *   github:
 *     Scope: User config (available in all your projects)
 *     Status: ✔ Connected
 *     Type: http
 *     URL: https://api.githubcopilot.com/mcp/
 *     Headers:
 *       Authorization: Bearer ghp_…
 *
 *   context7:
 *     Type: stdio
 *     Command: npx
 *     Args: -y @upstash/context7-mcp
 *
 * The desktop version hands these definitions to the engine directly, so the
 * connector's tools are callable in the session. Parse them into the SDK's
 * McpServerConfig shape so CCE can do the same.
 */
function parseMcpDefinition(output) {
  const text = String(output || '');
  if (!/^\s*Type:\s*(http|sse|stdio)\s*$/m.test(text)) return null;
  const type = (/^\s*Type:\s*(\w+)\s*$/m.exec(text) || [])[1];
  const url = (/^\s*URL:\s*(\S+)\s*$/m.exec(text) || [])[1];
  const command = (/^\s*Command:\s*(.+?)\s*$/m.exec(text) || [])[1];
  const argsLine = (/^\s*Args:\s*(.*?)\s*$/m.exec(text) || [])[1];
  const headers = {};
  const inHeaders = /^\s*Headers:\s*$/m.test(text);
  if (inHeaders) {
    const after = text.slice(text.search(/^\s*Headers:\s*$/m));
    for (const line of after.split('\n').slice(1)) {
      if (!/^\s{4,}\S/.test(line)) break;      // a new section starts
      const m = /^\s*(.+?):\s*(.*)$/.exec(line);
      if (m && m[2]) headers[m[1].trim()] = m[2].trim();
    }
  }
  if (type === 'stdio') {
    if (!command) return null;
    const args = argsLine ? argsLine.split(/\s+/).filter(Boolean) : [];
    return { type: 'stdio', command, args };
  }
  if (!url) return null;
  const cfg = { type: type === 'sse' ? 'sse' : 'http', url };
  if (Object.keys(headers).length) cfg.headers = headers;
  return cfg;
}

/**
 * The definition of one configured server, in the SDK's McpServerConfig shape.
 * @returns {Promise<{name: string, config: object}|null>}
 */
async function definition(claudePath, name) {
  const res = await run(claudePath, ['mcp', 'get', name], { timeout: 60_000 });
  const config = parseMcpDefinition(res.output);
  return config ? { name: String(name), config } : null;
}

/** Every configured server that can be handed to the engine as a definition. */
async function definitions(claudePath) {
  const res = await list(claudePath);
  const out = [];
  for (const s of parseMcpList(res.output)) {
    if (s.kind !== 'own') continue;              // plugin/claude.ai servers are managed elsewhere
    const def = await definition(claudePath, s.name);
    if (def) out.push(def);
  }
  return out;
}

// `claude mcp list` prints one health-checked line per server:
//   name: https://host/mcp (HTTP) - ✔ Connected
//   name: npx -y pkg - ✘ Failed to connect — CONNECTION_CLOSED: …
//   name: https://host/mcp (HTTP) - ! Needs authentication
// Names may contain colons (plugin:ecc:x) but never ": ", so the first ": " ends the name.
function parseMcpList(output) {
  const servers = [];
  for (const line of String(output || '').split('\n')) {
    const m = /^(\S.*?):\s+(.*)\s-\s+(\S.*)$/.exec(line.trim());
    if (!m) continue;
    const [, name, target, status] = m;
    let state = 'unknown';
    if (/not configured/i.test(status)) state = 'off';
    else if (/needs? auth|authenticat/i.test(status)) state = 'auth';
    // "Connected · tools fetch failed — Request timed out": the server answered, only the
    // tool list was slow (typical when the sweep checks many servers at once).
    else if (/\bconnected\b/i.test(status) && /fail|time[d ]?out/i.test(status)) state = 'degraded';
    else if (/✘|fail|error|refus|denied/i.test(status)) state = 'failed';
    else if (/✔|connected/i.test(status)) state = 'connected';
    const kind = /^plugin:|^claude\.ai /.test(name) ? 'managed' : 'own';
    servers.push({ name, target: target.trim(), state, detail: status.replace(/^[✔✘!⚠\s]+/, '').trim(), kind });
  }
  return servers;
}

// `claude mcp get <name>` checks one server on its own:
//   Status: ✔ Connected          |  Status: ✘ Failed to connect   Issue: <why>
//   Status: ! Needs authentication
function parseMcpGet(output) {
  const st = /^\s*Status:\s*(.+)$/m.exec(String(output || ''));
  if (!st) return null;
  const text = st[1].trim();
  const issue = /^\s*Issue:\s*(.+)$/m.exec(output);
  const detail = (issue ? issue[1] : text).replace(/^[✔✘!⚠\s]+/, '').trim();
  if (/needs? auth|authenticat/i.test(text)) return { state: 'auth', detail };
  if (/✘|fail|error|refus|denied/i.test(text)) return { state: 'failed', detail };
  if (/✔|connected/i.test(text)) return { state: 'connected', detail: 'Connected' };
  return null;
}

// The all-servers sweep checks everything at once, so a slow server can time out there
// while being fine on its own. Re-check each non-clean server of yours individually and
// believe that answer; a server that is still only "degraded" stays yellow, not red.
async function status(claudePath) {
  const res = await list(claudePath);
  const servers = parseMcpList(res.output);
  // A timed-out/killed `mcp list` can still have printed lines; only error when we got nothing.
  if (!servers.length && !res.ok) return { ok: false, error: res.error || 'claude mcp list failed', servers: [], output: res.output };
  const shaky = servers.filter(s => s.kind === 'own' && (s.state === 'failed' || s.state === 'degraded'));
  await Promise.all(shaky.map(async (s) => {
    const one = parseMcpGet((await run(claudePath, ['mcp', 'get', s.name], { timeout: 60_000 })).output);
    if (!one) return;
    if (s.state === 'degraded' && one.state === 'failed') return; // keep the sweep's softer verdict
    s.state = one.state; s.detail = one.detail;
  }));
  return { ok: true, servers, output: res.output };
}

// ---------- Per-connector tool picker: active tool selection per session --------
// For each connector (MCP server) a session may choose which of its tools are
// active. No selection means "all tools active" (the safe default). The selection
// is keyed by session id so two sessions can differ.
const connectorToolSelections = new Map(); // sessionId -> { connectorName: string[] }

function connectorTools(servers, name) {
  const s = (servers || []).find(x => x && String(x.name) === String(name));
  return s && Array.isArray(s.tools) ? s.tools.slice() : [];
}

function setActiveConnectorTools(sessionId, connector, tools) {
  if (!sessionId) throw new Error('sessionId required');
  const sid = String(sessionId);
  if (!connectorToolSelections.has(sid)) connectorToolSelections.set(sid, {});
  const sel = connectorToolSelections.get(sid);
  sel[String(connector)] = Array.isArray(tools) ? tools.map(String) : [];
  return sel[String(connector)].slice();
}

function getActiveConnectorTools(sessionId, connector) {
  const sid = String(sessionId);
  const sel = connectorToolSelections.get(sid);
  if (!sel || !Object.prototype.hasOwnProperty.call(sel, String(connector))) return null;
  return sel[String(connector)].slice();
}

function isConnectorToolActive(sessionId, connector, tool) {
  const active = getActiveConnectorTools(sessionId, connector);
  if (active === null) return true; // no selection => all tools active
  // A tool may arrive as an object ({ name: 'create_issue' }) or as a bare
  // name. Comparing the object itself would never match the stored name, so
  // every tool of the connector looked inactive.
  const name = (tool && typeof tool === 'object') ? tool.name : tool;
  return active.includes(String(name));
}

function clearConnectorToolSelection(sessionId, connector) {
  const sid = String(sessionId);
  const sel = connectorToolSelections.get(sid);
  if (!sel) return;
  // "no connector" clears the whole session; an empty-string connector is a
  // connector whose name happens to be empty and must be cleared on its own.
  if (connector === undefined || connector === null) connectorToolSelections.delete(sid);
  else delete sel[String(connector)];
}

// Return the subset of a connector's tools that are active for the session.
// With no stored selection every tool stays active (the safe default).
function activeConnectorToolList(sessionId, connector, available) {
  const tools = Array.isArray(available) ? available.slice() : [];
  const active = getActiveConnectorTools(sessionId, connector);
  if (active === null) return tools;
  return tools.filter((t) => {
    const name = (t && typeof t === 'object') ? t.name : t;
    return active.includes(String(name));
  });
}

// ---------- MCP reconnect backoff (per connector) -----------------------------
// One broken connector must not delay another's reconnect: every connector keeps
// its own attempt counter, delay and next-retry time.
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 8;

function reconnectDelay(attempt) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const raw = RECONNECT_BASE_DELAY_MS * Math.pow(2, n - 1);
  return Math.min(RECONNECT_MAX_DELAY_MS, raw);
}

class McpReconnectBackoff {
  constructor(opts = {}) {
    this.base = Number(opts.base) > 0 ? Number(opts.base) : RECONNECT_BASE_DELAY_MS;
    this.cap = Number(opts.cap) > 0 ? Number(opts.cap) : RECONNECT_MAX_DELAY_MS;
    this.maxAttempts = Number(opts.maxAttempts) > 0 ? Number(opts.maxAttempts) : RECONNECT_MAX_ATTEMPTS;
    this.entries = new Map(); // name -> { attempts, nextRetryAt, state }
  }
  _entry(name) {
    const key = String(name);
    if (!this.entries.has(key)) this.entries.set(key, { attempts: 0, nextRetryAt: null, state: 'connected' });
    return this.entries.get(key);
  }
  // A READ must not create an entry: asking a connector's status would
  // otherwise leave a "connected" record for a connector nobody touched.
  _peek(name) {
    return this.entries.get(String(name)) || { attempts: 0, nextRetryAt: null, state: 'connected' };
  }
  fail(name) {
    const e = this._entry(name);
    e.attempts += 1;
    const delay = Math.min(this.cap, this.base * Math.pow(2, e.attempts - 1));
    e.nextRetryAt = Date.now() + delay;
    e.state = e.attempts >= this.maxAttempts ? 'failed' : 'reconnecting';
    return { name: String(name), attempts: e.attempts, delay, nextRetryAt: e.nextRetryAt, state: e.state };
  }
  success(name) {
    const e = this._entry(name);
    e.attempts = 0;
    e.nextRetryAt = null;
    e.state = 'connected';
    return { name: String(name), attempts: 0, delay: 0, nextRetryAt: null, state: 'connected' };
  }
  status(name) {
    const e = this._peek(name);
    return { name: String(name), attempts: e.attempts, nextRetryAt: e.nextRetryAt, state: e.state };
  }
  all() { return [...this.entries.keys()].map(n => this.status(n)); }
  clear(name) { this.entries.delete(String(name)); }
  /** Forget every connector's backoff state (app restart, manual reset). */
  clearAll() { this.entries.clear(); }
}

const reconnectBackoff = new McpReconnectBackoff();
function recordReconnectFailure(name) { return reconnectBackoff.fail(name); }
function recordReconnectSuccess(name) { return reconnectBackoff.success(name); }
function reconnectStatus(name) { return reconnectBackoff.status(name); }
/** Clear the module-level backoff state for every connector. */
function clearReconnectBackoff() { reconnectBackoff.clearAll(); }

module.exports = {
  PRESETS, add, addCustom, remove, list, status, parseMcpList, parseMcpGet, normalizeHeader,
  parseMcpDefinition, definition, definitions,
  // C3 tool picker
  connectorTools, setActiveConnectorTools, getActiveConnectorTools, isConnectorToolActive,
  clearConnectorToolSelection, connectorToolSelections, activeConnectorToolList,
  // C6 reconnect backoff
  McpReconnectBackoff, reconnectBackoff, reconnectDelay, recordReconnectFailure,
  recordReconnectSuccess, reconnectStatus, clearReconnectBackoff,
  RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_MAX_ATTEMPTS,
};
