// The host-owned MCP broker.
//
// The model asks for "connector X, tool Y"; this module resolves X in the main
// process, adds the auth the user configured (or an OAuth token from the
// device flow), runs the call and masks every secret before the answer goes
// back. The model never sees a URL, a header or a token.
'use strict';
const { McpClient, McpAuthError, headersWithAuth } = require('./mcpclient');

/** The in-process tool the model calls. Named like a connector tool so the permission layer treats it as one. */
const HOST_SERVER = 'cce_host';
const HOST_CALL_TOOL = `mcp__${HOST_SERVER}__call_connector_tool`;
const HOST_LIST_TOOL = `mcp__${HOST_SERVER}__list_connector_tools`;
/** Tool results longer than this are cut: a connector must not flood the context. */
const MAX_RESULT_CHARS = 100_000;

/**
 * The permission-layer name for a host call. A call through the broker is judged
 * as the real connector tool (`mcp__github__delete_issue`), so the user's
 * per-tool policy and the destructive-tool prompt apply unchanged.
 */
function policyNameFor(toolName, input) {
  if (toolName !== HOST_CALL_TOOL) return toolName;
  const server = input && String(input.server || '');
  const tool = input && String(input.tool || '');
  return server && tool ? `mcp__${server}__${tool}` : toolName;
}

/** Every string that must never reach the model for a given connector config. */
function secretsOfConfig(cfg, token) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v.length > 3) out.add(v); };
  for (const [key, value] of Object.entries((cfg && cfg.headers) || {})) {
    add(String(value));
    // "Bearer abc" leaks as "abc" too.
    const bare = String(value).replace(/^\s*\w+\s+/, '');
    add(bare);
    void key;
  }
  if (cfg && cfg.url) {
    add(String(cfg.url));
    try { add(new URL(cfg.url).host); } catch { /* not a URL */ }
  }
  if (token && token.accessToken) add(String(token.accessToken));
  // Longest first, so a full header is blanked before its parts.
  return [...out].sort((a, b) => b.length - a.length);
}

function mask(text, secrets) {
  return secrets.reduce((s, secret) => s.split(secret).join('<hidden>'), String(text == null ? '' : text));
}

function maskResult(result, secrets) {
  const json = mask(JSON.stringify(result), secrets);
  let out;
  try { out = JSON.parse(json); } catch { out = { content: [{ type: 'text', text: json }], isError: true }; }
  if (Array.isArray(out.content)) {
    for (const part of out.content) {
      if (part && typeof part.text === 'string' && part.text.length > MAX_RESULT_CHARS) {
        part.text = part.text.slice(0, MAX_RESULT_CHARS) + '\n[output cut by the host]';
      }
    }
  }
  return out;
}

const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * @param {object} deps
 * @param {(name:string)=>Promise<object|null>} deps.resolveServer  connector config, from the user's own MCP config
 * @param {(name:string)=>object|undefined}     deps.getToken       live OAuth token, memory only
 * @param {(name:string)=>void}                 deps.clearToken
 * @param {(sessionId:string, server:string, tool:string)=>boolean} deps.isToolActive  per-session tool selection
 * @param {(opts:object)=>object}               [deps.clientFactory]
 * @param {()=>number}                          [deps.now]
 */
function createBroker(deps) {
  const {
    resolveServer, getToken = () => undefined, clearToken = () => {}, isToolActive = () => true,
    clientFactory = (opts) => new McpClient(opts), now = Date.now,
  } = deps;

  /** Resolve a connector and open a client, or return `{ error }`. */
  async function open(server, gate) {
    const name = String(server || '');
    const cfg = name ? await resolveServer(name) : null;
    if (!cfg) return { error: `No connector named "${name}".` };
    if (cfg.type !== 'http' && cfg.type !== 'sse') {
      return { error: `Connector "${name}" is not an HTTP or SSE server, so the host cannot call it.` };
    }
    const denied = gate && gate(name);
    if (denied) return { error: denied };
    let token = getToken(name);
    if (token && token.expiresAt != null && Number(token.expiresAt) <= now()) {
      clearToken(name);
      token = undefined;
    }
    const client = clientFactory({
      url: cfg.url,
      headers: headersWithAuth(cfg.headers || {}, token, now()),
      transport: cfg.type === 'sse' ? 'sse' : 'http',
    });
    return { name, client, secrets: secretsOfConfig(cfg, token) };
  }

  async function listTools(sessionId, server) {
    const opened = await open(server);
    if (opened.error) throw new Error(opened.error);
    const { client, name, secrets } = opened;
    try {
      await client.initialize();
      const tools = await client.listTools();
      return tools
        .filter((t) => isToolActive(sessionId, name, t.name))
        .map((t) => JSON.parse(mask(JSON.stringify(t), secrets)));
    } catch (err) {
      throw new Error(mask((err && err.message) || err, secrets));
    } finally {
      await client.close();
    }
  }

  async function callTool(sessionId, server, tool, args) {
    const toolName = String(tool || '');
    if (!toolName) return fail('A tool name is required.');
    const opened = await open(server, (n) => (isToolActive(sessionId, n, toolName)
      ? '' : `Tool "${toolName}" is not enabled for connector "${n}" in this chat.`));
    if (opened.error) return fail(opened.error);
    const { client, name, secrets } = opened;
    try {
      await client.initialize();
      return maskResult(await client.callTool(toolName, args || {}), secrets);
    } catch (err) {
      if (err instanceof McpAuthError || (err && err.name === 'McpAuthError')) {
        clearToken(name);
        return fail(`Connector "${name}" needs you to sign in again. Authenticate it in the Connectors panel.`);
      }
      return fail(mask((err && err.message) || err, secrets));
    } finally {
      await client.close();
    }
  }

  return { listTools, callTool };
}

module.exports = {
  createBroker, policyNameFor, HOST_SERVER, HOST_CALL_TOOL, HOST_LIST_TOOL, MAX_RESULT_CHARS,
};
