// Amazon Bedrock helpers.
//
// Bedrock's OpenAI-compatible endpoint (bedrock-runtime …/openai/v1) differs
// from every other OpenAI-compatible server in one way that matters here:
// it does NOT implement GET /models. So the provider test is a minimal
// POST /chat/completions instead of a model listing, and the model picker
// falls back to the models.dev catalog (199 Bedrock models are bundled).
'use strict';

/** True for bedrock-runtime and bedrock-mantle base URLs. */
function isBedrockUrl(baseUrl) {
  const b = String(baseUrl || '');
  return /bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/i.test(b)
    || /bedrock-mantle\.[a-z0-9-]+\.api\.aws/i.test(b);
}

/** Region from the base URL (us-east-1 in bedrock-runtime.us-east-1…). */
function regionFromUrl(baseUrl) {
  const m = String(baseUrl || '').match(/bedrock-(?:runtime|mantle)\.([a-z0-9-]+)\./i);
  return m ? m[1] : '';
}

function chatUrl(base) {
  const b = String(base || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + '/chat/completions';
}

/**
 * Minimal completion probe. Interpretation is Bedrock-specific:
 *   200            -> key and model both valid
 *   400 + unknown model / ValidationException -> auth passed, model wrong
 *   401/403        -> key rejected
 *   anything else  -> classified HTTP error
 */
async function probe(baseUrl, key, model, timeoutMs = 25000) {
  const url = chatUrl(baseUrl);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
      },
      body: JSON.stringify({
        model: model || 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, authOk: false, modelOk: false, error: netError(err) };
  }
  const text = await res.text().catch(() => '');
  const brief = text.replace(/\s+/g, ' ').slice(0, 200);
  if (res.ok) {
    return { ok: true, status: res.status, authOk: true, modelOk: true, detail: 'Bedrock accepted the key and model' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, authOk: false, modelOk: false, error: 'Bedrock rejected the key (' + res.status + '). Use a long-term Bedrock API key (starts ABSK…) or AWS_BEARER_TOKEN_BEDROCK.' + (brief ? '  ' + brief : '') };
  }
  if (res.status === 400 && /isn'?t supported|unknown|validation|model/i.test(text)) {
    // Auth passed (a bad key fails with 401/403 first) but the model id is
    // wrong for this account/region. Report success-with-warning upstream.
    return {
      ok: true, status: res.status, authOk: true, modelOk: false,
      detail: 'Key accepted; model is not available here — pick one from models.dev in the Models tab.' + (brief ? '  ' + brief : ''),
    };
  }
  return { ok: false, status: res.status, authOk: false, modelOk: false, error: 'Bedrock returned HTTP ' + res.status + '.' + (brief ? '  ' + brief : '') };
}

function netError(err) {
  // Node's fetch reports connection failures as a bare "fetch failed" with
  // the real error on .cause — check both.
  const m = String((err && err.message) || '') + ' ' + String((err && err.cause && err.cause.message) || (err && err.cause) || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'Hostname did not resolve — check the region in the base URL (DNS).';
  if (/certificate|SSL|TLS/i.test(m)) return 'TLS handshake failed.';
  if (/ECONNREFUSED/i.test(m)) return 'Connection refused.';
  if (/timeout|aborted/i.test(m)) return 'Timed out — Bedrock did not answer.';
  return m;
}

module.exports = { isBedrockUrl, regionFromUrl, chatUrl, probe };
