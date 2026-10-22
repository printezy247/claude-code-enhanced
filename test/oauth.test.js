// OAuth token refresh robustness (task A7).
//
// A refresh that fails used to fail silently: the provider looked connected
// while every request went upstream with a dead token. The refresh has to
// retry once with a backoff, mark the provider authExpired so the UI can say
// "reconnect", and leave a still-valid token alone — a failed refresh must
// never destroy a credential that is still good.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const providers = require('../src/main/providers.js');

/** A fake AuthStore holding one OAuth record. */
function fakeAuth(rec) {
  const state = { record: rec, setOAuth: vi.fn((uid, next) => { state.record = { ...rec, ...next, type: 'oauth' }; }) };
  return {
    state,
    get: (uid) => (state.record ? { ...state.record } : null),
    setOAuth: state.setOAuth,
    resolve: () => ({}),
    summary: () => ({ present: true, type: 'oauth', hint: 'tok…1234', expires: state.record ? state.record.expires : 0, expired: false }),
  };
}

/** An oauth module whose refresh always fails. */
function failingOauth() {
  return {
    refreshTokens: vi.fn(async () => { throw new Error('HTTP 500 from the token endpoint'); }),
    refreshCopilot: vi.fn(async () => { throw new Error('HTTP 500 from the token endpoint'); }),
  };
}

const oauthInstance = { uid: 'o1', name: 'Anthropic', presetId: 'anthropic' };

describe('OAuth refresh', () => {
  it('does not throw when the refresh fails', async () => {
    const auth = fakeAuth({ type: 'oauth', access: 'old', refresh: 'r1', expires: Date.now() - 1000 });
    const inst = { ...oauthInstance };
    await expect(providers.ensureFreshAuth(inst, { auth, oauth: failingOauth() })).resolves.not.toThrow();
  });

  it('marks the provider authExpired when the refresh fails', async () => {
    const auth = fakeAuth({ type: 'oauth', access: 'old', refresh: 'r1', expires: Date.now() - 1000 });
    const inst = { ...oauthInstance };
    await providers.ensureFreshAuth(inst, { auth, oauth: failingOauth() });
    expect(inst.authExpired).toBe(true);
  });

  it('leaves a still-valid token untouched when the refresh fails', async () => {
    // The token has not expired yet — a failed refresh must not clear it.
    const auth = fakeAuth({ type: 'oauth', access: 'still-good', refresh: 'r1', expires: Date.now() + 3_600_000 });
    const inst = { ...oauthInstance };
    await providers.ensureFreshAuth(inst, { auth, oauth: failingOauth() });
    expect(auth.state.setOAuth).not.toHaveBeenCalled();
    expect(auth.state.record.access).toBe('still-good');
  });

  it('retries the refresh once before giving up', async () => {
    const oauth = failingOauth();
    const auth = fakeAuth({ type: 'oauth', access: 'old', refresh: 'r1', expires: Date.now() - 1000 });
    const inst = { ...oauthInstance };
    await providers.ensureFreshAuth(inst, { auth, oauth });
    expect(oauth.refreshTokens).toHaveBeenCalledTimes(2);
  });

  it('stores the new token and clears authExpired when the refresh works', async () => {
    const oauth = {
      refreshTokens: vi.fn(async () => ({ access: 'fresh', refresh: 'r2', expires: Date.now() + 3_600_000 })),
      refreshCopilot: vi.fn(),
    };
    const auth = fakeAuth({ type: 'oauth', access: 'old', refresh: 'r1', expires: Date.now() - 1000 });
    const inst = { ...oauthInstance };
    await providers.ensureFreshAuth(inst, { auth, oauth });
    expect(auth.state.setOAuth).toHaveBeenCalled();
    expect(auth.state.record.access).toBe('fresh');
    expect(inst.authExpired).toBe(false);
  });

  it('rebuilds the proxy secret cache after a successful refresh', async () => {
    const refreshSecretCache = vi.fn();
    const oauth = {
      refreshTokens: vi.fn(async () => ({ access: 'fresh', refresh: 'r2', expires: Date.now() + 3_600_000 })),
      refreshCopilot: vi.fn(),
    };
    const auth = fakeAuth({ type: 'oauth', access: 'old', refresh: 'r1', expires: Date.now() - 1000 });
    await providers.ensureFreshAuth({ ...oauthInstance }, { auth, oauth, refreshSecretCache });
    expect(refreshSecretCache).toHaveBeenCalled();
  });

  it('does nothing for a provider that is not OAuth', async () => {
    const auth = fakeAuth({ type: 'api', key: 'k' });
    const oauth = failingOauth();
    const inst = { ...oauthInstance };
    await providers.ensureFreshAuth(inst, { auth, oauth });
    expect(oauth.refreshTokens).not.toHaveBeenCalled();
    expect(inst.authExpired).toBeUndefined();
  });

  it('does not refresh a token that is still far from expiry', async () => {
    const oauth = failingOauth();
    const auth = fakeAuth({ type: 'oauth', access: 'good', refresh: 'r1', expires: Date.now() + 3_600_000 });
    await providers.ensureFreshAuth({ ...oauthInstance }, { auth, oauth });
    expect(oauth.refreshTokens).not.toHaveBeenCalled();
  });
});

describe('publicInstance surfaces the expired state', () => {
  it('reports authExpired for a provider whose refresh failed', () => {
    const auth = fakeAuth({ type: 'oauth', access: 'old', refresh: 'r1', expires: Date.now() - 1000 });
    providers.useAuth(auth);
    const inst = { ...oauthInstance, authExpired: true };
    const view = providers.publicInstance(inst);
    expect(view.authExpired).toBe(true);
  });

  it('reports a live token as not expired', () => {
    const auth = fakeAuth({ type: 'oauth', access: 'good', refresh: 'r1', expires: Date.now() + 3_600_000 });
    providers.useAuth(auth);
    const view = providers.publicInstance({ ...oauthInstance });
    expect(view.authExpired).toBe(false);
  });
});
