// Prompt-size estimates for providers that do not report usage, and a
// correction learned from the ones that do.
//
// `length / 4` is right for English prose and wrong almost everywhere else:
// code and JSON run nearer 3 characters a token, CJK text is about one token a
// character, and a base64 image counted by its string length reads as a
// quarter of a million tokens. A wrong number here moves the context meter and
// the auto-compact decision, so the estimate walks the request by content type
// and every real usage figure the provider sends tunes the next estimate.
'use strict';

const IMAGE_TOKENS = 1600;
const DOCUMENT_TOKENS = 2400;
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;

/** Tokens in one string, by what the characters are. */
function estimateText(s) {
  const str = typeof s === 'string' ? s : s == null ? '' : String(s);
  const n = str.length;
  if (!n) return 0;
  const cjk = (str.match(CJK_RE) || []).length;
  const rest = n - cjk;
  let other = 0;      // non-ASCII, non-CJK: accented words, symbols, emoji
  let punct = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 127) other++;
    else if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32 || c === 10 || c === 13 || c === 9)) punct++;
  }
  const ascii = Math.max(0, rest - other);
  const perToken = ascii && punct / ascii > 0.18 ? 3 : 4;
  return cjk + other * 0.6 + ascii / perToken;
}

function blockTokens(b) {
  if (b == null) return 0;
  if (typeof b === 'string') return estimateText(b);
  if (Array.isArray(b)) return b.reduce((t, x) => t + blockTokens(x), 0);
  if (typeof b !== 'object') return 0;
  switch (b.type) {
    case 'text': return estimateText(b.text);
    case 'thinking': return estimateText(b.thinking);
    case 'image': return IMAGE_TOKENS;
    case 'document': return DOCUMENT_TOKENS;
    case 'tool_use': return estimateText(b.name) + estimateText(JSON.stringify(b.input == null ? {} : b.input)) + 4;
    case 'tool_result': return blockTokens(b.content) + 4;
    default: return estimateText(JSON.stringify(b));
  }
}

/** Raw estimate of a request's prompt, before any learned correction. */
function estimateBody(body) {
  try {
    let t = blockTokens(body && body.system);
    for (const m of (body && body.messages) || []) t += 4 + blockTokens(m && m.content);
    for (const tool of (body && body.tools) || []) t += estimateText(JSON.stringify(tool));
    return Math.max(1, Math.round(t));
  } catch { return 1; }
}

// Real prompt size / raw estimate, per model, smoothed. Bounded: models come and go.
const factors = new Map();
const MAX_FACTORS = 200;

function factorFor(model) {
  return factors.get(String(model || '')) || 1;
}

/** Prompt tokens for a request: the raw estimate scaled by what this model's real counts taught. */
function estimatePrompt(body) {
  return Math.max(1, Math.round(estimateBody(body) * factorFor(body && body.model)));
}

/**
 * Learn from a provider-reported prompt size.
 * @param {string} model
 * @param {number} raw     estimateBody() of the same request
 * @param {number} actual  prompt tokens the provider reported
 */
function noteActual(model, raw, actual) {
  const key = String(model || '');
  if (!key || !(raw >= 50) || !(actual > 0)) return;
  const ratio = Math.min(2.5, Math.max(0.4, actual / raw));
  const prev = factors.get(key);
  const next = prev == null ? ratio : prev * 0.6 + ratio * 0.4;
  if (!factors.has(key) && factors.size >= MAX_FACTORS) factors.delete(factors.keys().next().value);
  factors.set(key, Math.min(2, Math.max(0.5, next)));
}

function resetCalibration() { factors.clear(); }

module.exports = { estimateText, estimateBody, estimatePrompt, noteActual, factorFor, resetCalibration, IMAGE_TOKENS };
