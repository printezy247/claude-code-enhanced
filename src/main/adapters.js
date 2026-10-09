// Direct HTTP adapters.
//
// Every non-Anthropic provider is reached by translating its wire protocol into
// OpenAI chat.completions chunks; the existing translator in proxy.js then turns
// that into Anthropic SSE. Keeping one downstream shape means the local-model
// tool-call recovery, usage reporting and abort handling all keep working for
// Gemini, the OpenAI Responses API and plain OpenAI-compatible servers alike.
//
// Exports `callUpstream(prov, body, wantStream, signal) -> Response-like`.
'use strict';

/** OpenAI-compatible root for a provider base URL (bare Ollama roots get /v1). */
function openaiBase(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/(^|\/)v1$/.test(base) || /\/openai(\/v1)?$/.test(base)) return base;
  return base + '/v1';
}

/**
 * fetch with one retry on connection-level failure. Hosts with broken IPv6
 * (AAAA records that refuse instantly) fail every other connection while the
 * next one succeeds, so a single retry turns an api_retry storm into a
 * slightly slower first byte. Never retries aborts (user interrupt / timeout).
 */
const RETRY_STATUS = new Set([429, 502, 504]);
async function fetchUpstream(url, opts, signal, tries = 2) {
  // Callers pass the abort signal either positionally or inside opts —
  // honour both, or interrupts never reach the upstream (leaked turns).
  signal = signal || (opts && opts.signal) || null;
  const withTimeout = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(900_000)])
    : AbortSignal.timeout(900_000);
  let last;
  let rateTries = 0;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: withTimeout });
      // Rate limits and gateway hiccups are transient: wait (Retry-After wins,
      // capped) and try again. 503 is excluded — gateways answer it for a
      // wrong model id, which no amount of waiting fixes.
      if (RETRY_STATUS.has(res.status) && rateTries < 2 && !withTimeout.aborted) {
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && res.headers.get('retry-after') !== null ? Math.min(ra, 15) * 1000 : 1000 * (2 * rateTries + 1);
        rateTries++; i--;
        try { await res.body?.cancel(); } catch { /* body already consumed */ }
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      last = err;
      const aborted = withTimeout.aborted || /abort/i.test(String((err && err.name) || '') + String((err && err.message) || ''));
      if (aborted || i === tries - 1) throw err;
      await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

function upHeaders(prov) {
  const h = { 'content-type': 'application/json' };
  const key = prov.apiKey || '';
  if (key) {
    if (prov.keyHeader === 'x-api-key') h['x-api-key'] = key;
    else h.Authorization = 'Bearer ' + key;
  }
  if (prov.headers && typeof prov.headers === 'object') Object.assign(h, prov.headers);
  return h;
}

/** Append the key as a query param for providers that want it there (Google). */
function withQueryKey(url, prov) {
  const key = prov.apiKey || '';
  const wantsQuery = prov.keyHeader === 'query' || String(prov.baseUrl || '').includes('generativelanguage.googleapis.com');
  if (!wantsQuery || !key) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}

// ---------------------------------------------------------------------------
// OpenAI chat.completions (native passthrough)
// ---------------------------------------------------------------------------

function buildOpenAIBody(body, wantStream) {
  const out = { model: body.model, stream: !!wantStream, max_tokens: body.max_tokens || 4096 };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  const msgs = [];
  let sys = body.system;
  if (Array.isArray(sys)) sys = sys.map(b => b.text || '').join('\n');
  if (sys) msgs.push({ role: 'system', content: String(sys) });

  for (const m of body.messages || []) {
    const c = m.content;
    if (typeof c === 'string') { msgs.push({ role: m.role, content: c }); continue; }
    if (!Array.isArray(c)) continue;

    if (m.role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const b of c) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        else if (b.type === 'thinking') { /* not translated */ }
      }
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      msgs.push(msg);
      continue;
    }

    const textParts = [];
    for (const b of c) {
      if (b.type === 'text') textParts.push(b.text);
      else if (b.type === 'image' && b.source && b.source.type === 'base64') {
        textParts.push({ type: 'image_url', image_url: { url: 'data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data } });
      } else if (b.type === 'tool_result') {
        if (textParts.length) {
          const hasObj = textParts.some(t => typeof t !== 'string');
          msgs.push({ role: 'user', content: hasObj ? textParts.map(t => (typeof t === 'string' ? { type: 'text', text: t } : t)) : textParts.splice(0).join('\n') });
        }
        let content = b.content;
        if (Array.isArray(content)) content = content.map(x => x.text || '').join('\n');
        msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(content || '') });
      }
    }
    if (textParts.length) {
      const hasObj = textParts.some(t => typeof t !== 'string');
      msgs.push({ role: 'user', content: hasObj ? textParts.map(t => (typeof t === 'string' ? { type: 'text', text: t } : t)) : textParts.join('\n') });
    }
  }
  out.messages = msgs;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
    const tc = body.tool_choice;
    if (tc === 'any' || (tc && tc.type === 'any')) out.tool_choice = 'required';
    else if (tc && tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc === 'none') out.tool_choice = 'none';
    else out.tool_choice = 'auto';
    if (wantStream) out.stream_options = { include_usage: true };
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences[0];
  }
  return out;
}

function callOpenAI(body, prov, wantStream, signal) {
  const out = buildOpenAIBody(body, wantStream);
  let url = openaiBase(prov.baseUrl) + '/chat/completions';
  url = withQueryKey(url, prov);
  return fetchUpstream(url, {
    method: 'POST',
    headers: upHeaders(prov),
    body: JSON.stringify(out),
    signal,
  });
}

// ---------------------------------------------------------------------------
// Shared helpers for synthetic (translated) streams
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Wrap an async iterable of OpenAI chunk objects as a fetch-Response-like SSE. */
function syntheticSse(chunks) {
  async function* bytes() {
    for await (const o of chunks) {
      if (o === DONE) { yield encoder.encode('data: [DONE]\n\n'); continue; }
      yield encoder.encode('data: ' + JSON.stringify(o) + '\n\n');
    }
  }
  return {
    ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: bytes(),
    async text() { let s = ''; for await (const b of bytes()) s += Buffer.from(b).toString('utf8'); return s; },
    async json() { const t = await this.text(); const last = t.trim().split('\n').filter(l => l.startsWith('data: ')).pop(); return JSON.parse(last.slice(6)); },
    _synthetic: true,
  };
}

function syntheticJson(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: null, async text() { return text; }, async json() { return JSON.parse(text); }, _synthetic: true };
}

const DONE = Symbol('done');
const nowId = (p) => 'chatcmpl-' + String(p) + '-' + Date.now().toString(36);

// ---------------------------------------------------------------------------
// OpenAI Responses API (POST /responses)
// ---------------------------------------------------------------------------

function buildResponsesInput(body) {
  let instructions = body.system;
  if (Array.isArray(instructions)) instructions = instructions.map(b => b.text || '').join('\n');
  const input = [];
  for (const m of body.messages || []) {
    const c = m.content;
    if (typeof c === 'string') { input.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: c }] }); continue; }
    if (!Array.isArray(c)) continue;
    if (m.role === 'assistant') {
      let text = '';
      for (const b of c) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input || {}) });
      }
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      continue;
    }
    for (const b of c) {
      if (b.type === 'text') input.push({ role: 'user', content: [{ type: 'input_text', text: b.text }] });
      else if (b.type === 'tool_result') {
        let out = b.content;
        if (Array.isArray(out)) out = out.map(x => x.text || '').join('\n');
        input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: String(out || '') });
      }
    }
  }
  const req = { model: body.model, input, max_output_tokens: body.max_tokens || 4096 };
  if (instructions) req.instructions = String(instructions);
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools.map(t => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } }));
  }
  return req;
}

/** Yield the body chunks, then a newline so a final unterminated SSE line is parsed. */
async function* withFlush(body) {
  for await (const c of body) yield c;
  yield Buffer.from('\n');
}

/** Translate a /responses SSE stream into OpenAI chat.completions chunks. */
async function* responsesChunks(upstream, model) {
  const dec = new TextDecoder();
  let buf = '';
  const toolIdx = new Map();
  let n = 0;
  for await (const chunk of withFlush(upstream.body)) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev; try { ev = JSON.parse(payload); } catch { continue; }
      const type = ev.type || '';
      if (type === 'response.output_text.delta' && ev.delta) {
        yield { id: nowId('resp'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: ev.delta } }] };
      } else if (type === 'response.output_item.added' && ev.item && ev.item.type === 'function_call') {
        const idx = n++;
        toolIdx.set(ev.item.id || ev.item.call_id, idx);
        yield { id: nowId('resp'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: ev.item.call_id || ev.item.id, type: 'function', function: { name: ev.item.name, arguments: '' } }] } }] };
      } else if (type === 'response.function_call_arguments.delta') {
        const idx = toolIdx.get(ev.item_id) != null ? toolIdx.get(ev.item_id) : 0;
        yield { id: nowId('resp'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: ev.delta || '' } }] } }] };
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const u = (ev.response && ev.response.usage) || {};
        const hasTools = n > 0;
        const cut = type === 'response.incomplete';
        yield { id: nowId('resp'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: cut ? 'length' : hasTools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 } };
      }
    }
  }
  yield DONE;
}

async function callResponses(body, prov, wantStream, signal) {
  const req = buildResponsesInput(body);
  req.stream = !!wantStream;
  let url = String(prov.baseUrl || '').replace(/\/+$/, '') + '/responses';
  url = withQueryKey(url, prov);
  const res = await fetchUpstream(url, {
    method: 'POST', headers: upHeaders(prov), body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) return res;
  if (!wantStream) {
    const j = await res.json();
    return syntheticJson(responsesToOpenAI(j, body.model));
  }
  return syntheticSse(responsesChunks(res, body.model));
}

function responsesToOpenAI(j, model) {
  let text = '';
  const toolCalls = [];
  for (const item of j.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) if (c.type === 'output_text') text += c.text;
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
    }
  }
  const msg = { role: 'assistant', content: text || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return {
    id: j.id || nowId('resp'), object: 'chat.completion', model,
    choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: (j.usage && j.usage.input_tokens) || 0, completion_tokens: (j.usage && j.usage.output_tokens) || 0 },
  };
}

// ---------------------------------------------------------------------------
// Gemini generateContent
// ---------------------------------------------------------------------------

function geminiBase(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  // Google AI Studio OpenAI-compat URL should never reach here (protocol openai).
  if (/\/v1beta$/.test(base)) return base;
  if (/\/v1$/.test(base)) return base;
  return base + '/v1beta';
}

function buildGeminiBody(body) {
  const contents = [];
  let systemText = body.system;
  if (Array.isArray(systemText)) systemText = systemText.map(b => b.text || '').join('\n');
  for (const m of body.messages || []) {
    const c = m.content;
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof c === 'string') { contents.push({ role, parts: [{ text: c }] }); continue; }
    if (!Array.isArray(c)) continue;
    const parts = [];
    for (const b of c) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      else if (b.type === 'tool_result') {
        let out = b.content;
        if (Array.isArray(out)) out = out.map(x => x.text || '').join('\n');
        parts.push({ functionResponse: { name: b.name || b.tool_use_id, response: { output: String(out || '') } } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  const req = { contents };
  if (systemText) req.systemInstruction = { parts: [{ text: String(systemText) }] };
  const gen = {};
  if (body.max_tokens) gen.maxOutputTokens = body.max_tokens;
  if (body.temperature != null) gen.temperature = body.temperature;
  if (body.top_p != null) gen.topP = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) gen.stopSequences = body.stop_sequences;
  if (Object.keys(gen).length) req.generationConfig = gen;
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = [{ functionDeclarations: body.tools.map(t => ({ name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } })) }];
  }
  return req;
}

async function* geminiChunks(upstream, model) {
  const dec = new TextDecoder();
  let buf = '';
  let n = 0;
  for await (const chunk of withFlush(upstream.body)) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev; try { ev = JSON.parse(payload); } catch { continue; }
      const cand = (ev.candidates || [])[0];
      if (!cand) {
        if (ev.usageMetadata) yield { id: nowId('gem'), object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: ev.usageMetadata.promptTokenCount || 0, completion_tokens: ev.usageMetadata.candidatesTokenCount || 0 } };
        continue;
      }
      const parts = (cand.content && cand.content.parts) || [];
      for (const p of parts) {
        if (p.text) yield { id: nowId('gem'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: p.text } }] };
        if (p.functionCall) {
          const idx = n++;
          yield { id: nowId('gem'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: 'call_' + idx + '_' + Date.now(), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }] } }] };
        }
      }
      if (cand.finishReason) {
        if (cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
          yield { id: nowId('gem'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: '\n\n[response stopped by provider: ' + cand.finishReason + ']' } }] };
        }
        const fr = cand.finishReason === 'MAX_TOKENS' ? 'length' : (n > 0 ? 'tool_calls' : 'stop');
        yield { id: nowId('gem'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: fr }] };
      }
    }
  }
  yield DONE;
}

async function callGemini(body, prov, wantStream, signal) {
  const req = buildGeminiBody(body);
  const base = geminiBase(prov.baseUrl);
  const method = wantStream ? 'streamGenerateContent' : 'generateContent';
  let url = base + '/models/' + encodeURIComponent(body.model) + ':' + method;
  if (wantStream) url += '?alt=sse';
  url = withQueryKey(url, prov);
  const res = await fetchUpstream(url, {
    method: 'POST', headers: upHeaders(prov), body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) return res;
  if (!wantStream) return syntheticJson(geminiToOpenAI(await res.json(), body.model));
  return syntheticSse(geminiChunks(res, body.model));
}

function geminiToOpenAI(j, model) {
  const cand = (j.candidates || [])[0] || {};
  const parts = (cand.content && cand.content.parts) || [];
  let text = '';
  const toolCalls = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) toolCalls.push({ id: 'call_' + toolCalls.length + '_' + Date.now(), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } });
  }
  const msg = { role: 'assistant', content: text || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return {
    id: nowId('gem'), object: 'chat.completion', model,
    choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: (j.usageMetadata && j.usageMetadata.promptTokenCount) || 0, completion_tokens: (j.usageMetadata && j.usageMetadata.candidatesTokenCount) || 0 },
  };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/** Route a translated /v1/messages call to the right upstream protocol. */
function callUpstream(prov, body, wantStream, signal) {
  const protocol = prov.protocol || 'openai';
  if (protocol === 'openai-responses') return callResponses(body, prov, wantStream, signal);
  if (protocol === 'gemini') return callGemini(body, prov, wantStream, signal);
  return callOpenAI(body, prov, wantStream, signal);
}

/** Model list for an adapter-managed provider (used by the proxy GET path). */
async function listModels(prov) {
  if ((prov.protocol || 'openai') === 'gemini') {
    const url = withQueryKey(geminiBase(prov.baseUrl) + '/models', prov);
    const r = await fetchUpstream(url, { headers: upHeaders(prov) }, AbortSignal.timeout(15000));
    if (!r.ok) return r;
    const j = await r.json();
    const data = (j.models || []).map(m => ({ id: String(m.name || '').replace(/^models\//, ''), context_length: m.inputTokenLimit || null }));
    return syntheticJson({ data });
  }
  const url = openaiBase(prov.baseUrl) + '/models';
  return fetchUpstream(url, { headers: upHeaders(prov) }, AbortSignal.timeout(15000));
}

module.exports = {
  callUpstream, listModels, openaiBase, upHeaders, withQueryKey, fetchUpstream,
  buildOpenAIBody, buildResponsesInput, buildGeminiBody,
  responsesToOpenAI, geminiToOpenAI, syntheticSse, DONE, responsesChunks, geminiChunks,
};
