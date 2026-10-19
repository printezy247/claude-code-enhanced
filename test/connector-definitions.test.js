// Connector definitions: `claude mcp get` output is parsed into the SDK's
// McpServerConfig shape so a connector's tools can be attached to a live
// session (tool calling access, like the desktop app).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const connectors = require('../src/main/connectors.js');

describe('MCP server definitions', () => {
  it('parses an HTTP server with its URL and headers', () => {
    const out = [
      'github:',
      '  Scope: User config (available in all your projects)',
      '  Status: ✔ Connected',
      '  Type: http',
      '  URL: https://api.githubcopilot.com/mcp/',
      '  Headers:',
      '    Authorization: Bearer ghp_secret',
      '',
      'To remove this server, run: claude mcp remove github -s user',
    ].join('\n');
    expect(connectors.parseMcpDefinition(out)).toEqual({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ghp_secret' },
    });
  });

  it('parses a stdio server with its command and args', () => {
    const out = [
      'context7:',
      '  Scope: User config (available in all your projects)',
      '  Status: ✔ Connected',
      '  Type: stdio',
      '  Command: npx',
      '  Args: -y @upstash/context7-mcp',
      '  Environment:',
    ].join('\n');
    expect(connectors.parseMcpDefinition(out)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    });
  });

  it('returns null when the output has no server type', () => {
    expect(connectors.parseMcpDefinition('No MCP server named "x".')).toBeNull();
    expect(connectors.parseMcpDefinition('')).toBeNull();
  });
});
