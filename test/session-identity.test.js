// The proxy must forward the engine's session identity upstream.
//
// OpenCode Go answers "400 Request is missing x-opencode-session and cannot
// be routed efficiently" when a request carries no session id. The claude
// engine DOES send one (x-claude-code-session-id) but the translated
// (Anthropic->OpenAI) path rebuilt the header set from scratch and dropped
// it, so every turn against a Go provider failed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { upHeaders } = require('../src/main/adapters.js');

describe('upstream session identity', () => {
  const prov = { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k', keyHeader: 'bearer' };

  it('forwards the session id under both the engine name and the gateway name', () => {
    const h = upHeaders({ ...prov, sessionHeaders: {
      'x-claude-code-session-id': 'sess-123',
      'x-opencode-session': 'sess-123',
    } });
    expect(h['x-claude-code-session-id']).toBe('sess-123');
    expect(h['x-opencode-session']).toBe('sess-123');
  });

  it('sends no session header when the engine sent none', () => {
    const h = upHeaders({ ...prov });
    expect(h['x-opencode-session']).toBeUndefined();
    expect(h['x-claude-code-session-id']).toBeUndefined();
  });

  it('keeps the auth header alongside the session header', () => {
    const h = upHeaders({ ...prov, sessionHeaders: { 'x-opencode-session': 's' } });
    expect(h.Authorization).toBe('Bearer k');
    expect(h['content-type']).toBe('application/json');
  });

  it('lets a user-configured header win over the forwarded one', () => {
    const h = upHeaders({
      ...prov,
      headers: { 'x-opencode-session': 'explicit' },
      sessionHeaders: { 'x-opencode-session': 'forwarded' },
    });
    expect(h['x-opencode-session']).toBe('explicit');
  });
});
