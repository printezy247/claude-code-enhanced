// Shared SSE line readers for the proxy and the protocol adapters.
//
// Every streaming upstream path used to carry its own copy of the
// "decode chunks -> split on newline -> (optional) parse data: line" loop,
// each with slightly different final-unterminated-line handling. These are the
// single implementations: sseLines() yields every line (including blanks and
// the trailing partial line), parsedDataEvents() narrows to JSON `data:`
// payloads.
'use strict';

/**
 * Yield decoded text lines from a fetch body, without the trailing newline.
 * The final unterminated line (stream cut, or no trailing \n) is still
 * yielded. Throws propagate from body iteration so callers can catch aborts.
 */
async function* sseLines(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  buf += dec.decode();   // flush any partial multi-byte sequence
  if (buf) yield buf;
}

/** Yield JSON payloads parsed from `data:` lines; non-data/blank/[DONE]/bad JSON are skipped. */
async function* parsedDataEvents(body) {
  for await (const raw of sseLines(body)) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }
    yield ev;
  }
}

module.exports = { sseLines, parsedDataEvents };
