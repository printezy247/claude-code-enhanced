// Settings export / import as one file: what goes in, what stays out.
import { describe, it, expect } from 'vitest';
import { buildProfile, parseProfile, applyLocal } from '../src/renderer/app/profile.js';

const mem = (init = {}) => {
  const m = { ...init };
  return { get length() { return Object.keys(m).length; }, key: (i) => Object.keys(m)[i], getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); }, _m: m };
};

describe('buildProfile', () => {
  const store = mem({ 'cce.pinned': '["a"]', 'cce:budgets': '{"/x":5}', 'cce:spend': '{"month":"2026-10"}', 'cce:tokenlog': '[]', other: 'no' });
  const text = buildProfile({ settings: { theme: 'dark', loginEnv: { PATH: '/bin' }, connectorUsage: { a: 1 }, claudePath: '/usr/bin/claude' }, store, version: '0.23.0', now: 0 });
  const p = JSON.parse(text);
  it('keeps settings and cce keys', () => {
    expect(p.kind).toBe('cce-profile');
    expect(p.settings).toEqual({ theme: 'dark' });
    expect(Object.keys(p.local).sort()).toEqual(['cce.pinned', 'cce:budgets']);
  });
  it('leaves out machine data, usage and foreign keys', () => {
    expect(text).not.toMatch(/loginEnv|connectorUsage|tokenlog|cce:spend|"other"|\/usr\/bin\/claude/);
  });
});

describe('parseProfile', () => {
  it('round-trips', () => {
    const store = mem({ 'cce.pinned': '["a"]' });
    const r = parseProfile(buildProfile({ settings: { theme: 'light' }, store, version: '1', now: 0 }));
    expect(r.ok).toBe(true);
    expect(r.settings).toEqual({ theme: 'light' });
    const target = mem();
    expect(applyLocal(target, r.local)).toBe(1);
    expect(target.getItem('cce.pinned')).toBe('["a"]');
  });
  it('rejects junk, foreign files and newer versions with plain messages', () => {
    expect(parseProfile('nope').error).toMatch(/not valid JSON/);
    expect(parseProfile('{"a":1}').error).toMatch(/not a CCE profile/);
    expect(parseProfile('{"kind":"cce-profile","version":9}').error).toMatch(/newer CCE/);
  });
  it('ignores keys outside cce and secrets-skipped settings in a hand-edited file', () => {
    const r = parseProfile(JSON.stringify({ kind: 'cce-profile', version: 1, settings: { theme: 'x', loginEnv: {} }, local: { evil: 'x', 'cce:spend': '1', 'cce.ok': 'y', 'cce.num': 5 } }));
    expect(r.settings).toEqual({ theme: 'x' });
    expect(r.local).toEqual({ 'cce.ok': 'y' });
  });
  it('refuses an oversized profile', () => {
    const r = parseProfile(JSON.stringify({ kind: 'cce-profile', version: 1, local: { 'cce.big': 'x'.repeat(600 * 1024) } }));
    expect(r.ok).toBe(false);
  });
});
