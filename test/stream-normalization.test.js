// SSE stream normalization.
//
// The old version of this file asserted on a local array and proved nothing.
// These assertions drive the REAL reader (src/main/sse.js) with a byte stream
// split at awkward boundaries: a multi-byte UTF-8 character split across two
// chunks, a CRLF pair split across chunks, and a trailing line with no newline.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sseLines, parsedDataEvents } = require('../src/main/sse.js');

async function* bodyOf(...chunks) {
  for (const c of chunks) yield Buffer.isBuffer(c) ? c : Buffer.from(c);
}

describe('sseLines', () => {
  it('reassembles a multi-byte character split across two chunks', async () => {
    const text = 'data: {"t":"héllo→"}';
    const buf = Buffer.from(text, 'utf8');
    // Cut in the middle of the two-byte 'é' and the three-byte '→'.
    const cut1 = buf.indexOf(Buffer.from('é', 'utf8')) + 1;
    const cut2 = buf.indexOf(Buffer.from('→', 'utf8')) + 1;
    const out = [];
    for await (const l of sseLines(bodyOf(buf.subarray(0, cut1), buf.subarray(cut1, cut2), buf.subarray(cut2)))) out.push(l);
    expect(out).toEqual([text]);
  });

  it('yields the final unterminated line', async () => {
    const out = [];
    for await (const l of sseLines(bodyOf('a\nb\nc'))) out.push(l);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('strips a CR that arrives in a later chunk than its LF', async () => {
    const out = [];
    for await (const l of sseLines(bodyOf('a\r', '\nb\n'))) out.push(l);
    expect(out).toEqual(['a', 'b']);
  });

  it('does not invent an empty line for a blank line', async () => {
    const out = [];
    for await (const l of sseLines(bodyOf('a\n\nb\n'))) out.push(l);
    expect(out).toEqual(['a', '', 'b']);
  });
});

describe('parsedDataEvents', () => {
  it('parses the data payloads and skips the noise', async () => {
    const body = bodyOf(
      'event: message_start\ndata: {"type":"message_start"}\n\n'
      + 'data: {oops\n'
      + 'data: [DONE]\n'
      + 'data: {"type":"x"}'
    );
    const events = [];
    for await (const ev of parsedDataEvents(body)) events.push(ev);
    expect(events).toEqual([{ type: 'message_start' }, { type: 'x' }]);
  });
});
