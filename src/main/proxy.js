// Built-in protocol translator: exposes Anthropic Messages API endpoints that
// transparently proxy to OpenAI-compatible providers (Mistral, Groq, Google AI
// Studio, Cloudflare Workers AI, NaraRouter, Ollama's /openai, …). This is what
// lets the claude engine use key-only OpenAI-format providers.
'use strict';
const http = require('http');

const CCE_PROXY_PORT = Number(process.env.CCE_PROXY_PORT || 8199);

function startProxy(resolveProvider) {
  // resolveProvider(uid) -> { baseUrl, apiKey } | null
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const m = url.pathname.match(/^\/px\/([a-z0-9]+)\/(.+)$/i);
    if (!m) { res.writeHead(404).end(); return; }
    const uid = m[1];
    const restPath = '/' + m[2];
    const isGet = req.method === 'GET';
    if (process.env.CCE_SMOKE) console.log('[proxy] ' + req.method + ' ' + url.pathname + (url.search || ''));
    const prov = resolveProvider(uid);
    if (!prov || !prov.baseUrl) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown proxy provider' })); return; }
    if (isGet && restPath === '/v1/models') {
      fetch(prov.baseUrl.replace(/\/+$/, '') + '/models', { headers: upHeaders(prov) })
        .then(async (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); })
        .catch((e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      handleTranslated(restPath, raw, prov, res).catch((err) => {
        if (process.env.CCE_SMOKE) console.log('[proxy] TRANSLATE ERR ' + String((err && err.stack) || err).slice(0, 300));
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        try { res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String((err && err.message) || err) } })); } catch { /* socket gone */ }
      });
    });
  });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      // Port taken (e.g. second app instance) — this instance won't host the
      // proxy; chats will only work for native-Anthropic providers.
      console.error('[proxy] port', CCE_PROXY_PORT, 'unavailable:', String(err.message || err));
      resolve({ port: null, server });
    });
    server.listen(CCE_PROXY_PORT, '127.0.0.1', () => {
      console.log('[proxy] anthropic⇄openai translator on http://127.0.0.1:' + CCE_PROXY_PORT);
      resolve({ port: CCE_PROXY_PORT, server });
    });
  });
}

async function handleTranslated(restPath, raw, prov, res) {
  const dbg = (m) => { if (process.env.CCE_SMOKE) console.log('[proxy] ' + m); };
  dbg('translate ' + restPath + ' bytes=' + raw.length);

  let body;
  try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } })); return; }

  // The engine probes this handshake endpoint and counts prompt tokens; both
  // must answer or it retries in a tight loop. Token count is an estimate.
  if (restPath === '/api/hello') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  if (restPath === '/v1/messages/count_tokens') {
    const est = Math.max(1, Math.round(JSON.stringify(body.messages || []).length / 4)
      + Math.round(JSON.stringify(body.system || '').length / 4));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: est }));
    return;
  }
  if (restPath !== '/v1/messages') {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unsupported path ' + restPath }));
    return;
  }

  const wantStream = !!body.stream;
  const upstream = await callOpenAI(body, prov, wantStream);

  if (!upstream.ok) {
    const text = await upstream.text();
    let msg = text.slice(0, 500), code = upstream.status;
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.code)) || j.message || msg; } catch { /* keep raw */ }
    dbg('upstream HTTP ' + upstream.status + ' -> ' + String(msg).slice(0, 200));
    res.writeHead(upstream.status === 401 ? 401 : 502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: upstream.status === 401 ? 'authentication_error' : 'api_error', message: msg } }));
    return;
  }

  if (!wantStream) {
    const j = await upstream.json();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(aggregateToAnthropic(j, body)));
    return;
  }

  // Streamed: translate upstream SSE to Anthropic SSE
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const sse = (event, data) => {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  };
  sse('message_start', { type: 'message_start', message: { id: 'msg_proxy', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });

  const decoder = new TextDecoder();
  let buf = '';
  let reasonBuf = '';
  let blockOpen = false;   // a content_block is currently open
  let blockIdx = -1;
  let blockType = null;    // 'text' | 'tool_use'
  let outTokens = 0;
  let stopReason = 'end_turn';
  const toolBuf = new Map();   // openai tool_call index -> {id, name, args}

  const openBlock = (b) => { blockIdx++; blockOpen = true; blockType = b; sse('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: b }); };
  const closeBlock = () => { if (blockOpen) { blockOpen = false; sse('content_block_stop', { type: 'content_block_stop', index: blockIdx }); } };
  // Anthropic content blocks are strictly sequential, but OpenAI interleaves
  // argument chunks across parallel tool calls — emit each call whole, in order.
  const flushTools = () => {
    for (const [, t] of [...toolBuf].sort((a, b) => a[0] - b[0])) {
      if (!t.name) continue;
      closeBlock();
      openBlock({ type: 'tool_use', id: t.id, name: t.name });
      sse('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: t.args || '{}' } });
      stopReason = 'tool_use';
    }
    toolBuf.clear();
  };

  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const choice = (j.choices || [])[0];
        if (!choice) continue;
        const d = choice.delta || {};
        if (d.content) {
          if (!blockOpen || blockType !== 'text') { closeBlock(); openBlock({ type: 'text', text: '' }); }
          outTokens++;
          sse('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: d.content } });
        }
        if (d.reasoning || d.reasoning_content) {
          // Tool-tuned models (e.g. Qwen3-toolcall via Ollama) emit tool calls
          // as <tool_call>{json}</tool_call> inside the reasoning channel.
          reasonBuf += (d.reasoning || '') + (d.reasoning_content || '');
          let m2;
          while ((m2 = reasonBuf.match(/<tool_call>([\s\S]*?)<\/tool_call>/))) {
            reasonBuf = reasonBuf.slice(reasonBuf.indexOf(m2[0]) + m2[0].length);
            let parsed = null;
            try { parsed = JSON.parse(m2[1].trim()); } catch { /* partial/invalid */ }
            const fname = parsed && parsed.name;
            if (!fname) continue;
            closeBlock();
            stopReason = 'tool_use';
            openBlock({ type: 'tool_use', id: 'call_' + blockIdx + '_' + Date.now(), name: fname });
            const args = parsed.arguments != null ? (typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments)) : '{}';
            sse('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: args } });
          }
        }
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const k = tc.index != null ? tc.index : toolBuf.size;
            const cur = toolBuf.get(k) || { id: tc.id || ('call_' + k + '_' + Date.now()), name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name = tc.function.name;
            if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
            toolBuf.set(k, cur);
          }
        }
        if (choice.finish_reason) {
          stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
          flushTools();
        }
        if (j.usage && j.usage.completion_tokens) outTokens = j.usage.completion_tokens;
      }
    }
  } catch (err) {
    closeBlock();
    sse('error', { type: 'error', error: { type: 'api_error', message: String((err && err.message) || err) } });
  }
  flushTools();   // tool calls buffered for sequential emission (no finish_reason seen)
  closeBlock();
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outTokens } });
  sse('message_stop', { type: 'message_stop' });
  res.end();
}

function upHeaders(prov) {
  const h = { 'content-type': 'application/json' };
  if (prov.apiKey) h.Authorization = 'Bearer ' + prov.apiKey;
  return h;
}

async function callOpenAI(body, prov, wantStream) {
  // --- translate Anthropic Messages -> OpenAI chat.completions ---
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

    // user message: split text parts and tool_results (tool role must follow the assistant tool_calls)
    const textParts = [];
    for (const b of c) {
      if (b.type === 'text') textParts.push(b.text);
      else if (b.type === 'image' && b.source && b.source.type === 'base64') {
        textParts.push({ type: 'image_url', image_url: { url: 'data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data } });
      } else if (b.type === 'tool_result') {
        if (textParts.length) { msgs.push({ role: 'user', content: textParts.splice(0) }); }
        let content = b.content;
        if (Array.isArray(content)) content = content.map(x => x.text || '').join('\n');
        msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(content || '') });
      }
    }
    if (textParts.length) {
      // OpenAI user content = plain string, or an array of *objects*.
      // Bare string arrays are rejected (Mistral 422: "should be a valid string").
      const hasObj = textParts.some(t => typeof t !== 'string');
      const content = hasObj
        ? textParts.map(t => (typeof t === 'string' ? { type: 'text', text: t } : t))
        : textParts.join('\n');
      msgs.push({ role: 'user', content });
    }
  }
  out.messages = msgs;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
    out.tool_choice = 'auto';
  }

  let url = prov.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  // Google's OpenAI-compatible endpoint rejects Bearer-only auth on chat
  // completions — it wants the key in the query string.
  if (prov.baseUrl.includes('generativelanguage.googleapis.com')) {
    url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(prov.apiKey || '');
  }
  return fetch(url, {
    method: 'POST',
    headers: upHeaders(prov),
    body: JSON.stringify(out),
    // Covers the whole stream, not just the first byte — 5min cut long agent
    // turns on slow local/cloud models mid-response.
    signal: AbortSignal.timeout(900_000),
  });
}

function aggregateToAnthropic(j, body) {
  const choice = (j.choices || [])[0] || {};
  const m = choice.message || {};
  if (m.content && m.content.includes('<tool_call>')) {
    // tool-call-in-reasoning style (Qwen3-toolcall etc.)
    for (const mm of m.content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
      try {
        const p = JSON.parse(mm[1].trim());
        if (p && p.name) (m.tool_calls = m.tool_calls || []).push({
          id: 'call_agg_' + (m.tool_calls || []).length, type: 'function',
          function: { name: p.name, arguments: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {}) },
        });
      } catch { /* skip invalid */ }
    }
    m.content = m.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
  }
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* keep {} */ }
    content.push({ type: 'tool_use', id: tc.id || ('call_' + content.length), name: tc.function.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const stop = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: j.id || 'chatcmpl-proxy',
    type: 'message',
    role: 'assistant',
    model: j.model || body.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: (j.usage && j.usage.prompt_tokens) || 0,
      output_tokens: (j.usage && j.usage.completion_tokens) || 0,
    },
  };
}

module.exports = { startProxy, CCE_PROXY_PORT };
