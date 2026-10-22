// Tool-result parsing and structured error propagation.
//
// The old version of this file asserted on a local object and proved nothing.
// These assertions drive the REAL proxy code: a malformed tool payload must
// come back as a structured error that names the FIELD -- never the payload,
// a query string or a credential.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapError, parseToolJson, toolPayloadError } = require('../src/main/proxy.js');

describe('a structured tool-payload error', () => {
  it('carries a type field and the field it is about', () => {
    const e = toolPayloadError('arguments');
    expect(e.type).toBe('invalid_request_error');
    expect(e.field).toBe('arguments');
  });

  it('never carries the payload, a query string or a credential', () => {
    const raw = '{"name":"Read","arguments":"file_path=/etc/shadow&token=sk-live-SECRET"}';
    const e = toolPayloadError('arguments', raw);
    expect(e.message).not.toContain('sk-live-SECRET');
    expect(e.message).not.toContain('/etc/shadow');
    expect(e.message).not.toContain('token=');
    expect(e.message).toContain('arguments');
  });

  it('never carries the raw payload in any field', () => {
    const raw = '{"name":"Read","arguments":{"file_path":"/etc/shadow"}}';
    const e = toolPayloadError('arguments', raw);
    expect(JSON.stringify(e)).not.toContain('/etc/shadow');
  });
});

describe('parseToolJson', () => {
  it('reads a bare tool call', () => {
    expect(parseToolJson('{"name":"Read","arguments":{"file_path":"/a"}}'))
      .toEqual({ name: 'Read', args: { file_path: '/a' } });
  });

  it('reads a call wrapped in a json fence', () => {
    expect(parseToolJson('```json\n{"name":"Read","arguments":{"a":1}}\n```'))
      .toEqual({ name: 'Read', args: { a: 1 } });
  });

  it('returns null for a malformed payload instead of throwing', () => {
    expect(parseToolJson('{"name":"Read","arguments":{')).toBeNull();
  });

  it('refuses a non-object arguments payload', () => {
    expect(parseToolJson('{"name":"Read","arguments":"[1,2]"}')).toBeNull();
  });

  it('refuses a call with no name', () => {
    expect(parseToolJson('{"arguments":{"a":1}}')).toBeNull();
  });
});

describe('mapError', () => {
  it('gives every status class a structured type', () => {
    expect(mapError(400, 'bad request')).toMatchObject({ status: 400, type: 'invalid_request_error' });
    expect(mapError(401, 'Invalid credential')).toMatchObject({ status: 401, type: 'authentication_error' });
    expect(mapError(404, 'Endpoint not found')).toMatchObject({ status: 404, type: 'not_found_error' });
    expect(mapError(429, 'slow down')).toMatchObject({ status: 429, type: 'rate_limit_error' });
    expect(mapError(500, 'boom')).toMatchObject({ status: 502, type: 'api_error' });
  });

  it('names a missing model rather than passing the raw body through', () => {
    expect(mapError(400, 'The requested model does not exist.'))
      .toMatchObject({ status: 404, type: 'not_found_error' });
  });
});
