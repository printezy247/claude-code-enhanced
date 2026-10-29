// What a request cost, for the hover on the jump rail. Pure formatting: the
// result frame has the numbers, events.js stores the text on the request.

const fmtN = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
};

const fmtDur = (ms) => {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 1) return '<1s';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60 ? String(s % 60).padStart(2, '0') + 's' : '').trim();
};

/**
 * One line from a result frame: "took 12s · 3.4k in / 320 out · $0.04".
 * Empty when the frame has none of it.
 */
export function formatRequestMetrics(result, { metered = true } = {}) {
  const r = result || {};
  const bits = [];
  if (Number(r.duration_ms) > 0) bits.push('took ' + fmtDur(r.duration_ms));
  const u = r.usage || {};
  const inTok = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
  const outTok = Number(u.output_tokens) || 0;
  if (inTok || outTok) bits.push(fmtN(inTok) + ' in / ' + fmtN(outTok) + ' out');
  if (metered && Number(r.total_cost_usd) > 0) bits.push('$' + Number(r.total_cost_usd).toFixed(Number(r.total_cost_usd) < 0.1 ? 3 : 2));
  return bits.join(' · ');
}
