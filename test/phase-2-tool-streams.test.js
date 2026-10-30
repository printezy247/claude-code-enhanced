// Phase 2.5: parallel tool-call deltas as different providers send them.
// Synthetic fixtures (shapes written from the providers' documented streams):
// the merge below is the one the proxy runs for every chunk.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickToolSlot } = require('../src/main/proxy.js');

function merge(chunks) {
  const toolBuf = new Map();
  for (const tc of chunks) {
    const k = pickToolSlot(toolBuf, tc);
    const cur = toolBuf.get(k) || { id: tc.id || 'call_' + k, name: '', args: '' };
    if (tc.id) { cur.id = tc.id; cur.real = true; }
    if (tc.function && tc.function.name) cur.name = tc.function.name;
    if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
    toolBuf.set(k, cur);
  }
  return [...toolBuf].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ name: v.name, args: v.args }));
}
const call = (index, id, name, args) => ({ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args || '' } });
const two = [{ name: 'read', args: '{"p":"a"}' }, { name: 'grep', args: '{"q":"b"}' }];

describe('parallel tool-call streams', () => {
  it('OpenAI style: ids once, index on every delta', () => {
    expect(merge([call(0, 'c0', 'read', ''), call(0, '', '', '{"p":'), call(0, '', '', '"a"}'),
      call(1, 'c1', 'grep', ''), call(1, '', '', '{"q":"b"}')])).toEqual(two);
  });
  it('Kimi style: the same index and id repeated on every delta', () => {
    expect(merge([call(0, 'functions.read:0', 'read', '{"p":'), call(0, 'functions.read:0', '', '"a"}'),
      call(1, 'functions.grep:1', 'grep', '{"q":"b"}')])).toEqual(two);
  });
  it('GLM style: whole calls, each with its own index', () => {
    expect(merge([call(0, 'a', 'read', '{"p":"a"}'), call(1, 'b', 'grep', '{"q":"b"}')])).toEqual(two);
  });
  it('Qwen style: every call arrives at index 0 with a new id', () => {
    expect(merge([call(0, 'a', 'read', '{"p":"a"}'), call(0, 'b', 'grep', '{"q":"b"}')])).toEqual(two);
  });
  it('interleaved deltas find their call by index', () => {
    expect(merge([call(0, 'a', 'read', ''), call(1, 'b', 'grep', ''),
      call(0, '', '', '{"p":'), call(1, '', '', '{"q":'), call(0, '', '', '"a"}'), call(1, '', '', '"b"}')])).toEqual(two);
  });
  it('interleaved deltas find their call by id when the index is wrong', () => {
    expect(merge([call(0, 'a', 'read', ''), call(1, 'b', 'grep', ''),
      call(0, 'a', '', '{"p":"a"}'), call(0, 'b', '', '{"q":"b"}')])).toEqual(two);
  });
  it('out-of-order indexes come out sorted', () => {
    expect(merge([call(1, 'b', 'grep', '{"q":"b"}'), call(0, 'a', 'read', '{"p":"a"}')])).toEqual(two);
  });
  it('OpenRouter-anthropic style: no index, id on the opening delta only', () => {
    expect(merge([call(undefined, 'a', 'read', ''), call(undefined, '', '', '{"p":"a"}'),
      call(undefined, 'b', 'grep', ''), call(undefined, '', '', '{"q":"b"}')])).toEqual(two);
  });
});
