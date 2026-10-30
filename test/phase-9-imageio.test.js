// Saving or copying a composer image: the main process validates what the page sends.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decodeImage, MAX_IMAGE_BYTES } = require('../src/main/imageio.js');

const b64 = (s) => Buffer.from(s).toString('base64');

describe('decodeImage', () => {
  it('accepts the image types, gives bytes and an extension', () => {
    const r = decodeImage({ media_type: 'image/png', data: b64('abc') });
    expect(r.ok).toBe(true);
    expect(r.buffer.toString()).toBe('abc');
    expect(r.ext).toBe('png');
    expect(decodeImage({ media_type: 'image/jpeg', data: b64('x') }).ext).toBe('jpg');
  });
  it('refuses other types, empty data and oversized data', () => {
    expect(decodeImage({ media_type: 'image/svg+xml', data: b64('x') }).ok).toBe(false);
    expect(decodeImage({ media_type: 'text/html', data: b64('x') }).ok).toBe(false);
    expect(decodeImage({ media_type: 'image/png', data: '' }).ok).toBe(false);
    expect(decodeImage({ media_type: 'image/png', data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }).ok).toBe(false);
    expect(decodeImage(null).ok).toBe(false);
  });
});
