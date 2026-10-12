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
