// A minimal MCP client for the host process.
//
// CCE shells out to the `claude` CLI for everything MCP: the CLI owns the
// connection, the OAuth handshake and every tool call. That is fine until the
// host itself has to act as a client — run a tool on the user's behalf,
// answer a 401 with a device-code sign-in, or hold a session open. The Claude
// Desktop app does exactly that (`.vite/build/mcp-runtime/directMcpHost.js`).
//
// This module is the smallest thing that can do it: JSON-RPC 2.0 over
// Streamable HTTP or the legacy HTTP+SSE transport, with nothing but Node's
// global fetch and the shared SSE line reader (src/main/sse.js). stdio servers
// stay with the CLI — they are a child process, not a URL.
//
// Wire assumptions (MCP 2025-06-18, with the 2024-11-05 legacy transport):
//   - a request is one JSON-RPC 2.0 object POSTed to the server url;
//   - the answer comes back as `application/json` or as an SSE stream whose
//     first JSON-RPC response is the answer;
//   - `initialize` is answered with `{ serverInfo, capabilities }`, and the
//     client follows it with the `notifications/initialized` notification
//     (no id, no answer expected);
//   - a tool that failed is a *result* with `isError: true`, not a JSON-RPC
//     error — only protocol failures throw.
'use strict';
const { sseLines } = require('./sse');

/** The MCP revision this client speaks. */
const PROTOCOL_VERSION = '2025-06-18';
/** Every POST and every GET asks for both answer shapes. */
const ACCEPT = 'application/json, text/event-stream';
/** RFC 8628 device-code grant type. */
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** RFC 8414 / OpenID discovery documents, in the order they are tried. */
const DISCOVERY_PATHS = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'];

/** The host we introduce ourselves as. */
function appInfo() {
  let version = '0.0.0';
  try { version = require('../../package.json').version || version; } catch { /* packaged elsewhere */ }
  return { name: 'claude-code-enhanced', version };
}

/** The `host` (name and port) of a URL, or '' when it cannot be parsed. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

/**
 * SSE events (name + data), built on the shared line reader.
 *
 * `parsedDataEvents` from sse.js throws the event name away, but the legacy
 * transport puts the POST url in an `endpoint` event, so the name matters.
 *
 * @param {AsyncIterable<string>} body
 */
async function* sseEvents(body) {
  let name = 'message';
  let data = [];
  for await (const line of sseLines(body)) {
    if (!line) {                                   // an empty line ends the event
      if (data.length) yield { event: name, data: data.join('\n') };
      name = 'message';
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;            // a comment or keep-alive
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length) yield { event: name, data: data.join('\n') };
}

/** The POST url of the legacy transport, resolved against the server url. */
function resolveEndpoint(base, data) {
  const raw = String(data || '').trim();
  if (!raw) return '';
  try { return new URL(raw, base).toString(); } catch { return ''; }
}

/** A 401: the caller is expected to start an OAuth flow. */
class McpAuthError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'McpAuthError';
    this.status = opts.status || 401;
    this.wwwAuthenticate = opts.wwwAuthenticate || '';
    // RFC 9728: the challenge points at the resource metadata of this server.
    const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(this.wwwAuthenticate);
    this.resourceMetadata = m ? m[1] : '';
  }
}

/**
 * One MCP session over HTTP.
 *
 * ```js
 * const client = new McpClient({ url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer …' } });
 * await client.initialize();
 * const tools = await client.listTools();
 * const out = await client.callTool('search', { q: 'x' });
 * await client.close();
 * ```
 */
class McpClient {
  constructor(opts = {}) {
    const { url, headers = {}, transport = 'http', timeoutMs = 30000, fetchImpl } = opts;
    this.url = String(url || '');
    this.headers = { ...(headers || {}) };
    this.transport = transport === 'sse' ? 'sse' : 'http';
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('MCP: no fetch implementation — pass fetchImpl');
    /** Server → client notifications (`notifications/tools/list_changed`, …). */
    this.onNotification = typeof opts.onNotification === 'function' ? opts.onNotification : null;
    this.protocolVersion = opts.protocolVersion || PROTOCOL_VERSION;

    this._id = 0;                 // JSON-RPC ids, unique per session
    this._sessionId = '';         // `Mcp-Session-Id`, when the server issues one
    this._negotiated = this.protocolVersion;
    this._initialized = false;
    this.serverInfo = null;
    this.capabilities = {};

    this._postUrl = '';           // legacy transport: where to POST messages
    this._stream = null;          // legacy transport: the open event stream
    this._streamAbort = null;
    this._endpointReady = null;
    this._pending = new Map();    // id -> { resolve, reject }
    this._early = [];             // answers that arrived before their request
  }

  // ---- public API -----------------------------------------------------------

  /**
   * Handshake with the server.
   * @returns {Promise<{serverInfo: object, capabilities: object, protocolVersion: string, instructions: string}>}
   */
  async initialize() {
    const result = await this._request('initialize', {
      protocolVersion: this.protocolVersion,
      // No client capabilities are claimed: this client does not implement
      // sampling, elicitation or roots, and claiming them would make a server
      // call into handlers that do not exist.
      capabilities: {},
      clientInfo: appInfo(),
    });
    this.serverInfo = result.serverInfo || null;
    this.capabilities = result.capabilities || {};
    this._negotiated = result.protocolVersion || this.protocolVersion;
    this._initialized = true;
    await this._notify('notifications/initialized', {});
    return {
      serverInfo: this.serverInfo,
      capabilities: this.capabilities,
      protocolVersion: this._negotiated,
      instructions: result.instructions || '',
    };
  }

  /** The server's tools, normalised to `{ name, description, inputSchema }`. */
  async listTools() {
    const result = await this._request('tools/list', {});
    const tools = Array.isArray(result && result.tools) ? result.tools : [];
    return tools.map((t) => ({
      name: String((t && t.name) || ''),
      description: String((t && t.description) || ''),
      inputSchema: (t && t.inputSchema) || { type: 'object', properties: {} },
    }));
  }

  /**
   * Call a tool.
   *
   * A tool that failed is reported as `isError: true`; only a protocol error
   * (an unknown tool, a broken session) throws.
   */
  async callTool(name, args) {
    const result = await this._request('tools/call', { name: String(name || ''), arguments: args || {} });
    const out = {
      content: Array.isArray(result && result.content) ? result.content : [],
      isError: !!(result && result.isError),
    };
    if (result && result.structuredContent) out.structuredContent = result.structuredContent;
    return out;
  }

  /** The server's resources, normalised to `{ uri, name, description, mimeType }`. */
  async listResources() {
    const result = await this._request('resources/list', {});
    const resources = Array.isArray(result && result.resources) ? result.resources : [];
    return resources.map((r) => ({
      uri: String((r && r.uri) || ''),
      name: String((r && r.name) || ''),
      description: String((r && r.description) || ''),
      mimeType: String((r && r.mimeType) || ''),
    }));
  }

  /** Read one resource; the answer keeps the server's `contents` array as is. */
  async readResource(uri) {
    const result = await this._request('resources/read', { uri: String(uri || '') });
    return { contents: Array.isArray(result && result.contents) ? result.contents : [] };
  }

  /** Close the session. Safe to call more than once. */
  async close() {
    try { this._streamAbort?.abort(); } catch { /* already gone */ }
    this._streamAbort = null;
    this._stream = null;
    this._failPending(new Error('MCP client closed'));
    this._endpointReady = null;
    this._postUrl = '';
  }

  // ---- transport ------------------------------------------------------------

  async _request(method, params) {
    // Everything but the handshake needs a session first.
    if (method !== 'initialize' && !this._initialized) await this.initialize();
    if (this.transport === 'sse') return this._requestSse(method, params);
    return this._requestHttp(method, params);
  }

  /** Streamable HTTP: POST the request, read the answer off the same response. */
  async _requestHttp(method, params) {
    const id = ++this._id;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const res = await this._fetch(this.url, {
      method: 'POST',
      headers: this._headersFor(this.url, { 'content-type': 'application/json' }),
      body,
    }, method);
    this._rememberSession(res);
    if (res.status === 401) throw await this._authError(res, method);
    if (!res.ok) throw await this._httpError(res, method);

    const type = String(res.headers.get('content-type') || '').toLowerCase();
    let message = null;
    if (type.includes('text/event-stream')) {
      message = await this._firstStreamResponse(res, id, method);
    } else {
      const text = await res.text();
      if (!text.trim()) throw new Error(`MCP ${method}: the server answered HTTP ${res.status} with an empty body`);
      try {
        message = JSON.parse(text);
      } catch {
        throw new Error(`MCP ${method}: the server answered HTTP ${res.status} with something that is not JSON`);
      }
    }
    return this._unwrap(this._pickAnswer(message, id), method);
  }

  /** Legacy HTTP+SSE: POST to the endpoint url, read the answer off the stream. */
  async _requestSse(method, params) {
    const postUrl = await this._ensureStream();
    const id = ++this._id;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const pending = this._makePending(id, method);
    try {
      const res = await this._fetch(postUrl, {
        method: 'POST',
        headers: this._headersFor(postUrl, { 'content-type': 'application/json' }),
        body,
      }, method);
      this._rememberSession(res);
      if (res.status === 401) throw await this._authError(res, method);
      if (!res.ok) throw await this._httpError(res, method);
      await res.text().catch(() => '');          // the answer arrives on the stream
    } catch (err) {
      pending.cancel();                         // nobody will wait for that answer
      throw err;
    }
    return this._unwrap(await pending.promise, method);
  }

  /** A notification: no id, no answer. */
  async _notify(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} });
    const target = this.transport === 'sse' ? await this._ensureStream() : this.url;
    const res = await this._fetch(target, {
      method: 'POST',
      headers: this._headersFor(target, { 'content-type': 'application/json' }),
      body,
    }, method);
    this._rememberSession(res);
    if (res.status === 401) throw await this._authError(res, method);
    if (!res.ok) throw await this._httpError(res, method);
    await res.text().catch(() => '');
  }

  // ---- legacy transport plumbing -------------------------------------------

  /** Open the event stream (once) and wait for the `endpoint` event. */
  async _ensureStream() {
    if (this._postUrl) return this._postUrl;
    if (!this._endpointReady) {
      // A failed connect must not poison the next attempt.
      this._endpointReady = this._openStream().catch((err) => {
        this._endpointReady = null;
        throw err;
      });
    }
    return this._endpointReady;
  }

  async _openStream() {
    const res = await this._openStreamFetch(this.url, {
      method: 'GET',
      headers: this._headersFor(this.url, { accept: ACCEPT }),
    }, 'connect');
    if (res.status === 401) throw await this._authError(res, 'connect');
    if (!res.ok) throw await this._httpError(res, 'connect');
    this._stream = res.body;

    let resolveEp = null;
    let rejectEp = null;
    const endpoint = new Promise((resolve, reject) => { resolveEp = resolve; rejectEp = reject; });
    // A server that opens the stream but never names its endpoint is broken.
    const endpointTimer = setTimeout(
      () => rejectEp(new Error(`MCP timeout: the server sent no endpoint event within ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );

    // The reader runs for the life of the session; it never rejects, it just
    // fails the requests that are still waiting.
    this._reader = (async () => {
      try {
        for await (const ev of sseEvents(res.body)) {
          if (ev.event === 'endpoint') {
            this._postUrl = resolveEndpoint(this.url, ev.data);
            resolveEp(this._postUrl);
            continue;
          }
          let message = null;
          try { message = JSON.parse(ev.data); } catch { continue; }   // not a JSON-RPC message
          this._dispatch(message);
        }
        const err = new Error('MCP event stream closed');
        this._failPending(err);
        rejectEp(err);
      } catch (err) {
        this._failPending(err);
        rejectEp(err);
      }
    })();
    this._reader.catch(() => {});

    const postUrl = await endpoint.finally(() => clearTimeout(endpointTimer));
    if (!postUrl) throw new Error('MCP: the server sent no endpoint event');
    return postUrl;
  }

  /** Route an incoming JSON-RPC message to whoever is waiting for it. */
  _dispatch(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id != null) {
      const pending = this._pending.get(message.id);
      if (pending) {
        this._pending.delete(message.id);
        pending.resolve(message);
        return;
      }
      this._early.push(message);      // an answer to a request we gave up on
      return;
    }
    if (message.method && this.onNotification) {
      try { this.onNotification(message); } catch { /* a bad handler must not kill the stream */ }
    }
  }

  /**
   * A slot for the answer of a request that was sent to the event stream.
   *
   * The answer arrives on another connection, so the slot carries its own
   * timeout — and a `cancel` for the case where the request never made it
   * out (an abandoned waiter must not fire a timer nobody watches).
   */
  _makePending(id, method) {
    // An answer that arrived before its request was registered.
    const early = this._early.findIndex((m) => m.id === id);
    if (early >= 0) {
      const [message] = this._early.splice(early, 1);
      return { promise: Promise.resolve(message), cancel: () => {} };
    }
    let settle = null;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const timer = setTimeout(() => {
      this._pending.delete(id);
      settle.reject(new Error(`MCP timeout: ${method} timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    this._pending.set(id, {
      resolve: (v) => { clearTimeout(timer); settle.resolve(v); },
      reject: (e) => { clearTimeout(timer); settle.reject(e); },
    });
    return { promise, cancel: () => { clearTimeout(timer); this._pending.delete(id); } };
  }

  _failPending(err) {
    for (const [, pending] of this._pending) pending.reject(err);
    this._pending.clear();
  }

  // ---- answers --------------------------------------------------------------

  /** The answer for `id` out of a parsed body (single message or batch). */
  _pickAnswer(message, id) {
    if (Array.isArray(message)) {
      const found = message.find((m) => m && m.id === id);
      if (found) return found;
      throw new Error(`MCP: the server answered with no message for request ${id}`);
    }
    return message;
  }

  /** The first JSON-RPC response on an event stream. */
  async _firstStreamResponse(res, id, method) {
    for await (const ev of sseEvents(res.body)) {
      let message = null;
      try { message = JSON.parse(ev.data); } catch { continue; }
      if (!message || typeof message !== 'object') continue;
      if (message.method && message.id == null) {
        if (this.onNotification) {
          try { this.onNotification(message); } catch { /* ignore */ }
        }
        continue;                                   // a server notification
      }
      if (message.id != null && message.id !== id) continue;
      return message;
    }
    throw new Error(`MCP ${method}: the event stream closed without an answer`);
  }

  /** Unwrap a JSON-RPC response into its result, or throw its error. */
  _unwrap(message, method) {
    if (!message || typeof message !== 'object') throw new Error(`MCP ${method}: malformed answer`);
    if (message.error) {
      const detail = message.error.message || message.error.code || 'unknown error';
      const err = new Error(`MCP ${method}: ${detail}`);
      err.code = message.error.code;
      err.data = message.error.data;
      throw err;
    }
    if (!('result' in message)) throw new Error(`MCP ${method}: the answer had no result`);
    return message.result;
  }

  // ---- headers --------------------------------------------------------------

  /**
   * The headers of one request.
   *
   * The configured headers carry the user's credential, so they only ever go
   * to the host the user configured: a server that answers with a different
   * endpoint — or a redirect — must not receive the bearer token.
   */
  _headersFor(target, extra = {}) {
    const headers = { accept: ACCEPT, ...extra };
    if (hostOf(target) === hostOf(this.url) && hostOf(this.url)) {
      Object.assign(headers, this.headers);
      if (this._sessionId) headers['mcp-session-id'] = this._sessionId;
    }
    if (this._initialized) headers['mcp-protocol-version'] = this._negotiated;
    return headers;
  }

  _rememberSession(res) {
    const sid = res.headers.get('mcp-session-id');
    if (sid) this._sessionId = sid;
  }

  // ---- http -----------------------------------------------------------------

  /**
   * fetch with the timeout of this client.
   *
   * Only the failures that are safe to ask again are retried: a connection
   * that never came up, and a 429 (the server refused the request before it
   * did any work). A 502 or a 504 may hide a tool call that already ran, so
   * those are never repeated — a tool must not run twice.
   */
  async _fetch(url, init, label) {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      let res = null;
      try {
        res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch (err) {
        if (timedOut) throw new Error(`MCP timeout: ${label} timed out after ${this.timeoutMs}ms`);
        const aborted = /abort/i.test(String((err && err.name) || '') + String((err && err.message) || ''));
        if (attempt === 0 && !aborted) {
          attempt++;
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 && attempt === 0) {
        attempt++;
        try { await res.body?.cancel(); } catch { /* the body is already gone */ }
        const header = res.headers.get('retry-after');
        const retryAfter = header === null ? NaN : Number(header);
        const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 5) * 1000 : 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res;
    }
  }

  /**
   * The GET of the legacy transport.
   *
   * The timeout only covers the connect: once the headers are in, the stream
   * lives on until close() aborts it.
   */
  async _openStreamFetch(url, init, label) {
    const controller = new AbortController();
    this._streamAbort = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw new Error(`MCP timeout: ${label} timed out after ${this.timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A 401 becomes an McpAuthError, so the caller can start an OAuth flow. */
  async _authError(res, method) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) detail = parsed.error.message || '';
    } catch { /* the body is not JSON */ }
    return new McpAuthError(
      `MCP ${method}: HTTP 401 — authentication required${detail ? ' — ' + detail : ''}`,
      { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') || '' },
    );
  }

  /** A non-2xx answer: the JSON-RPC error message, when there is one. */
  async _httpError(res, method) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.error) detail = parsed.error.message || parsed.error.code || '';
    } catch { /* the body is not JSON */ }
    if (!detail) detail = text.slice(0, 200);
    const err = new Error(`MCP ${method}: HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    err.status = res.status;
    return err;
  }
}

/**
 * One tool call, start to finish: handshake, call, close.
 *
 * This is the shape the IPC handler wants — the host owns the connection for
 * the length of one call and gives it back.
 *
 * @param {{url: string, headers?: object, transport?: string, name: string, args?: object, timeoutMs?: number, fetchImpl?: Function}} opts
 * @returns {Promise<{content: object[], isError: boolean}>}
 */
async function callTool(opts = {}) {
  const client = new McpClient(opts);
  try {
    await client.initialize();
    return await client.callTool(opts.name, opts.args);
  } finally {
    await client.close();
  }
}

// ---- OAuth 2.1 device code (RFC 8628) ---------------------------------------

/**
 * Sign in to an MCP server with the device-code flow.
 *
 * The server's device authorization endpoint hands out a code the user types
 * into a page; we then poll the token endpoint until the user approves.
 *
 * @param {{url: string, oauth?: object, fetchImpl?: Function}} opts
 * @param {object} [opts.oauth] `{ clientId, scopes, deviceUrl, tokenUrl }` —
 *   the two endpoints are discovered from `url` when they are not given.
 * @returns {Promise<{accessToken: string, tokenType: string, expiresIn: number, userCode: string, verificationUri: string}>}
 */
async function deviceCodeAuth(opts = {}) {
  const { url, oauth = {} } = opts;
  const f = opts.fetchImpl || globalThis.fetch;
  const cfg = {
    clientId: String(oauth.clientId || 'claude-code-enhanced'),
    scopes: String(oauth.scopes || oauth.scope || ''),
    audience: String(oauth.audience || ''),
    deviceUrl: String(oauth.deviceUrl || oauth.deviceAuthorizationUrl || ''),
    tokenUrl: String(oauth.tokenUrl || ''),
  };
  if (!cfg.deviceUrl || !cfg.tokenUrl) {
    const found = await discoverOAuth(f, url);
    cfg.deviceUrl = cfg.deviceUrl || found.deviceUrl;
    cfg.tokenUrl = cfg.tokenUrl || found.tokenUrl;
  }
  if (!cfg.deviceUrl) throw new Error('MCP OAuth: no device authorization endpoint — pass oauth.deviceUrl');
  if (!cfg.tokenUrl) throw new Error('MCP OAuth: no token endpoint — pass oauth.tokenUrl');

  const params = new URLSearchParams();
  params.set('client_id', cfg.clientId);
  if (cfg.scopes) params.set('scope', cfg.scopes);
  if (cfg.audience) params.set('audience', cfg.audience);
  const start = await postForm(f, cfg.deviceUrl, params, 'device authorization');
  const deviceCode = start.device_code;
  if (!deviceCode) throw new Error('MCP OAuth: the device authorization endpoint returned no device_code');

  const rawInterval = Number(start.interval);
  const interval = (Number.isFinite(rawInterval) ? Math.max(0, rawInterval) : 5) * 1000;
  const expiresIn = Number(start.expires_in) || 900;
  const deadline = Date.now() + expiresIn * 1000;
  let wait = interval;

  while (Date.now() < deadline) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const body = new URLSearchParams();
    body.set('grant_type', DEVICE_GRANT);
    body.set('device_code', deviceCode);
    body.set('client_id', cfg.clientId);
    try {
      const token = await postForm(f, cfg.tokenUrl, body, 'token');
      return {
        accessToken: String(token.access_token || token.token || ''),
        tokenType: String(token.token_type || 'Bearer'),
        expiresIn: Number(token.expires_in) || 0,
        // The caller needs these to show the code and to open the page.
        userCode: String(start.user_code || ''),
        verificationUri: String(start.verification_uri || start.verification_uri_complete || ''),
      };
    } catch (err) {
      const code = String((err && err.oauthError) || '');
      if (code === 'authorization_pending') continue;   // the user has not typed the code yet
      if (code === 'slow_down') { wait = wait ? wait * 2 : 1000; continue; }
      throw err;                                          // denied, expired, …
    }
  }
  throw new Error('MCP OAuth: the device authorization expired before it was approved');
}

/**
 * Find the device authorization and token endpoints of a server.
 *
 * RFC 9728 first: the resource server names its authorization server; that
 * server publishes them (RFC 8414 / OpenID Connect discovery).
 */
async function discoverOAuth(f, url) {
  const origins = [];
  const add = (u) => {
    try {
      const origin = new URL(u).origin;
      if (origin && !origins.includes(origin)) origins.push(origin);
    } catch { /* not a url */ }
  };
  add(url);
  try {
    const meta = new URL('/.well-known/oauth-protected-resource', url).toString();
    const res = await f(meta, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      for (const server of (body && body.authorization_servers) || []) add(server);
    }
  } catch { /* discovery is best effort */ }
  for (const origin of origins) {
    for (const path of DISCOVERY_PATHS) {
      try {
        const res = await f(origin + path, { headers: { accept: 'application/json' } });
        if (!res.ok) continue;
        const body = await res.json().catch(() => null);
        if (!body) continue;
        const deviceUrl = body.device_authorization_endpoint || body.device_endpoint || '';
        const tokenUrl = body.token_endpoint || '';
        if (deviceUrl || tokenUrl) return { deviceUrl, tokenUrl };
      } catch { /* try the next candidate */ }
    }
  }
  return { deviceUrl: '', tokenUrl: '' };
}

/**
 * POST a form, parse the answer.
 *
 * The error path never carries the token: only the OAuth error code and its
 * description leave this function.
 */
async function postForm(f, url, params, label) {
  let res = null;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params.toString(),
    });
  } catch (err) {
    throw new Error(`MCP OAuth: the ${label} request failed: ${err && err.message ? err.message : String(err)}`);
  }
  const text = await res.text().catch(() => '');
  let body = {};
  try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok || body.error) {
    const description = body.error_description || body.error || ('HTTP ' + res.status);
    const err = new Error(`MCP OAuth: the ${label} request failed: ${description}`);
    err.oauthError = String(body.error || ('http_' + res.status));
    throw err;
  }
  return body;
}

module.exports = { McpClient, McpAuthError, callTool, deviceCodeAuth, sseEvents, PROTOCOL_VERSION };
