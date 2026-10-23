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
const { parsedDataEvents } = require('./sse');
const bedrock = require('./bedrock.js');
const modelsdev = require('./modelsdev.js');
const { modelCaps } = require('./modelcontext.js');

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
const providerCooldown = new Map();

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
        const maxWait = res.status === 429 ? 60 : 15;
        const wait = Number.isFinite(ra) && res.headers.get('retry-after') !== null ? Math.min(ra, maxWait) * 1000 : 1000 * (2 * rateTries + 1);
        if (res.status === 429) {
          try {
            const host = new URL(url).host;
            providerCooldown.set(host, Date.now() + wait);
          } catch { /* ignore */ }
        }
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

const isGoogle = (prov) => String((prov && prov.baseUrl) || '').includes('generativelanguage.googleapis.com');
/** Google's native route reads the key from x-goog-api-key and 401s on any Authorization header. */
const usesGoogHeader = (prov) => prov.keyHeader === 'x-goog-api-key' || (prov.protocol === 'gemini' && isGoogle(prov));

/** Effort Google accepts ('' = send none); derived from the thinking budget when no effort is set. */
function googleEffort(body) {
  const e = String((body.output_config && body.output_config.effort) || body.reasoning_effort || body.effort || '').toLowerCase();
  if (e === 'xhigh' || e === 'max') return 'high';
  if (['none', 'minimal', 'low', 'medium', 'high'].includes(e)) return e;
  if (e) return '';
  const b = body.thinking && body.thinking.budget_tokens;
  if (b == null) return '';
  return b <= 1024 ? 'minimal' : b <= 4096 ? 'low' : b <= 16384 ? 'medium' : 'high';
}

function upHeaders(prov) {
  const h = { 'content-type': 'application/json' };
  // Gateways that fingerprint the client (OpenCode Go) reject a request with
  // no User-Agent at all, and their docs ask for a client-identifying name
  // rather than a generic SDK string. Node's default ("node") is generic, so
  // name the app; a provider can still override it with its own header.
  if (!h['user-agent'] && !prov.headers?.['user-agent']) {
    h['user-agent'] = 'claude-code-enhanced/' + (prov.appVersion || '0.9.32') + ' (Electron)';
  }
  const key = prov.apiKey || '';
  if (key) {
    if (prov.keyHeader === 'x-api-key') h['x-api-key'] = key;
    else if (usesGoogHeader(prov)) h['x-goog-api-key'] = key;
    else h.Authorization = 'Bearer ' + key;
  }
  if (prov.headers && typeof prov.headers === 'object') Object.assign(h, prov.headers);
  // Session identity, when the proxy resolved one (see proxy.js
  // sessionHeaders). Applied last so a user-supplied header still wins.
  if (prov.sessionHeaders && typeof prov.sessionHeaders === 'object') {
    for (const [k, v] of Object.entries(prov.sessionHeaders)) if (!h[k]) h[k] = v;
  }
  return h;
}

/** Append the key as a query param for providers that want it there (Google). */
function withQueryKey(url, prov) {
  const key = prov.apiKey || '';
  const wantsQuery = prov.keyHeader === 'query' || (isGoogle(prov) && !usesGoogHeader(prov));
  if (!wantsQuery || !key) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}

// ---------------------------------------------------------------------------
// OpenAI chat.completions (native passthrough)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// request hygiene shared by every dialect
// ---------------------------------------------------------------------------

/** JSON-schema keys no non-Anthropic API accepts in a tool's parameters. */
const DROP_ALWAYS = new Set(['$schema', '$id', '$comment', 'definitions', '$defs']);
/** Extra keys Google's function-declaration schema rejects with a 400. */
const DROP_GEMINI = new Set([
  'additionalProperties', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'patternProperties',
  'unevaluatedProperties', 'if', 'then', 'else', 'not', 'contentEncoding', 'contentMediaType', 'examples',
  'default', 'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas',
]);
/** `format` values Gemini accepts on a string; any other format is a 400. */
const GEMINI_FORMATS = new Set(['enum', 'date-time']);

/**
 * Make an Anthropic tool input_schema acceptable to the target API. MCP and
 * plugin tools carry the full JSON-schema vocabulary (`$schema`,
 * `additionalProperties`, `const`, `["string","null"]`...), which strict
 * servers reject: Gemini 400s on most of it, and some OpenAI-compatible
 * servers on `$schema`. The input is never mutated.
 */
function sanitizeSchema(schema, dialect = 'openai') {
  const gemini = dialect === 'gemini';
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROP_ALWAYS.has(k) || (gemini && DROP_GEMINI.has(k))) continue;
      if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
        // property NAMES are user data: sanitize their schemas, never the keys
        out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, walk(sub)]));
        continue;
      }
      out[k] = walk(v);
    }
    if (gemini) {
      if (Object.prototype.hasOwnProperty.call(out, 'const')) { out.enum = [out.const]; delete out.const; }
      if (Array.isArray(out.type)) {
        const kinds = out.type.filter((t) => t !== 'null');
        if (out.type.includes('null')) out.nullable = true;
        out.type = kinds[0] || 'string';
      }
      for (const key of ['anyOf', 'oneOf']) {
        if (Array.isArray(out[key])) {
          // Gemini supports anyOf only; collapse a nullable pair to the real type
          const real = out[key].filter((x) => !(x && x.type === 'null'));
          if (real.length === 1 && typeof real[0] === 'object') { Object.assign(out, real[0]); if (real.length !== out[key].length) out.nullable = true; delete out[key]; }
          else if (key === 'oneOf') { out.anyOf = out.oneOf; delete out.oneOf; }
        }
      }
      if (typeof out.format === 'string' && !GEMINI_FORMATS.has(out.format)) delete out.format;
      if (Array.isArray(out.enum)) out.enum = out.enum.map(String);
      if (out.type === 'object' && out.properties && Array.isArray(out.required)) {
        out.required = out.required.filter((r) => Object.prototype.hasOwnProperty.call(out.properties, r));
        if (!out.required.length) delete out.required;
      }
    }
    return out;
  };
  const clean = walk(schema && typeof schema === 'object' ? schema : {});
  if (!clean.type && !clean.anyOf) clean.type = 'object';
  if (clean.type === 'object' && !clean.properties) clean.properties = {};
  return clean;
}

/**
 * Per-model request limits from the catalog. Only an explicit "no" changes a
 * request (a model that is not catalogued keeps today's behaviour).
 */
function capsFor(prov, model) {
  try { return modelCaps(prov, model); } catch { return { reasoning: null, vision: null, tools: null, maxOutput: 0 }; }
}

/** Images inside a tool_result: [{media_type, data}], in order. */
function toolResultImages(b) {
  const out = [];
  if (Array.isArray(b && b.content)) {
    for (const x of b.content) {
      if (x && x.type === 'image' && x.source && x.source.type === 'base64' && x.source.data) {
        out.push({ media_type: x.source.media_type || 'image/png', data: x.source.data });
      }
    }
  }
  return out;
}

const NO_VISION_NOTE = '[image omitted: this model cannot read images]';

function buildOpenAIBody(body, wantStream, prov) {
  const caps = capsFor(prov, body.model);
  let maxTokens = body.max_tokens || 4096;
  // A request above the model's output limit is a 400 on most providers.
  if (caps.maxOutput > 0 && maxTokens > caps.maxOutput) maxTokens = caps.maxOutput;
  const out = { model: body.model, stream: !!wantStream, max_tokens: maxTokens };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (caps.reasoning === false) {
    // A model the catalog marks as non-reasoning rejects (or ignores) effort
    // and thinking budgets: send neither.
  } else if (prov && isGoogle(prov)) {
    // Google 400s on `reasoning` and on efforts outside its enum.
    const eff = googleEffort(body);
    if (eff) out.reasoning_effort = eff;
  } else {
    if (body.reasoning_effort) out.reasoning_effort = body.reasoning_effort;
    else if (body.effort) out.reasoning_effort = body.effort;
    if (body.thinking && body.thinking.budget_tokens != null) {
      out.reasoning = { max_tokens: body.thinking.budget_tokens };
    }
  }
  const msgs = [];
  let sys = body.system;
  if (Array.isArray(sys)) sys = sys.map(b => b.text || '').join('\n');
  if (sys) msgs.push({ role: 'system', content: String(sys) });

  // The engine also sends `system` messages in the middle of the conversation
  // (its environment block). OpenAI-format providers accept a system message
  // only at the start, so those are gathered into the opening one.
  const lateSystem = [];
  for (const m of body.messages || []) {
    const c = m.content;
    if (m.role === 'system') {
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b && b.text) || '').join('\n') : '';
      if (t.trim()) lateSystem.push(t);
      continue;
    }
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
      // Reasoning that leaked into an earlier reply must not be replayed as if
      // the model had said it out loud.
      text = splitThink(text).text;
      // A turn that was only thinking has nothing to send; an assistant message
      // with neither content nor tool calls is a 400 on most providers.
      if (!text && !toolCalls.length) continue;
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      msgs.push(msg);
      continue;
    }

    // Tool results go out first: OpenAI requires every `tool` message to follow
    // its assistant tool_calls directly, so text that came before a result in
    // the same Anthropic message has to wait until all results are in.
    const textParts = [];
    const imgPart = (media, data) => (caps.vision === false
      ? NO_VISION_NOTE
      : { type: 'image_url', image_url: { url: 'data:' + (media || 'image/png') + ';base64,' + data } });
    for (const b of c) {
      if (b.type === 'text') textParts.push(b.text);
      else if (b.type === 'image' && b.source && b.source.type === 'base64') {
        textParts.push(imgPart(b.source.media_type, b.source.data));
      } else if (b.type === 'tool_result') {
        msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b) });
        // The `tool` role is text-only; an image a tool returned (Read of a
        // PNG, a screenshot tool) reaches the model as a user turn right after.
        for (const im of toolResultImages(b)) textParts.push(imgPart(im.media_type, im.data));
      }
    }
    if (textParts.length) {
      const hasObj = textParts.some(t => typeof t !== 'string');
      msgs.push({ role: 'user', content: hasObj ? textParts.map(t => (typeof t === 'string' ? { type: 'text', text: t } : t)) : textParts.join('\n') });
    }
  }
  if (lateSystem.length) {
    if (msgs[0] && msgs[0].role === 'system') msgs[0].content += '\n\n' + lateSystem.join('\n\n');
    else msgs.unshift({ role: 'system', content: lateSystem.join('\n\n') });
  }
  out.messages = msgs;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: sanitizeSchema(t.input_schema, 'openai') },
    }));
    const tc = body.tool_choice;
    if (tc === 'any' || (tc && tc.type === 'any')) out.tool_choice = 'required';
    else if (tc && tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc === 'none' || (tc && tc.type === 'none')) out.tool_choice = 'none';
    else out.tool_choice = 'auto';
  }
  // Both apply with or without tools: summaries and titles are tool-less calls
  // and still need real token counts and their stop sequences.
  if (wantStream) out.stream_options = { include_usage: true };
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences.slice(0, 4);
  return out;
}

/** Text of an Anthropic tool_result block; never empty (providers reject that). */
function toolResultText(b) {
  let content = b.content;
  if (Array.isArray(content)) {
    content = content.map((x) => {
      if (!x) return '';
      if (x.type === 'image') return '[image]';
      // ToolSearch answers with references, which the engine expands into real
      // tool definitions on the next request. Read as text they were empty, and
      // the model thought the load had failed.
      if (x.type === 'tool_reference') return 'Loaded tool ' + (x.tool_name || x.name || '') + ' — you can call it now.';
      return x.text || '';
    }).filter(Boolean).join('\n');
  }
  content = String(content == null ? '' : content);
  if (!content.trim()) content = b.is_error ? '(the tool failed with no output)' : '(no output)';
  return content;
}

const { splitThink } = require('../shared/think.js');

function callOpenAI(body, prov, wantStream, signal) {
  const out = buildOpenAIBody(body, wantStream, prov);
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

function buildResponsesInput(body, prov) {
  const caps = capsFor(prov, body.model);
  let instructions = body.system;
  if (Array.isArray(instructions)) instructions = instructions.map(b => b.text || '').join('\n');
  const lateSystem = [];
  const input = [];
  for (const m of body.messages || []) {
    const c = m.content;
    if (m.role === 'system') {
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b && b.text) || '').join('\n') : '';
      if (t.trim()) lateSystem.push(t);
      continue;
    }
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
      else if (b.type === 'image' && b.source && b.source.type === 'base64') {
        input.push(caps.vision === false
          ? { role: 'user', content: [{ type: 'input_text', text: NO_VISION_NOTE }] }
          : { role: 'user', content: [{ type: 'input_image', image_url: 'data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data }] });
      } else if (b.type === 'tool_result') {
        input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: toolResultText(b) });
        const imgs = toolResultImages(b);
        if (imgs.length) {
          input.push({ role: 'user', content: imgs.map((im) => (caps.vision === false
            ? { type: 'input_text', text: NO_VISION_NOTE }
            : { type: 'input_image', image_url: 'data:' + im.media_type + ';base64,' + im.data })) });
        }
      }
    }
  }
  let maxOut = body.max_tokens || 4096;
  if (caps.maxOutput > 0 && maxOut > caps.maxOutput) maxOut = caps.maxOutput;
  const req = { model: body.model, input, max_output_tokens: maxOut };
  if (lateSystem.length) instructions = (instructions ? instructions + '\n\n' : '') + lateSystem.join('\n\n');
  if (instructions) req.instructions = String(instructions);
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (caps.reasoning !== false && (body.effort || body.reasoning_effort)) req.reasoning = { effort: body.effort || body.reasoning_effort };
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools.map(t => ({ type: 'function', name: t.name, description: t.description || '', parameters: sanitizeSchema(t.input_schema, 'openai') }));
  }
  return req;
}

/** Translate a /responses SSE stream into OpenAI chat.completions chunks. */
async function* responsesChunks(upstream, model) {
  const toolIdx = new Map();
  let n = 0;
  for await (const ev of parsedDataEvents(upstream.body)) {
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
  yield DONE;
}

async function callResponses(body, prov, wantStream, signal) {
  const req = buildResponsesInput(body, prov);
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

// Gemini 3 returns a `thoughtSignature` with each function call and rejects
// the next request (400) unless the same signature is sent back on that call.
// The engine only round-trips the tool-call id, so remember signature by id.
const thoughtSignatures = new Map();
const MAX_SIGNATURES = 500;
function rememberSignature(id, sig) {
  if (!id || !sig) return;
  thoughtSignatures.set(id, sig);
  while (thoughtSignatures.size > MAX_SIGNATURES) thoughtSignatures.delete(thoughtSignatures.keys().next().value);
}

function buildGeminiBody(body, prov) {
  const caps = capsFor(prov, body.model);
  const contents = [];
  let systemText = body.system;
  if (Array.isArray(systemText)) systemText = systemText.map(b => b.text || '').join('\n');
  const toolNameById = new Map();
  for (const m of body.messages || []) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_use' && b.id && b.name) toolNameById.set(b.id, b.name);
      }
    }
  }
  for (const m of body.messages || []) {
    const c = m.content;
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof c === 'string') { contents.push({ role, parts: [{ text: c }] }); continue; }
    if (!Array.isArray(c)) continue;
    const parts = [];
    for (const b of c) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image' && b.source && b.source.type === 'base64') {
        parts.push(caps.vision === false ? { text: NO_VISION_NOTE }
          : { inlineData: { mimeType: b.source.media_type || 'image/png', data: b.source.data } });
      } else if (b.type === 'tool_use') {
        const part = { functionCall: { name: b.name, args: b.input || {} } };
        // A resumed session has no remembered signature; Google documents this
        // sentinel for history that did not come from the current process.
        const sig = thoughtSignatures.get(b.id)
          || (prov && isGoogle(prov) && /gemini-3/i.test(String(body.model)) ? 'skip_thought_signature_validator' : '');
        if (sig) part.thoughtSignature = sig;
        parts.push(part);
      } else if (b.type === 'tool_result') {
        const fname = b.name || toolNameById.get(b.tool_use_id) || b.tool_use_id || 'tool';
        parts.push({ functionResponse: { name: fname, response: { output: toolResultText(b) } } });
        for (const im of toolResultImages(b)) {
          parts.push(caps.vision === false ? { text: NO_VISION_NOTE } : { inlineData: { mimeType: im.media_type, data: im.data } });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  const req = { contents };
  if (systemText) req.systemInstruction = { parts: [{ text: String(systemText) }] };
  const gen = {};
  if (body.max_tokens) gen.maxOutputTokens = caps.maxOutput > 0 ? Math.min(body.max_tokens, caps.maxOutput) : body.max_tokens;
  if (body.temperature != null) gen.temperature = body.temperature;
  if (body.top_p != null) gen.topP = body.top_p;
  if (prov && isGoogle(prov)) {
    // Google: budget 1..24576, or a level, never both.
    const b = body.thinking && body.thinking.budget_tokens;
    const lvl = googleEffort({ ...body, thinking: undefined });
    if (caps.reasoning === false) { /* the model has no thinking to configure */ }
    else if (b > 0) gen.thinkingConfig = { thinkingBudget: Math.min(b, 24576) };
    else if (b == null && lvl && lvl !== 'none') gen.thinkingConfig = { thinkingLevel: lvl };
  } else if (caps.reasoning !== false && body.thinking && body.thinking.budget_tokens != null) {
    gen.thinkingConfig = { thinkingBudget: body.thinking.budget_tokens };
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) gen.stopSequences = body.stop_sequences;
  if (Object.keys(gen).length) req.generationConfig = gen;
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = [{ functionDeclarations: body.tools.map(t => ({ name: t.name, description: t.description || '', parameters: sanitizeSchema(t.input_schema, 'gemini') })) }];
  }
  return req;
}

async function* geminiChunks(upstream, model) {
  let n = 0;
  for await (const ev of parsedDataEvents(upstream.body)) {
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
        const callId = 'call_' + idx + '_' + Date.now();
        rememberSignature(callId, p.thoughtSignature);
        yield { id: nowId('gem'), object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: callId, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }] } }] };
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
  yield DONE;
}

async function callGemini(body, prov, wantStream, signal) {
  const req = buildGeminiBody(body, prov);
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
    if (p.functionCall) {
      const id = 'call_' + toolCalls.length + '_' + Date.now();
      rememberSignature(id, p.thoughtSignature);
      toolCalls.push({ id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } });
    }
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
  if (bedrock.isBedrockUrl(prov.baseUrl) || prov.protocol === 'bedrock') {
    const cat = modelsdev.modelsFor(prov.presetId || prov.modelsDevId || 'amazon-bedrock').map(m => ({
      id: m.id, context_length: (m.limit && m.limit.context) || null, catalog: true,
    }));
    return syntheticJson({ data: cat });
  }
  if ((prov.protocol || 'openai') === 'gemini') {
    try {
      const url = withQueryKey(geminiBase(prov.baseUrl) + '/models', prov);
      const r = await fetchUpstream(url, { headers: upHeaders(prov) }, AbortSignal.timeout(15000));
      if (r.ok) {
        const j = await r.json();
        const data = (j.models || []).map(m => ({ id: String(m.name || '').replace(/^models\//, ''), context_length: m.inputTokenLimit || null }));
        return syntheticJson({ data });
      }
    } catch {}
    const cat = modelsdev.modelsFor(prov.presetId || prov.modelsDevId || 'google').map(m => ({
      id: m.id, context_length: (m.limit && m.limit.context) || null, catalog: true,
    }));
    if (cat.length) return syntheticJson({ data: cat });
    return syntheticJson({ data: [] });
  }
  const url = openaiBase(prov.baseUrl) + '/models';
  try {
    const r = await fetchUpstream(url, { headers: upHeaders(prov) }, AbortSignal.timeout(15000));
    if (r.ok) return r;
  } catch {}
  const targetId = prov.presetId || prov.modelsDevId || prov.id;
  if (targetId) {
    const cat = modelsdev.modelsFor(targetId).map(m => ({
      id: m.id, context_length: (m.limit && m.limit.context) || null, catalog: true,
    }));
    if (cat.length) return syntheticJson({ data: cat });
  }
  return syntheticJson({ data: [] });
}

module.exports = {
  callUpstream, listModels, openaiBase, upHeaders, withQueryKey, fetchUpstream,
  providerCooldown,
  buildOpenAIBody, buildResponsesInput, buildGeminiBody, splitThink, sanitizeSchema, thoughtSignatures,
  responsesToOpenAI, geminiToOpenAI, syntheticSse, DONE, responsesChunks, geminiChunks,
};
