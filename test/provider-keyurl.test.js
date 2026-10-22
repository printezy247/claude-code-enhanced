// Key/URL mismatch detection (task A2) and base-URL normalization (task A8).
//
// A provider that cannot work sends a 401 with a body nobody understands. The
// whole point of keyUrlMismatch() is to say WHICH thing is wrong — a Claude key
// on an OpenAI URL, a missing /v1, a Google key in the query string — so the
// user can fix it without reading provider docs. Each case therefore has its
// own message, and a matching pair has none.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keyUrlMismatch, normalizeBaseUrl } = require('../src/main/providers.js');

describe('key/URL mismatch detection', () => {
  it('says a Xiaomi Token Plan key needs the Token Plan URL', () => {
    expect(keyUrlMismatch('https://api.xiaomimimo.com/v1', 'tp-slx123rge5'))
      .toMatch(/Token Plan key.*token-plan-cn\.xiaomimimo\.com\/v1/);
  });

  it('says a pay-as-you-go key needs the pay-as-you-go URL', () => {
    expect(keyUrlMismatch('https://token-plan-sgp.xiaomimimo.com/v1', 'sk-abc'))
      .toMatch(/api\.xiaomimimo\.com\/v1/);
  });

  it('says an Anthropic key cannot go to an OpenAI-style host', () => {
    const msg = keyUrlMismatch('https://api.openai.com/v1', 'sk-ant-api03-xxx');
    expect(msg).toMatch(/Anthropic API key/);
    expect(msg).toMatch(/api\.anthropic\.com/);
  });

  it('says an OpenAI project key cannot go to an Anthropic host', () => {
    expect(keyUrlMismatch('https://api.anthropic.com/v1', 'sk-proj-xxx'))
      .toMatch(/OpenAI project key/);
  });

  it('says a Google key cannot go to an Anthropic or OpenAI host', () => {
    expect(keyUrlMismatch('https://api.openai.com/v1', 'AIzaSyXXX'))
      .toMatch(/Google API key/);
  });

  it('says a trailing slash has to go', () => {
    const msg = keyUrlMismatch('https://api.openai.com/v1/', 'sk-abc');
    expect(msg).toMatch(/trailing slash/);
  });

  it('says a double slash has to go', () => {
    const msg = keyUrlMismatch('https://api.openai.com//v1', 'sk-abc');
    expect(msg).toMatch(/double slash/);
  });

  it('says a missing /v1 has to be added', () => {
    const msg = keyUrlMismatch('https://api.groq.com/openai', 'gsk-abc');
    expect(msg).toMatch(/missing the \/v1 path segment/);
    expect(msg).toMatch(/api\.groq\.com\/openai\/v1/);
  });

  it('says a Google key belongs in a header, not in ?key=', () => {
    const msg = keyUrlMismatch('https://generativelanguage.googleapis.com/v1beta/openai?key=abc', 'AIzaSyXXX');
    expect(msg).toMatch(/query parameter/);
    expect(msg).toMatch(/x-goog-api-key/);
  });

  it('says an Azure URL needs a deployment path', () => {
    expect(keyUrlMismatch('https://myresource.openai.azure.com/openai', 'my-key'))
      .toMatch(/deployment path/);
  });

  it('says an Azure resource name that does not match the key', () => {
    const msg = keyUrlMismatch(
      'https://myresource.openai.azure.com/openai/deployments/dep', 'not-a-real-azure-key');
    expect(msg).toMatch(/resource name/);
    expect(msg).toMatch(/myresource/);
  });

  it('accepts an Azure URL whose key has the Azure 32-hex shape', () => {
    expect(keyUrlMismatch(
      'https://myresource.openai.azure.com/openai/deployments/dep', 'a'.repeat(32))).toBe('');
  });

  it('says nothing when the key and the URL belong together', () => {
    expect(keyUrlMismatch('https://api.openai.com/v1', 'sk-abc')).toBe('');
    expect(keyUrlMismatch('https://api.anthropic.com', 'sk-ant-api03-xxx')).toBe('');
    expect(keyUrlMismatch('https://api.groq.com/openai/v1', 'gsk-abc')).toBe('');
    expect(keyUrlMismatch('https://router.bynara.id/v1', 'tp-abc')).toBe('');
  });

  it('says nothing when there is no key to judge', () => {
    expect(keyUrlMismatch('https://api.xiaomimimo.com/v1', '')).toBe('');
    expect(keyUrlMismatch('', 'sk-abc')).toBe('');
  });
});

describe('base URL normalization', () => {
  it('strips a trailing slash', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/', 'openai')).toBe('https://api.openai.com/v1');
  });

  it('adds the /v1 segment an OpenAI-compatible URL needs', () => {
    expect(normalizeBaseUrl('https://api.openai.com/', 'openai')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('openrouter.ai/api', 'openai')).toBe('https://openrouter.ai/api/v1');
  });

  it('adds a missing scheme', () => {
    expect(normalizeBaseUrl('example.com', 'openai')).toBe('https://example.com/v1');
  });

  it('leaves a local server alone', () => {
    expect(normalizeBaseUrl('http://localhost:11434', 'openai')).toBe('http://localhost:11434');
  });

  it('does not touch a URL that is already correct', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1', 'openai')).toBe('https://api.openai.com/v1');
  });

  it('keeps a legitimate path', () => {
    expect(normalizeBaseUrl('https://opencode.ai/zen/go/v1', 'openai')).toBe('https://opencode.ai/zen/go/v1');
    expect(normalizeBaseUrl('https://example.com/api', 'openai')).toBe('https://example.com/api');
  });

  it('does not double-append /v1', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1', 'openai')).not.toMatch(/v1\/v1/);
  });

  it('refuses a non-http scheme', () => {
    expect(normalizeBaseUrl('ftp://example.com', 'openai')).toBe('');
    expect(normalizeBaseUrl('file:///etc/passwd', 'openai')).toBe('');
  });

  it('leaves an Anthropic URL without a /v1 alone', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/anthropic', 'anthropic'))
      .toBe('https://api.deepseek.com/anthropic');
  });
});
