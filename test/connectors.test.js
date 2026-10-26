// connectors: parsing `claude mcp list`, header normalising, and keeping a PAT out
// of anything that leaves the main process.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const connectors = require('../src/main/connectors.js');

/** A fake `claude` executable running the given sh body. */
function fakeClaude(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-claude-'));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  return file;
}

const LIST = [
  'Checking MCP server health…',
  '',
  'github: https://api.githubcopilot.com/mcp/ (HTTP) - ✔ Connected',
  'github-work: https://api.githubcopilot.com/mcp/ (HTTP) - ! Needs authentication',
  'brave: npx -y @modelcontextprotocol/server-brave-search - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed',
  'plugin:ecc:chrome-devtools: npx -y chrome-devtools-mcp@1.10.1 - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed',
  'plugin:engineering:google calendar:  (HTTP) - - Not configured',
  'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
].join('\n');

describe('parseMcpList', () => {
  const servers = connectors.parseMcpList(LIST);
  const by = (n) => servers.find(s => s.name === n);

  it('reads one entry per server and skips the header lines', () => {
    expect(servers.map(s => s.name)).toEqual([
      'github', 'github-work', 'brave', 'plugin:ecc:chrome-devtools',
      'plugin:engineering:google calendar', 'claude.ai Claude Docs',
    ]);
  });

  it('maps the status text to a state', () => {
    expect(by('github').state).toBe('connected');
    expect(by('github-work').state).toBe('auth');
    expect(by('brave').state).toBe('failed');
    expect(by('plugin:engineering:google calendar').state).toBe('off');
  });

  it('keeps the failure reason and the target', () => {
    expect(by('brave').detail).toBe('Failed to connect — CONNECTION_CLOSED: Connection closed');
    expect(by('github').target).toBe('https://api.githubcopilot.com/mcp/ (HTTP)');
  });

  it('separates your own servers from plugin and claude.ai ones', () => {
    expect(by('github').kind).toBe('own');
    expect(by('brave').kind).toBe('own');
    expect(by('plugin:ecc:chrome-devtools').kind).toBe('managed');
    expect(by('claude.ai Claude Docs').kind).toBe('managed');
  });

  it('copes with empty output', () => {
    expect(connectors.parseMcpList('')).toEqual([]);
    expect(connectors.parseMcpList(undefined)).toEqual([]);
  });
});

describe('normalizeHeader', () => {
  it('wraps a bare token as a bearer header', () => {
    expect(connectors.normalizeHeader('ghp_abc123')).toBe('Authorization: Bearer ghp_abc123');
    expect(connectors.normalizeHeader('Bearer ghp_abc123')).toBe('Authorization: Bearer ghp_abc123');
  });
  it('keeps a full header line as typed', () => {
    expect(connectors.normalizeHeader('Authorization: Bearer ghp_abc123')).toBe('Authorization: Bearer ghp_abc123');
    expect(connectors.normalizeHeader('X-Api-Key: k_999')).toBe('X-Api-Key: k_999');
  });
  it('returns nothing for blank input', () => {
    expect(connectors.normalizeHeader('   ')).toBe('');
    expect(connectors.normalizeHeader(undefined)).toBe('');
  });
});

describe('adding connectors', () => {
  const TOKEN = 'ghp_SuperSecretToken123456';
  const github = connectors.PRESETS.find(p => p.id === 'github');

  it('never lets a token escape in a failure message', async () => {
    const claude = fakeClaude('echo "boom" >&2\nexit 1');
    const res = await connectors.addCustom(claude, { name: 'github-work', url: github.url, header: TOKEN });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('SuperSecretToken');
  });

  it('hides a token passed to a preset too', async () => {
    const claude = fakeClaude('echo "boom" >&2\nexit 1');
    const res = await connectors.add(claude, { preset: github, header: 'Authorization: Bearer ' + TOKEN });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('SuperSecretToken');
  });

  it('sends the normalised header to the CLI', async () => {
    const out = path.join(os.tmpdir(), 'cce-args-' + process.pid);
    const claude = fakeClaude(`printf '%s\\n' "$@" > '${out}'`);
    await connectors.addCustom(claude, { name: 'github-work', url: github.url, header: TOKEN });
    const args = fs.readFileSync(out, 'utf8').split('\n');
    expect(args).toContain('Authorization: Bearer ' + TOKEN);
    expect(args).toContain('github-work');
    fs.rmSync(out, { force: true });
  });

  it('turns "already exists" into a plain instruction', async () => {
    const claude = fakeClaude('echo "MCP server github already exists in user config" >&2\nexit 1');
    const res = await connectors.add(claude, { preset: github });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('github is already added. Remove it first (Remove button) to change its URL or token.');
  });

  it('rejects a bad name or a non-https URL before running anything', async () => {
    await expect(connectors.addCustom('/nonexistent', { name: 'bad name', url: github.url })).rejects.toThrow(/Name must be/);
    await expect(connectors.addCustom('/nonexistent', { name: 'ok', url: 'http://x' })).rejects.toThrow(/https/);
  });

  it('accepts plain http for a localhost MCP server (a normal dev setup)', async () => {
    const out = path.join(os.tmpdir(), 'cce-local-args-' + process.pid);
    const claude = fakeClaude(`printf '%s\\n' \"$@\" > '${out}'`);
    await connectors.addCustom(claude, { name: 'localbox', url: 'http://127.0.0.1:8080/mcp' });
    const args = fs.readFileSync(out, 'utf8').split('\n');
    expect(args).toContain('http://127.0.0.1:8080/mcp');
    fs.rmSync(out, { force: true });
  });
});

describe('slow-but-connected servers', () => {
  const SLOW = 'github: https://api.githubcopilot.com/mcp/ (HTTP) - ✔ Connected · tools fetch failed — Request timed out';

  it('is "degraded", not "failed", when the server answered but its tool list timed out', () => {
    const [s] = connectors.parseMcpList(SLOW);
    expect(s.state).toBe('degraded');
    expect(s.detail).toMatch(/tools fetch failed/);
  });

  it('still calls a real connection failure "failed"', () => {
    const [s] = connectors.parseMcpList('brave: npx -y x - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed');
    expect(s.state).toBe('failed');
  });

  it('parseMcpGet reads one server\'s own verdict', () => {
    expect(connectors.parseMcpGet('github:\n  Scope: User\n  Status: ✔ Connected\n  Type: http')).toEqual({ state: 'connected', detail: 'Connected' });
    expect(connectors.parseMcpGet('brave:\n  Status: ✘ Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed'))
      .toEqual({ state: 'failed', detail: 'CONNECTION_CLOSED: Connection closed' });
    expect(connectors.parseMcpGet('x:\n  Status: ! Needs authentication').state).toBe('auth');
    expect(connectors.parseMcpGet('nothing useful')).toBeNull();
  });

  it('status() trusts the one-server check over the crowded sweep', async () => {
    // `mcp list` says the tool fetch timed out; `mcp get github` says connected.
    const claude = fakeClaude(`if [ "$2" = list ]; then echo '${SLOW}'; else echo 'github:'; echo '  Status: ✔ Connected'; fi`);
    const res = await connectors.status(claude);
    expect(res.servers.find(s => s.name === 'github')).toMatchObject({ state: 'connected', detail: 'Connected' });
  });

  it('status() keeps a server failed when the one-server check fails too', async () => {
    const claude = fakeClaude(`if [ "$2" = list ]; then echo 'brave: npx -y x - ✘ Failed to connect — CONNECTION_CLOSED'; else echo 'brave:'; echo '  Status: ✘ Failed to connect'; echo '  Issue: CONNECTION_CLOSED: Connection closed'; fi`);
    const res = await connectors.status(claude);
    expect(res.servers[0]).toMatchObject({ state: 'failed', detail: 'CONNECTION_CLOSED: Connection closed' });
  });

  it('status() leaves a slow server yellow when the re-check cannot say', async () => {
    const claude = fakeClaude(`if [ "$2" = list ]; then echo '${SLOW}'; else echo 'garbled'; fi`);
    const res = await connectors.status(claude);
    expect(res.servers[0].state).toBe('degraded');
  });

  it('status() does not re-check plugin servers', async () => {
    const out = path.join(os.tmpdir(), 'cce-gets-' + process.pid);
    const claude = fakeClaude(`if [ "$2" = list ]; then echo 'plugin:a:b: https://x (HTTP) - ✘ Failed to connect — nope'; else echo "$3" >> '${out}'; fi`);
    await connectors.status(claude);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('per-connector tool picker', () => {
  const servers = [
    { name: 'github', tools: [{ name: 'create_issue' }, { name: 'list_repos' }] },
    { name: 'linear', tools: ['create_issue', 'list_teams'] },
  ];

  it('lists a connector’s tools', () => {
    expect(connectors.connectorTools(servers, 'github')).toEqual([{ name: 'create_issue' }, { name: 'list_repos' }]);
    expect(connectors.connectorTools(servers, 'linear')).toEqual(['create_issue', 'list_teams']);
    expect(connectors.connectorTools(servers, 'nope')).toEqual([]);
  });

  it('persists the active selection per session', () => {
    connectors.clearConnectorToolSelection('s1');
    connectors.setActiveConnectorTools('s1', 'github', ['create_issue']);
    expect(connectors.getActiveConnectorTools('s1', 'github')).toEqual(['create_issue']);
    expect(connectors.isConnectorToolActive('s1', 'github', 'create_issue')).toBe(true);
    expect(connectors.isConnectorToolActive('s1', 'github', 'list_repos')).toBe(false);
  });

  it('treats “no selection” as “all tools active”', () => {
    connectors.clearConnectorToolSelection('s2');
    expect(connectors.getActiveConnectorTools('s2', 'github')).toBeNull();
    expect(connectors.isConnectorToolActive('s2', 'github', 'list_repos')).toBe(true);
  });

  it('filters a tool list down to the active ones', () => {
    connectors.clearConnectorToolSelection('s3');
    connectors.setActiveConnectorTools('s3', 'github', ['create_issue']);
    const out = connectors.activeConnectorToolList('s3', 'github', servers[0].tools);
    expect(out).toEqual([{ name: 'create_issue' }]);
  });

  it('keeps sessions independent', () => {
    connectors.clearConnectorToolSelection('a');
    connectors.clearConnectorToolSelection('b');
    connectors.setActiveConnectorTools('a', 'github', ['create_issue']);
    connectors.setActiveConnectorTools('b', 'github', ['list_repos']);
    expect(connectors.getActiveConnectorTools('a', 'github')).toEqual(['create_issue']);
    expect(connectors.getActiveConnectorTools('b', 'github')).toEqual(['list_repos']);
  });

  it('clears a selection', () => {
    connectors.clearConnectorToolSelection('s4');
    connectors.setActiveConnectorTools('s4', 'github', ['create_issue']);
    connectors.clearConnectorToolSelection('s4', 'github');
    expect(connectors.getActiveConnectorTools('s4', 'github')).toBeNull();
  });
});

describe('MCP reconnect backoff', () => {
  it('backs off exponentially up to the cap', () => {
    const b = new connectors.McpReconnectBackoff({ base: 100, cap: 1000, maxAttempts: 10 });
    expect(b.fail('x').delay).toBe(100);
    expect(b.fail('x').delay).toBe(200);
    expect(b.fail('x').delay).toBe(400);
    expect(b.fail('x').delay).toBe(800);
    expect(b.fail('x').delay).toBe(1000); // capped
    expect(b.fail('x').delay).toBe(1000);
  });

  it('reports attempt count, next retry time and state', () => {
    const b = new connectors.McpReconnectBackoff({ base: 50, cap: 5000, maxAttempts: 3 });
    const r = b.fail('y');
    expect(r.attempts).toBe(1);
    expect(r.nextRetryAt).toBeGreaterThan(Date.now() - 5);
    expect(r.state).toBe('reconnecting');
    b.fail('y'); b.fail('y');
    expect(b.status('y').state).toBe('failed');
    expect(b.status('y').attempts).toBe(3);
  });

  it('a successful reconnect resets the counter', () => {
    const b = new connectors.McpReconnectBackoff({ base: 50, cap: 5000, maxAttempts: 5 });
    b.fail('z'); b.fail('z');
    expect(b.status('z').attempts).toBe(2);
    b.success('z');
    expect(b.status('z').attempts).toBe(0);
    expect(b.status('z').state).toBe('connected');
    expect(b.status('z').nextRetryAt).toBeNull();
  });

  it('backs off independently per connector', () => {
    const b = new connectors.McpReconnectBackoff({ base: 100, cap: 10000, maxAttempts: 10 });
    b.fail('a'); b.fail('a'); b.fail('a');
    b.fail('b');
    expect(b.status('a').attempts).toBe(3);
    expect(b.status('b').attempts).toBe(1);
  });

  it('exposes the module-level helpers', () => {
    connectors.recordReconnectSuccess('mod');
    const r = connectors.recordReconnectFailure('mod');
    expect(r.attempts).toBe(1);
    expect(connectors.reconnectStatus('mod').attempts).toBe(1);
    connectors.recordReconnectSuccess('mod');
    expect(connectors.reconnectStatus('mod').attempts).toBe(0);
  });

  it('reconnectDelay helper matches the formula', () => {
    expect(connectors.reconnectDelay(1)).toBe(1000);
    expect(connectors.reconnectDelay(2)).toBe(2000);
    expect(connectors.reconnectDelay(10)).toBe(30000);
  });
});

describe('status', () => {
  it('returns parsed servers from the CLI output', async () => {
    const claude = fakeClaude(`cat <<'EOF'\n${LIST}\nEOF`);
    const res = await connectors.status(claude);
    expect(res.ok).toBe(true);
    expect(res.servers.find(s => s.name === 'github').state).toBe('connected');
  });

  it('reports an error when the CLI fails and prints nothing', async () => {
    const claude = fakeClaude('echo "nope" >&2\nexit 2');
    const res = await connectors.status(claude);
    expect(res.ok).toBe(false);
    expect(res.servers).toEqual([]);
  });
});

// The B8 review's five findings. Each one was a real defect: a tool that
// arrives as an object never matched, an empty connector name was read as
// "clear everything", asking for a status invented a connector record, the
// alias methods were dead weight, and the module-level backoff could not be
// reset.
describe('connector tool picker — the review findings', () => {
  it('matches a tool that arrives as an object', () => {
    connectors.clearConnectorToolSelection('o1');
    connectors.setActiveConnectorTools('o1', 'github', ['create_issue']);
    // The engine hands tools over as { name, ... } objects, not bare strings.
    expect(connectors.isConnectorToolActive('o1', 'github', { name: 'create_issue' })).toBe(true);
    expect(connectors.isConnectorToolActive('o1', 'github', { name: 'list_repos' })).toBe(false);
  });

  it('clears only the named connector, and keeps the others', () => {
    connectors.clearConnectorToolSelection('o2');
    connectors.setActiveConnectorTools('o2', 'github', ['create_issue']);
    connectors.setActiveConnectorTools('o2', 'linear', ['list_teams']);
    connectors.clearConnectorToolSelection('o2', 'github');
    expect(connectors.getActiveConnectorTools('o2', 'github')).toBeNull();
    expect(connectors.getActiveConnectorTools('o2', 'linear')).toEqual(['list_teams']);
  });

  it('clears the whole session when no connector is named', () => {
    connectors.clearConnectorToolSelection('o3');
    connectors.setActiveConnectorTools('o3', 'github', ['create_issue']);
    connectors.clearConnectorToolSelection('o3');
    expect(connectors.getActiveConnectorTools('o3', 'github')).toBeNull();
  });

  it('does not invent a connector record when asked for a status', () => {
    const b = new connectors.McpReconnectBackoff();
    const before = b.all().length;
    b.status('never-touched');
    expect(b.all().length).toBe(before);
  });

  it('clears every connector backoff state at once', () => {
    connectors.recordReconnectFailure('m1');
    connectors.recordReconnectFailure('m2');
    expect(connectors.reconnectStatus('m1').attempts).toBe(1);
    connectors.clearReconnectBackoff();
    expect(connectors.reconnectStatus('m1').attempts).toBe(0);
    expect(connectors.reconnectStatus('m2').attempts).toBe(0);
  });
});
