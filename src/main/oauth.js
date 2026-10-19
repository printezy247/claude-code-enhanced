// OAuth runner: PKCE with a localhost callback, manual paste-code, and device
// code, plus token refresh. Used by the "Connect" wizard for subscription /
// OAuth providers (Anthropic, OpenAI, GitHub Copilot, GitLab, DigitalOcean).
//
// Nothing here is claude-specific except `writeClaudeCredentials`, which lets a
// Claude Pro/Max OAuth token be picked up by the engine's own /login store.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteJson } = require('./atomic');
// ---- PKCE helpers -----------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function parseRedirectPort(redirectUri) {
  try { return Number(new URL(redirectUri).port) || 0; } catch { return 0; }
}

function codeFromInput(input) {
  // Anthropic's callback shows `code#state`; some paste flows include the state.
  const raw = String(input || '').trim();
  const [code, state] = raw.split('#');
  return { code, state };
}

/** Constant-time string comparison to avoid leaking state via timing. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** POST token params as JSON, retrying form-encoded if the server rejects JSON. */
async function postToken(url, params, headers = {}) {
  const doFetch = (body, ct) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': ct, accept: 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  let res = await doFetch(JSON.stringify(params), 'application/json');
  if (res.status === 400 || res.status === 415) {
    res = await doFetch(new URLSearchParams(params).toString(), 'application/x-www-form-urlencoded');
  }
  let body = {};
  const text = await res.text().catch(() => '');
  try { body = JSON.parse(text); } catch { body = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok || body.error) {
    const msg = body.error_description || body.error || body.message || ('HTTP ' + res.status);
    throw new Error(String(msg));
  }
  return body;
}

/** Normalise a token endpoint payload into our record shape. */
function normalizeTokens(body) {
  const access = body.access_token || body.token || '';
  const refresh = body.refresh_token || '';
  const expiresIn = Number(body.expires_in) || 0;
  return {
    access,
    refresh,
    expires: expiresIn ? Date.now() + expiresIn * 1000 : 0,
    meta: {
      tokenType: body.token_type || 'Bearer',
      scope: body.scope || '',
      account: body.account || (body.organizations && body.organizations[0] && body.organizations[0].name) || '',
      idToken: body.id_token || '',
    },
  };
}

// ---- flows ------------------------------------------------------------------

/**
 * Begin an OAuth flow.
 * @returns {{url:string, userCode?:string, instructions:string, method:'auto'|'code'|'device', wait:Function, cancel:Function}}
 */
function begin(providerId, cfg, opts = {}) {
  if (!cfg) throw new Error('provider has no OAuth configuration');
  const flow = cfg.flow || 'pkce';
  const redirectUri = opts.redirectUri || cfg.redirectUri || 'http://127.0.0.1:8080/callback';
  const state = b64url(crypto.randomBytes(16));
  const pkce = makePkce();

  const authorizeUrl = (codeChallenge) => {
    const u = new URL(cfg.authorizeUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', cfg.clientId || opts.clientId || '');
    u.searchParams.set('redirect_uri', redirectUri);
    if (cfg.scopes) u.searchParams.set('scope', cfg.scopes);
    u.searchParams.set('state', state);
    if (codeChallenge) {
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [k, v] of Object.entries(cfg.extra || {})) u.searchParams.set(k, v);
    if (flow === 'code') u.searchParams.set('code', 'true');
    return u.toString();
  };

  if (flow === 'device') {
    return beginDevice(providerId, cfg, opts);
  }

  // pkce + code both use an authorization-code exchange; pkce waits on a
  // localhost callback, code waits for the user to paste the code.
  const exchange = async (input) => {
    const { code, state: retState } = codeFromInput(input);
    if (!code) throw new Error('no authorization code');
    // State is mandatory on the automatic callback path (enforced before this
    // is called) but optional for the manual paste-code flow, where the user
    // may paste just a code. Validate only when the caller supplies it.
    if (retState && !safeEqual(retState, state)) throw new Error('OAuth state mismatch — start the flow again');
    const body = await postToken(cfg.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId || opts.clientId || '',
      code_verifier: pkce.verifier,
    });
    const tokens = normalizeTokens(body);
    if (!tokens.access) throw new Error('token endpoint returned no access token');
    return tokens;
  };

  if (flow === 'code') {
    return {
      method: 'code',
      url: authorizeUrl(pkce.challenge),
      instructions: 'Authorize in the browser, then paste the code shown on the page.',
      exchange,
      wait: () => Promise.reject(new Error('paste-code flow: call exchange(code)')),
      cancel() {},
    };
  }

  // PKCE with a localhost callback.
  const wantPort = parseRedirectPort(redirectUri);
  const cbPath = (() => { try { return new URL(redirectUri).pathname; } catch { return '/callback'; } })();
  let resolveCb, rejectCb;
  let settled = false;
  const done = new Promise((res, rej) => { resolveCb = res; rejectCb = rej; });
  // A callback that fails before the UI calls wait() must not surface as an
  // unhandled rejection; chains built off `done` (via wait) still reject.
  done.catch(() => {});
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const page = (res2, status, msg) => {
    res2.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res2.end('<html><body style="font-family:sans-serif;background:#14141a;color:#eee;padding:40px">'
      + msg + '</body></html>');
  };
  const server = http.createServer((req, res) => {
    // DNS-rebinding guard: only accept requests addressed to the loopback host
    // we actually bound. A foreign Host header means a browser tab on another
    // origin is trying to reach the callback.
    const host = String(req.headers.host || '').toLowerCase();
    // An empty Host header is rejected: a real browser request always carries
    // one, so a missing header is a strong signal of a non-browser probe.
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      page(res, 403, 'Forbidden.');
      return;
    }
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); }
    catch { page(res, 400, 'Bad request.'); return; }
    if (u.pathname !== cbPath) { page(res, 404, 'Not found.'); return; }
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    const retState = u.searchParams.get('state');
    if (err) {
      page(res, 200, 'Authorization failed: ' + esc(err));
      if (!settled) { settled = true; rejectCb(new Error(err)); }
      return;
    }
    if (!code) { page(res, 400, 'No authorization code received.'); return; }
    // CSRF guard: the browser must bring back the exact state we generated.
    // A forged or substituted callback (someone else's `code`) must never be
    // exchanged — reject the whole flow rather than accept a foreign code.
    if (!safeEqual(retState, state)) {
      page(res, 400, 'OAuth state mismatch — please restart the sign-in.');
      if (!settled) { settled = true; rejectCb(new Error('OAuth state mismatch — start the flow again')); }
      return;
    }
    page(res, 200, 'Signed in. You can close this tab and return to Claude Code Enhanced.');
    if (settled) return;
    settled = true;
    exchange(code + '#' + retState).then(resolveCb, rejectCb);
  });
  const listen = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, '127.0.0.1', () => resolve(server.address().port));
  });
  const cancel = () => {
    try { server.close(); } catch { /* already closed */ }
    // Settle the pending promise too, or a wait() already in flight (or the
    // 10-minute reaper firing while the dialog is open) hangs forever.
    if (!settled) { settled = true; rejectCb(new Error('sign-in cancelled')); }
  };
  listen.catch((e) => rejectCb(e));

  return {
    method: 'auto',
    url: authorizeUrl(pkce.challenge),
    instructions: 'Your browser will open; approve access. This window finishes automatically.',
    // Resolves with the port the callback server actually bound (0 = ephemeral).
    port: listen,
    wait: () => done.finally(() => setTimeout(cancel, 500)),
    exchange,
    cancel,
  };
}

/** GitHub-style device flow: show a code, poll for the token. */
function beginDevice(providerId, cfg, opts = {}) {
  let stopped = false;
  const run = async () => {
    const start = await postToken(cfg.deviceUrl, {
      client_id: cfg.clientId || opts.clientId || '',
      scope: cfg.scopes || '',
    });
    const deviceCode = start.device_code;
    const interval = Math.max(3, Number(start.interval) || 5) * 1000;
    const url = start.verification_uri || start.verification_uri_complete || '';
    const userCode = start.user_code || '';
    if (!deviceCode) throw new Error('device endpoint returned no device_code');

    const poll = async () => {
      for (let i = 0; i < 200 && !stopped; i++) {
        await new Promise(r => setTimeout(r, interval));
        let body;
        try {
          body = await postToken(cfg.tokenUrl, {
            client_id: cfg.clientId || opts.clientId || '',
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          });
        } catch (err) {
          const msg = String(err.message || err);
          if (/authorization_pending|slow_down/i.test(msg)) continue;
          if (/expired_token|access_denied/i.test(msg)) throw err;
          continue;
        }
        return normalizeTokens(body);
      }
      throw new Error(stopped ? 'sign-in cancelled' : 'device authorization timed out');
    };
    const tokens = poll();
    // Created eagerly, so a cancel with nobody awaiting wait() must not surface
    // as an unhandled rejection. wait() still sees the same rejection.
    tokens.catch(() => {});
    return { url, userCode, tokens };
  };

  const started = run();
  return {
    method: 'device',
    // The caller awaits `ready` to show the code, then `wait()` for the token.
    ready: started,
    async wait() {
      const { tokens } = await started;
      return tokens;
    },
    cancel() { stopped = true; },
  };
}

// ---- refresh ----------------------------------------------------------------

/** Refresh a standard OAuth access token. Returns a normalised record. */
async function refreshTokens(cfg, refreshToken, opts = {}) {
  const body = await postToken(cfg.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId || opts.clientId || '',
  });
  const tokens = normalizeTokens(body);
  if (!tokens.refresh) tokens.refresh = refreshToken;   // many servers omit it
  return tokens;
}

/** Exchange a long-lived GitHub token for a short-lived Copilot token. */
async function refreshCopilot(githubToken) {
  const res = await fetch('https://api.githubcopilot.com/copilot_internal/v2/token', {
    headers: {
      authorization: 'Bearer ' + githubToken,
      'editor-version': 'vscode/1.96.0',
      'editor-plugin-version': 'copilot-chat/0.24.0',
      'user-agent': 'GitHubCopilotChat/0.24.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error('Copilot token exchange failed: HTTP ' + res.status);
  const j = await res.json();
  if (!j.token) throw new Error('Copilot token exchange returned no token');
  return { access: j.token, refresh: githubToken, expires: (Number(j.expires_at) || 0) * 1000, meta: { copilot: true } };
}

/**
 * Claude Code stores subscription credentials in ~/.claude/.credentials.json.
 * Writing it lets an Anthropic OAuth sign-in be used by the engine directly.
 */
function writeClaudeCredentials(tokens) {
  const dir = path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.credentials.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* new file */ }
    existing.claudeAiOauth = {
      accessToken: tokens.access,
      refreshToken: tokens.refresh || (existing.claudeAiOauth && existing.claudeAiOauth.refreshToken) || '',
      expiresAt: tokens.expires || Date.now() + 3600 * 1000,
      scopes: String(tokens.meta && tokens.meta.scope || '').split(/\s+/).filter(Boolean),
      subscriptionType: (tokens.meta && tokens.meta.subscriptionType) || 'pro',
    };
    atomicWriteJson(file, existing);
    return true;
  } catch (err) {
    console.error('[oauth] could not write claude credentials:', String((err && err.message) || err));
    return false;
  }
}

module.exports = { makePkce, b64url, begin, refreshTokens, refreshCopilot, writeClaudeCredentials, codeFromInput, normalizeTokens, parseRedirectPort };
