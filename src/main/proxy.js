// Built-in protocol translator: exposes Anthropic Messages API endpoints that
// transparently proxy to OpenAI-compatible providers (Mistral, Groq, Google AI
// Studio, Cloudflare Workers AI, NaraRouter, Ollama's /openai, …). This is what
// lets the claude engine use key-only OpenAI-format providers.
'use strict';
const { setBounded } = require('./boundedmap');
const http = require('http');
const crypto = require('crypto');
const adapters = require('./adapters');
const { wrapToolNames } = require('./toolnames');
const { resolveToolName, callSignature, repairToolArgs, requiresArgs } = require('./toolcalls');
const { openaiBase } = adapters;
const { sseLines } = require('./sse');
const tokencount = require('./tokencount');

// A model that thinks for a minute sends nothing for a minute, and the engine
// reads a silent stream as a dead one (its idle timeout). A ping is an SSE
// event the engine ignores, so it only proves the proxy is alive.
const KEEPALIVE_MS = Number(process.env.CCE_KEEPALIVE_MS) > 0 ? Number(process.env.CCE_KEEPALIVE_MS) : 15_000;
function startKeepAlive(res, ms = KEEPALIVE_MS) {
  const t = setInterval(() => {
    if (res.writableEnded || res.destroyed) { clearInterval(t); return; }
    try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); } catch { clearInterval(t); }
  }, ms);
  if (t.unref) t.unref();
  const stop = () => clearInterval(t);
  res.on('close', stop);
  res.on('finish', stop);
  return stop;
}

// Port 0 = ask the OS for a free port. A fixed 8199 collides with any other
// listener and, before #8, exposed provider keys to that process.
const CCE_PROXY_PORT = Number(process.env.CCE_PROXY_PORT || 0);

function startProxy(resolveProvider, opts = {}) {
  // resolveProvider(uid) -> { baseUrl, apiKey } | null
  const token = opts.token || null;
  const port = opts.port || Number(process.env.CCE_PROXY_PORT || 0);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const m = url.pathname.match(/^\/px\/([a-z0-9]+)\/(.+)$/i);
    if (!m) { res.writeHead(404).end(); return; }
    const uid = m[1];
    const restPath = '/' + m[2];
    const isGet = req.method === 'GET';
    if (process.env.CCE_SMOKE) console.log('[proxy] ' + req.method + ' ' + url.pathname + (url.search || ''));
    // Auth: the proxy forwards with the provider's real credentials, so an
    // unauthenticated local listener is a credential-exfiltration and
    // spend-your-money hole. #8
    if (token && !isTokenValid(req, token)) {
      res.writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'proxy token required' } }));
      return;
    }
    // May be async: an expired OAuth token is refreshed before the request goes out.
    let prov = null;
    try { prov = await resolveProvider(uid); } catch { prov = null; }
    if (!prov || !prov.baseUrl) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown proxy provider' })); return; }
    prov._uid = uid;
    if (isGet && restPath === '/v1/models') {
      adapters.listModels(prov)
        .then(async (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); })
        .catch((e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      handleTranslated(restPath, raw, prov, res, req.headers).catch((err) => {
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
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address() && server.address().port;
      console.log('[proxy] anthropic<->openai translator on http://127.0.0.1:' + actual
        + (token ? ' (token required)' : ' (UNAUTHENTICATED)'));
      resolve({ port: actual, server, token });
    });
  });
}

async function handleTranslated(restPath, raw, prov, res, inHeaders = {}) {
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
    const est = tokencount.estimatePrompt(body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: est, is_approximate: true }));
    return;
  }
  if (restPath !== '/v1/messages') {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unsupported path ' + restPath }));
    return;
  }

  // The engine validates a model before a chat starts with a 1-token "Hi" probe
  // and gives up after ~15s ("Couldn't confirm model ..."). Slow free tiers and
  // cold local models miss that deadline. Answer the probe here; the first real
  // message still reaches the provider and reports any genuine error.
  if (isModelProbe(body)) {
    console.log('[proxy] model probe for "' + body.model + '" answered locally');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_probe', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'Hi' }], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    return;
  }

  if ((prov.protocol || 'openai') === 'anthropic') {
    await passthroughAnthropic(body, prov, res, inHeaders);
    return;
  }

  // Function names over 64 characters are a 400 on OpenAI-format APIs: send short
  // stand-ins and restore the real names in the reply.
  const tn = wrapToolNames(body);
  body = tn.body;

  const wantStream = !!body.stream;
  // Abort the upstream call when the engine drops the connection (interrupt,
  // tab close, timeout). Without this a cancelled turn keeps generating and the
  // user pays for tokens that are thrown away. #10
  const upstreamAbort = new AbortController();
  let upstreamGone = false;
  const abortUpstream = () => {
    if (upstreamGone) return;
    upstreamGone = true;
    try { upstreamAbort.abort(); } catch { /* already aborted */ }
  };
  const onClientGone = () => abortUpstream();
  res.on('close', onClientGone);

  // The engine's own request headers carry the session identity
  // (x-claude-code-session-id). Gateways that route on a session — OpenCode
  // Go answers "400 Request is missing x-opencode-session" without one — need
  // it, and the translated path used to build a fresh header set, dropping it.
  // Forward the session id under both names: the engine's own (Go recognises
  // it) and the gateway's explicit spelling.
  prov.sessionHeaders = sessionHeaders(inHeaders, body);

  const call = (b) => adapters.callUpstream(prov, b, wantStream, upstreamAbort.signal).catch((err) => {
    if (upstreamGone || /abort/i.test(String(err && err.message))) {
      // Client is gone; there is nobody to answer.
      try { res.destroy(); } catch { /* already destroyed */ }
      return { ok: false, clientGone: true, status: 499, text: async () => '' };
    }
    throw err;
  });
  let upstream = await call(body);
  if (upstream.clientGone) return;

  if (!upstream.ok) {
    let err = await readUpstreamError(upstream);
    // The engine's background calls (titles, summaries, hooks that spawn their
    // own `claude`) ask for a Claude model by name. A third-party provider does
    // not have it, and the chat would retry a permanent error until it gives
    // up. Ask again with a model this provider is known to serve.
    const alt = fallbackModel(prov, body.model);
    if (alt && isModelMissing(err)) {
      console.log('[proxy] model "' + body.model + '" is not on this provider; substituting with "' + alt + '"');
      try { res.setHeader('x-cce-model-substituted', alt); } catch { /* headers might be locked */ }
      body = { ...body, model: alt };
      upstream = await call(body);
      if (upstream.clientGone) return;
      err = upstream.ok ? null : await readUpstreamError(upstream);
    }
    if (err) {
      dbg('upstream HTTP ' + err.status + ' -> ' + err.message.slice(0, 200));
      console.error('[proxy] upstream HTTP ' + err.status + ' for model ' + body.model + ': ' + err.message.replace(/\s+/g, ' ').slice(0, 300));
      sendBodyError(res, { status: err.status, message: err.message });
      return;
    }
  }
  if (prov._uid && body.model) setBounded(lastGoodModel, prov._uid, body.model, 200);

  if (!wantStream) {
    const j = await upstream.json();
    if (j && j.error && !j.choices) { sendBodyError(res, j.error); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(aggregateToAnthropic(j, body, tn.back)));
    return;
  }

  // Some gateways answer a streaming request with a plain JSON body: an error
  // with HTTP 200, or the whole reply at once. Reading that as SSE finds no
  // `data:` lines and produced an empty message.
  const upType = String((upstream.headers && upstream.headers.get && upstream.headers.get('content-type')) || '');
  if (/application\/json/i.test(upType)) {
    let j = null;
    try { j = await upstream.json(); } catch { /* handled below */ }
    if (!j || (j.error && !j.choices)) { sendBodyError(res, (j && j.error) || { message: 'the provider sent an unreadable reply' }); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    writeMessageAsSse(res, aggregateToAnthropic(j, body, tn.back));
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
  startKeepAlive(res);
  sse('message_start', { type: 'message_start', message: { id: 'msg_proxy', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: inTokens(body), output_tokens: 0 } } });

  let reasonBuf = '';
  let reasonAll = '';      // everything the model reasoned, for the empty-answer fallback
  // Providers that report usage mid-stream (OpenAI include_usage) overwrite
  // this; otherwise the engine sees zero input tokens, which breaks the context
  // meter and the auto-compact decision. #9
  let promptTokens = inTokens(body);
  const rawPrompt = tokencount.estimateBody(body);
  let realPrompt = false;   // the provider reported the prompt size
  let realOut = false;      // the provider reported the reply size
  let estOut = 0;           // our own count of the reply, used when it did not
  let cachedTokens = 0;     // prompt tokens the provider served from its cache
  let blockOpen = false;   // a content_block is currently open
  let blockIdx = -1;
  let blockType = null;    // 'text' | 'thinking' | 'tool_use'
  let outTokens = 0;
  let stopReason = 'end_turn';
  let sawText = false;     // the reply has visible text
  let sawTool = false;     // the reply has at least one tool call
  let sawFinish = false;   // finish_reason or [DONE] arrived: the stream really ended
  let sawFinishReason = false;   // a finish_reason arrived: the model ended its reply on its own
  // The tools this request offers: a call recovered from prose or reasoning only
  // counts when it names one of them.
  const knownTools = new Set(((body && body.tools) || []).map((t) => t && t.name).filter(Boolean));
  const cutNotes = [];     // notes about cut-off calls, held until the stream's end is known
  let failed = null;       // error that ended the stream early
  const toolBuf = new Map();   // openai tool_call index -> {id, name, args}
  const textTools = [];        // calls recovered from the text channel
  let textCarry = '';          // partial text held back between chunks
  const think = { mode: 'unknown', carry: '' };   // inline <think> state

  const openBlock = (b) => { blockIdx++; blockOpen = true; blockType = b.type; sse('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: b }); };
  const closeBlock = () => { if (blockOpen) { blockOpen = false; sse('content_block_stop', { type: 'content_block_stop', index: blockIdx }); } };
  const emitText = (s) => {
    if (!s) return;
    if (!blockOpen || blockType !== 'text') {
      if (!s.trim()) return;   // no block for whitespace alone
      closeBlock(); openBlock({ type: 'text', text: '' });
    }
    if (s.trim()) sawText = true;
    estOut += tokencount.estimateText(s);
    sse('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: s } });
  };
  // Reasoning goes out as a real thinking block, so the chat shows the model
  // working instead of sitting silent, and a reply is never just nothing.
  const emitThinking = (s) => {
    if (!s) return;
    reasonAll += s;
    estOut += tokencount.estimateText(s);
    if (!blockOpen || blockType !== 'thinking') {
      if (!s.trim()) return;
      closeBlock(); openBlock({ type: 'thinking', thinking: '', signature: '' });
    }
    sse('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'thinking_delta', thinking: s } });
  };
  /**
   * Split a content chunk into reasoning and answer. Only a `<think>` that
   * opens the reply counts: that is how these chat templates emit it, and a
   * tag mentioned later in prose or code must stay text.
   */
  const thinkSplit = (chunk) => {
    const out = [];
    let b = think.carry + chunk;
    think.carry = '';
    if (think.mode === 'unknown') {
      const lead = b.replace(/^\s+/, '');
      if (!lead) { think.carry = b; return out; }
      const m = /^<think(?:ing)?\s*>/i.exec(lead);
      if (m) { think.mode = 'in'; b = lead.slice(m[0].length); }
      else if (lead.length < 10 && '<thinking>'.startsWith(lead.toLowerCase())) { think.carry = b; return out; }
      else think.mode = 'none';
    }
    if (think.mode === 'in') {
      const m = THINK_CLOSE_RE.exec(b);
      if (!m) {
        // Keep back a tail that could be the start of the closing tag.
        const lt = b.lastIndexOf('<');
        const hold = lt >= 0 && b.length - lt < 12 && /^<\/?[a-z]*\s*$/i.test(b.slice(lt)) ? b.slice(lt) : '';
        out.push({ think: true, s: b.slice(0, b.length - hold.length) });
        think.carry = hold;
        return out;
      }
      out.push({ think: true, s: b.slice(0, m.index) });
      think.mode = 'none';
      b = b.slice(m.index + m[0].length).replace(/^\s+/, '');
    }
    if (b) out.push({ think: false, s: b });
    return out;
  };
  const takeContent = (chunk) => {
    for (const seg of thinkSplit(chunk)) {
      if (seg.think) { emitThinking(seg.s); continue; }
      // Text may hide a whole tool call (local models do this); split it out
      // so the engine sees a real tool_use block. #1
      const split = extractTextToolCalls(seg.s, textCarry, knownTools);
      textCarry = split.carry;
      emitText(split.text);
      for (const t of split.tools) queueTextTool(t);
    }
  };
  // A call found in prose or reasoning is queued, not sent: it goes out with the
  // rest at the end of the reply, in order, and only if it is a real tool.
  const queueTextTool = (t) => {
    const name = resolveToolName(t.name, knownTools);
    if (!name) return false;
    textTools.push({ id: 'call_txt_' + (blockIdx + textTools.length + 1) + '_' + Date.now(), name, args: JSON.stringify(t.args || {}), recovered: true });
    return true;
  };
  // Anthropic content blocks are strictly sequential, but OpenAI interleaves
  // argument chunks across parallel tool calls — emit each call whole, in order.
  const flushTools = () => {
    // Calls found in the text channel go out first: they were produced before
    // any structured tool_call could arrive.
    const structured = [...toolBuf].sort((x, y) => x[0] - y[0]).map(([, t]) => t);
    for (const t of structured) {
      // A model's loose spelling of a real tool ("bash", "read_file").
      const fixed = resolveToolName(t.name, knownTools);
      if (fixed) t.name = fixed;
    }
    // The same call can arrive twice (once in the reasoning, once structured):
    // run it once.
    const seen = new Set(structured.filter((t) => t.name && toolArgsComplete(t.args)).map((t) => callSignature(t.name, t.args)));
    const all = [];
    for (const t of textTools.splice(0)) {
      const sig = callSignature(t.name, t.args);
      if (seen.has(sig)) continue;
      seen.add(sig);
      all.push(t);
    }
    all.push(...structured);
    const cut = stopReason === 'max_tokens' || !sawFinishReason;
    for (const t of all) {
      if (!t.name) continue;
      let args = t.args;
      if (!toolArgsComplete(args)) {
        // A model's slip (finished its reply, wrote bad JSON) can be mended. A
        // cut-off call cannot: closing it would run a write with half its content.
        const fixedArgs = cut ? null : repairToolArgs(args);
        if (fixedArgs) {
          args = JSON.stringify(fixedArgs);
        } else if (!cut && requiresArgs(body.tools, t.name)) {
          // Let the engine's own input check tell the model what is missing; it
          // then retries with arguments instead of the turn ending in silence.
          console.warn('[proxy] unusable tool arguments, engine will reject:', t.name);
          args = '{}';
        } else {
          console.warn('[proxy] incomplete tool arguments dropped:', t.name);
          const note = '\n[The call to ' + t.name + ' was cut off before its arguments were complete, so it was not run.'
            + (stopReason === 'max_tokens' ? ' The reply hit the output-token limit.' : '') + ']\n';
          if (sawFinishReason) emitText(note); else cutNotes.push(note);
          continue;
        }
      }
      closeBlock();
      openBlock({ type: 'tool_use', id: t.id, name: tn.back(t.name) });
      sse('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: args || '{}' } });
      stopReason = 'tool_use';
      sawTool = true;
      estOut += tokencount.estimateText(t.name) + tokencount.estimateText(args) + 4;
    }
    toolBuf.clear();
  };

  try {
    const handleLine = (raw) => {
        const line = raw.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawFinish = true; return; }
        let j;
        try { j = JSON.parse(payload); } catch { return; }
        // An error sent inside a 200 stream (context overflow, quota, a model
        // that went away). Skipping it turned the failure into an empty reply.
        if (j.error && !(j.choices && j.choices.length)) {
          const e = new Error(errorText(j.error));
          e.upstream = j.error;
          throw e;
        }
        const choice = (j.choices || [])[0];
        if (!choice) {
          if (j.usage) {
            const p = j.usage.prompt_tokens || j.usage.input_tokens;
            if (p) { promptTokens = p; realPrompt = true; }
            if (j.usage.completion_tokens) { outTokens = j.usage.completion_tokens; realOut = true; }
            cachedTokens = cachedFrom(j.usage) || cachedTokens;
          }
          return;
        }
        const d = choice.delta || {};
        if (d.reasoning || d.reasoning_content) {
          // Tool-tuned models (e.g. Qwen3-toolcall via Ollama) emit tool calls
          // as <tool_call>{json}</tool_call> inside the reasoning channel.
          const piece = (typeof d.reasoning === 'string' ? d.reasoning : '') + (typeof d.reasoning_content === 'string' ? d.reasoning_content : '');
          emitThinking(piece);
          reasonBuf += piece;
          let m2;
          while ((m2 = reasonBuf.match(/<tool_call>([\s\S]*?)<\/tool_call>/))) {
            reasonBuf = reasonBuf.slice(reasonBuf.indexOf(m2[0]) + m2[0].length);
            let parsed = null;
            try { parsed = parseToolJson(m2[1]); } catch { /* partial/invalid */ }
            if (parsed) queueTextTool(parsed);
          }
          // Only an unfinished call needs to wait for more chunks.
          const openAt = reasonBuf.lastIndexOf('<tool_call>');
          reasonBuf = openAt >= 0 ? reasonBuf.slice(openAt) : reasonBuf.slice(-16);
        }
        if (d.content) takeContent(d.content);
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const k = pickToolSlot(toolBuf, tc);
            const cur = toolBuf.get(k) || { id: tc.id || ('call_' + k + '_' + Date.now()), name: '', args: '' };
            if (tc.id) { cur.id = tc.id; cur.real = true; }
            if (tc.function && tc.function.name) cur.name = tc.function.name;
            if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
            toolBuf.set(k, cur);
          }
        }
        if (choice.finish_reason) {
          sawFinish = true;
          sawFinishReason = true;
          const hadTool = sawTool;
          stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
          flushTools();
          // A call recovered from text or reasoning still has to run, whatever
          // the provider called the finish.
          if (hadTool && stopReason === 'end_turn') stopReason = 'tool_use';
          // "tool_calls" with no call that survived (no name, cut-off args):
          // tool_use with no tool_use block ends the turn in silence.
          if (stopReason === 'tool_use' && !sawTool) stopReason = 'end_turn';
        }
        if (j.usage) {
          const p = j.usage.prompt_tokens || j.usage.input_tokens;
          if (p) { promptTokens = p; realPrompt = true; }
          if (j.usage.completion_tokens) { outTokens = j.usage.completion_tokens; realOut = true; }
          cachedTokens = cachedFrom(j.usage) || cachedTokens;
        }
    };
    for await (const line of sseLines(upstream.body)) handleLine(line);
  } catch (err) {
    // Client hung up (turn interrupted) or the socket died: stop paying for
    // tokens nobody will read. #10
    failed = err || new Error('stream failed');
    abortUpstream();
    closeBlock();
  }
  if (failed) {
    // Say so and stop. Finishing the message as if it had completed hid the
    // failure behind an empty or half-written reply.
    if (!res.writableEnded && !res.destroyed) {
      const out = mapError(Number(failed.upstream && (failed.upstream.status || failed.upstream.code)) || 502, String(failed.message || failed));
      try { sse('error', { type: 'error', error: { type: out.type, message: out.message } }); } catch { /* socket gone */ }
      try { res.end(); } catch { /* socket gone */ }
    }
    return;
  }
  // Content still held back while deciding whether it opened with <think>.
  if (think.carry) {
    const rest = think.carry;
    think.carry = '';
    if (think.mode === 'in') emitThinking(rest);
    else { think.mode = 'none'; takeContent(rest); }
  }
  // A trailing partial tool call (stream cut mid-JSON) would otherwise vanish.
  if (textCarry.trim()) {
    let parsed = null;
    try { parsed = parseToolJson(textCarry); } catch { /* not a call after all */ }
    // Held-back text that was never a call to a real tool is still the model's answer.
    if (!(parsed && queueTextTool(parsed))) emitText(textCarry);
  }
  // The upstream closed with no finish_reason, no [DONE] and nothing said: a
  // dropped connection, not an empty answer. Report it so the engine retries.
  if (!sawFinish && !sawText && !sawTool && !toolBuf.size && !textTools.length && !reasonAll.trim()) {
    if (!res.writableEnded && !res.destroyed) {
      try { sse('error', { type: 'error', error: { type: 'api_error', message: 'The provider stream ended before any reply' } }); } catch { /* socket gone */ }
      try { res.end(); } catch { /* socket gone */ }
    }
    return;
  }
  // Text arrived but the stream ended with no finish_reason and no [DONE]: the
  // provider dropped the connection mid-reply. Say so rather than let a
  // half sentence pass as a finished answer.
  if (!sawFinish && sawText && !sawTool && !toolBuf.size && !textTools.length) {
    emitText('\n[The provider closed the stream before the reply was finished. Send "continue" to resume.]\n');
  }
  const hadVisible = sawText || sawTool;
  flushTools();   // tool calls buffered for sequential emission (no finish_reason seen)
  if (cutNotes.length) {
    // The stream died inside a tool call. With nothing else said, report a
    // dropped connection so the engine asks again; otherwise say what was lost.
    if (!hadVisible && !sawTool) {
      if (!res.writableEnded && !res.destroyed) {
        try { sse('error', { type: 'error', error: { type: 'api_error', message: 'The provider stream ended in the middle of a tool call' } }); } catch { /* socket gone */ }
        try { res.end(); } catch { /* socket gone */ }
      }
      return;
    }
    for (const n of cutNotes) emitText(n);
  }
  if (stopReason === 'tool_use' && !sawTool) stopReason = 'end_turn';
  // The model reasoned and then said nothing. The engine reads that as an empty
  // reply (and a summary made this way fails compaction outright), so the
  // reasoning is the answer.
  if (!sawText && !sawTool && reasonAll.trim()) emitText(reasonAll.trim());
  closeBlock();
  // No reply size from the provider: our count of what was sent. A real prompt
  // size teaches the next estimate for this model.
  if (!realOut) outTokens = Math.max(outTokens, Math.round(estOut));
  if (realPrompt) tokencount.noteActual(body.model, rawPrompt, promptTokens);
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: anthropicUsage(promptTokens, outTokens, cachedTokens) });
  sse('message_stop', { type: 'message_stop' });
  if (!res.writableEnded && !res.destroyed) { try { res.end(); } catch { /* socket gone */ } }
}

const { THINK_CLOSE_RE } = require('../shared/think.js');

/** Tool arguments are usable only when they parse to an object ('' means none). */
function toolArgsComplete(args) {
  const s = String(args == null ? '' : args).trim();
  if (!s) return true;
  try { const v = JSON.parse(s); return !!v && typeof v === 'object' && !Array.isArray(v); } catch { return false; }
}

// Last model each provider answered with, as a stand-in for one it lacks.
const lastGoodModel = new Map();

function clearLastGoodModel(uid) {
  if (uid) lastGoodModel.delete(uid);
  else lastGoodModel.clear();
}

function errorText(e) {
  if (!e) return 'unknown provider error';
  if (typeof e === 'string') return e;
  return String(e.message || e.msg || e.code || e.type || JSON.stringify(e)).slice(0, 500);
}

/** Read a failed upstream response into { status, message }. */
async function readUpstreamError(upstream) {
  const text = await upstream.text();
  let message = text.slice(0, 500);
  try {
    const j = JSON.parse(text);
    message = (j.error && errorText(j.error)) || j.message || j.detail || message;
  } catch { /* keep raw */ }
  return { status: upstream.status, message: String(message || ('HTTP ' + upstream.status)) };
}

function isModelMissing(err) {
  const m = String((err && err.message) || '');
  return /model/i.test(m) && /(does not exist|doesn't exist|not exist|not found|unknown model|no such model|invalid model|not available|not supported|unsupported)/i.test(m);
}

/** A model this provider can serve in place of `missing`, or '' if none is known. */
function fallbackModel(prov, missing) {
  if (!prov) return '';
  const want = String(missing || '');
  return [prov.fallbackModel, prov.smallFastModel, prov._uid ? lastGoodModel.get(prov._uid) : undefined, prov.model].find(x => x && x !== want) || '';
}

/** Structured error for malformed tool payload (#6) */
function toolPayloadError(field, _raw) {
  return {
    type: 'invalid_request_error',
    field: String(field || 'arguments'),
    message: `Malformed tool payload in field '${field || 'arguments'}'`,
  };
}

const CONTEXT_RE = /context.{0,20}(length|window|size)|maximum context|prompt is too long|(input|prompt|request).{0,24}too (long|large)|too many (input )?tokens|exceed.{0,40}(context|max.{0,12}tokens)/i;

/**
 * Upstream failure -> the status and error type the engine acts on.
 *
 * Everything used to become 502, which the engine treats as "try again": a
 * wrong model name was retried ten times, and a full context window never
 * triggered compaction.
 */
function mapError(status, message) {
  const msg = String(message || '').trim() || ('HTTP ' + status);
  if (status !== 429 && CONTEXT_RE.test(msg)) {
    return { status: 400, type: 'invalid_request_error', message: /prompt is too long/i.test(msg) ? msg : 'prompt is too long: ' + msg };
  }
  if (isModelMissing({ message: msg })) return { status: 404, type: 'not_found_error', message: msg };
  // Used-up free tier, no balance, unpaid plan. Not a login problem (403 read as
  // "authentication failed") and not worth retrying (429 read as "try later").
  if (status !== 429 && /quota (has been |is )?(exhausted|exceeded|used up)|insufficient (balance|quota|credit)|out of credits?|payment (information|method|required)|billing/i.test(msg)) {
    return { status: 402, type: 'billing_error', message: 'The provider says this account has no usage left: ' + msg };
  }
  // A session-routed gateway that got no session id. The proxy now forwards the
  // engine's session id, so this is either a provider that wants a header CCE
  // does not know about yet, or the request came in without one. Say which.
  if (/missing x-opencode-session|MissingSessionID/i.test(msg)) {
    return {
      status: 400,
      type: 'invalid_request_error',
      message: 'The provider routes per conversation and needs a session id, which CCE did not send. '
        + 'This provider is not supported yet — pick another one or report it.',
    };
  }
  switch (status) {
    case 400: case 422: return { status: 400, type: 'invalid_request_error', message: msg };
    case 401: return { status: 401, type: 'authentication_error', message: msg };
    case 402: case 403: return { status: 403, type: 'permission_error', message: msg };
    case 404: return { status: 404, type: 'not_found_error', message: msg };
    case 413: return { status: 413, type: 'request_too_large', message: msg };
    case 429: return { status: 429, type: 'rate_limit_error', message: msg };
    case 529: return { status: 529, type: 'overloaded_error', message: msg };
    default: return { status: 502, type: 'api_error', message: msg };
  }
}

/** Answer with an error the provider put in a 200 body. */
function sendBodyError(res, e) {
  const out = mapError(Number(e && (e.status || e.code)) || 502, errorText(e));
  res.writeHead(out.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: out.type, message: out.message } }));
}

/** Replay a complete Anthropic message as the SSE the engine asked for. */
function writeMessageAsSse(res, msg) {
  const sse = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  sse('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } } });
  msg.content.forEach((b, index) => {
    if (b.type === 'tool_use') {
      sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name } });
      sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) } });
    } else if (b.type === 'thinking') {
      sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
    } else {
      sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text || '' } });
    }
    sse('content_block_stop', { type: 'content_block_stop', index });
  });
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: msg.usage });
  sse('message_stop', { type: 'message_stop' });
  res.end();
}

// Constant-time compare so the token cannot be probed byte by byte.
/** The engine's model-validation request: max_tokens 1, one user message "Hi", no tools, no stream. */
function isModelProbe(body) {
  if (!body || body.max_tokens !== 1 || body.stream || (body.tools && body.tools.length)) return false;
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1 || msgs[0].role !== 'user') return false;
  const c = msgs[0].content;
  const text = typeof c === 'string' ? c : (Array.isArray(c) && c.length === 1 && c[0] && c[0].type === 'text' ? c[0].text : null);
  if (text === 'Hi') {
    // The engine validates a model with a 1-token probe; we fake a successful
    // reply so slow free tiers and cold local models pass the ~15s confirm
    // deadline. The first real message still reaches the provider.
    if (process.env.CCE_DEV === '1') console.log('[proxy] model probe answered locally for "' + (body.model || '') + '"');
  }
  return text === 'Hi';
}

// Headers that must not be copied from the engine's request to the upstream.
const DROP_HEADERS = new Set(['host', 'connection', 'content-length', 'authorization', 'x-api-key',
  'x-cce-proxy-token', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade']);

/**
 * The session identity to forward upstream.
 *
 * The engine sends `x-claude-code-session-id` on every /v1/messages call. Some
 * gateways (OpenCode Go) reject a request without a session id, because they
 * route and cache per conversation. The translated path rebuilt the header set
 * from scratch, so the id never arrived and every turn failed with
 * "400 Request is missing x-opencode-session".
 *
 * Both spellings are sent: the engine's own name (Go recognises it) and the
 * gateway's documented `x-opencode-session`. The value is the engine's session
 * id, so it stays stable for the whole conversation — which is what the
 * gateway needs for prompt caching.
 */
function sessionHeaders(inHeaders, body) {
  const out = {};
  const raw = (inHeaders || {})['x-claude-code-session-id'];
  const sid = typeof raw === 'string' ? raw.trim() : '';
  if (!sid) return out;
  out['x-claude-code-session-id'] = sid;
  out['x-opencode-session'] = sid;
  return out;
}

/** Fill in the token counts the claude engine reads (`usage.input_tokens`). */
function ensureUsage(u, fallbackIn) {
  const out = { ...(u || {}) };
  if (typeof out.input_tokens !== 'number') out.input_tokens = fallbackIn;
  if (typeof out.output_tokens !== 'number') out.output_tokens = 0;
  return out;
}

/**
 * Native-Anthropic upstream that omits `usage` (some gateways do for non-Claude
 * models): the engine crashes validating the model with "usage.input_tokens of
 * undefined". Forward the request untouched, with the engine's own headers so
 * the gateway still sees the real client, and only repair the usage fields.
 */
async function passthroughAnthropic(body, prov, res, inHeaders) {
  const url = String(prov.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/messages';
  const headers = {};
  for (const [k, v] of Object.entries(inHeaders || {})) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  headers['content-type'] = 'application/json';
  if (prov.apiKey) {
    if (prov.keyHeader === 'bearer') headers.Authorization = 'Bearer ' + prov.apiKey;
    else headers['x-api-key'] = prov.apiKey;
  }
  if (prov.headers && typeof prov.headers === 'object') Object.assign(headers, prov.headers);
  const est = inTokens(body);
  const ac = new AbortController();
  res.on('close', () => { try { ac.abort(); } catch { /* done */ } });
  let up;
  try {
    up = await adapters.fetchUpstream(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted) { try { res.destroy(); } catch { /* gone */ } return; }
    throw err;
  }
  const ctype = up.headers.get('content-type') || 'application/json';
  if (!up.ok || !/event-stream/i.test(ctype)) {
    const text = await up.text();
    if (up.ok) {
      try {
        const j = JSON.parse(text);
        if (j && j.type !== 'error') j.usage = ensureUsage(j.usage, est);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
        return;
      } catch { /* not JSON: hand it over as-is */ }
    }
    res.writeHead(up.status, { 'content-type': ctype });
    res.end(text);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  startKeepAlive(res);
  const fix = (line) => {
    if (!line.startsWith('data:')) return line;
    let j;
    try { j = JSON.parse(line.slice(5).trim()); } catch { return line; }
    if (j.type === 'message_start' && j.message) j.message.usage = ensureUsage(j.message.usage, est);
    else if (j.type === 'message_delta') j.usage = { ...(j.usage || {}), output_tokens: typeof (j.usage && j.usage.output_tokens) === 'number' ? j.usage.output_tokens : 0 };
    else return line;
    return 'data: ' + JSON.stringify(j);
  };
  try {
    for await (const line of sseLines(up.body)) res.write(fix(line) + '\n');
  } catch { /* client gone or upstream cut: just end */ }
  if (!res.writableEnded && !res.destroyed) { try { res.end(); } catch { /* socket gone */ } }
}

function isTokenValid(req, token) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const candidates = [bearer, String(req.headers['x-api-key'] || ''), String(req.headers['x-cce-proxy-token'] || '')];
  for (const c of candidates) {
    if (!c) continue;
    const a = Buffer.from(c);
    const b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function aggregateToAnthropic(j, body, back = (n) => n) {
  const choice = (j.choices || [])[0] || {};
  const m = choice.message || {};
  // Thinking models (qwen3.5, gemma-through-Ollama) put reasoning in a
  // separate field, not in content. Surface it as a thinking block so the
  // engine sees the reasoning and the reply is not an empty message.
  let reasoning = [m.reasoning, m.reasoning_content].filter(x => typeof x === 'string' && x).join('');
  // Reasoning written into the content itself (<think>…</think>, or only the
  // closing tag) belongs with the thinking, not in the answer.
  if (typeof m.content === 'string' && /think/i.test(m.content)) {
    const cut = adapters.splitThink(m.content);
    if (cut.thinking) { reasoning += (reasoning ? '\n' : '') + cut.thinking; m.content = cut.text; }
  }
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
  // Tool calls hiding in the text channel (bare JSON or dangling tags), and in
  // the reasoning channel: same recovery as the streamed path.
  const known = new Set(((body && body.tools) || []).map((t) => t && t.name).filter(Boolean));
  const split = extractTextToolCalls(String(m.content || ''), '', known);
  m.content = split.text;
  for (const t of split.tools) {
    (m.tool_calls = m.tool_calls || []).push({
      id: 'call_agg_txt_' + (m.tool_calls || []).length, type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.args || {}) },
    });
  }
  if (reasoning) {
    const rsplit = extractTextToolCalls(reasoning, '', known);
    for (const t of rsplit.tools) {
      (m.tool_calls = m.tool_calls || []).push({
        id: 'call_agg_rsn_' + (m.tool_calls || []).length, type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.args || {}) },
      });
    }
  }
  const content = [];
  if (reasoning.trim()) content.push({ type: 'thinking', thinking: reasoning.trim().slice(0, 8000) });
  if (m.content) content.push({ type: 'text', text: m.content });
  const cutOff = choice.finish_reason === 'length';
  const seenCalls = new Set();
  for (const tc of m.tool_calls || []) {
    if (!tc.function || !tc.function.name) continue;
    const callName = resolveToolName(tc.function.name, known) || tc.function.name;
    let input;
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = undefined; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      // A slip (the model finished its reply) is mended; a cut-off call never is.
      const fixed = cutOff ? null : repairToolArgs(tc.function.arguments);
      if (fixed) input = fixed;
      else if (!cutOff && requiresArgs(body && body.tools, callName)) input = {};   // the engine's input check tells the model what is missing
      else {
        content.push({ type: 'text', text: '[The call to ' + callName + ' was cut off before its arguments were complete, so it was not run.]' });
        continue;
      }
    }
    // The same call in the reasoning and as a structured call runs once.
    const sig = callSignature(callName, input);
    if (seenCalls.has(sig)) continue;
    seenCalls.add(sig);
    content.push({ type: 'tool_use', id: tc.id || ('call_' + content.length), name: back(callName), input });
  }
  // Thought, then said nothing: the reasoning is all there is, so it is the answer.
  if (!m.content && !(m.tool_calls || []).length && reasoning.trim()) content.push({ type: 'text', text: reasoning.trim() });
  if (!content.length) content.push({ type: 'text', text: '' });
  // A recovered call means the turn ends in tool_use even when the provider
  // said "stop": the engine only continues the turn on tool_use.
  // Judge by the blocks actually emitted: "tool_calls" with every call dropped
  // must not claim tool_use, or the engine waits for a call that never comes.
  const hasTools = content.some((b) => b.type === 'tool_use');
  const stop = hasTools ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: j.id || 'chatcmpl-proxy',
    type: 'message',
    role: 'assistant',
    model: j.model || body.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: anthropicUsage((j.usage && j.usage.prompt_tokens) || 0, (j.usage && j.usage.completion_tokens) || 0, cachedFrom(j.usage)),
  };
}

// OpenAI-compatible root building lives in ./adapters now (openaiBase), shared
// with the Gemini / Responses adapters and re-exported below for the tests.

/**
 * Prompt-token estimate for the streamed path.
 *
 * Anthropic's message_start carries input_tokens, and providers that do not
 * report usage mid-stream would otherwise leave the engine believing the
 * context is empty. ~4 chars/token is the standard rough ratio.
 */
function inTokens(body) {
  return tokencount.estimatePrompt(body);
}

// Text-embedded tool calls. Small local models (granite, qwen3 3-4B) emit the
// call as prose instead of a structured tool_calls array, e.g.
//   {"name": "mcp__x__y", "arguments": {...}}</tool_call>
// or with no wrapper at all. Parse both shapes out of the text channel so the
// agent can still act. #1
const TOOL_TAG_RE = /<\s*(?:tool_call|tool_use)\s*>([\s\S]*?)<\s*\/\s*(?:tool_call|tool_use)\s*>/i;

/**
 * Pull tool calls out of a text channel.
 *
 * Streaming means a call can straddle chunks, so incomplete trailing text is
 * held back in `carry` and only released once it can no longer become a call.
 *
 * @param {string} chunk  newly arrived text
 * @param {string} carry  text withheld from previous calls
 * @param {Set<string>} [known] tool names this request offers; a call to anything
 *   else stays text (prose that merely shows a JSON example is not a call)
 * @returns {{text: string, tools: Array<{name:string,args:object}>, carry: string}}
 */
function extractTextToolCalls(chunk, carry, known) {
  const buf = (carry || '') + (chunk || '');
  const tools = [];
  let plain = '';
  let i = 0;

  for (;;) {
    // Earliest candidate in the remaining buffer: a wrapped call or a bare
    // JSON object that carries both a name and arguments.
    const rest = buf.slice(i);
    const tagIdx = rest.search(TOOL_TAG_OPEN_RE);
    const bareIdx = findBareToolStart(rest);
    let start = -1;
    let wrapped = false;
    if (tagIdx >= 0 && (bareIdx < 0 || tagIdx <= bareIdx)) { start = i + tagIdx; wrapped = true; }
    else if (bareIdx >= 0) { start = i + bareIdx; wrapped = false; }

    if (start < 0) break;   // nothing tool-shaped left

    if (wrapped) {
      const afterTag = start + buf.slice(start).match(TOOL_TAG_OPEN_RE)[0].length;
      const closeMatch = buf.slice(afterTag).match(CLOSE_TAG_RE);
      if (!closeMatch) {
        // Closing tag has not arrived; hold everything from the opening tag.
        plain += buf.slice(i, start);
        return { text: plain, tools, carry: buf.slice(start) };
      }
      const end = afterTag + closeMatch.index + closeMatch[0].length;
      let parsed = parseToolJson(buf.slice(afterTag, afterTag + closeMatch.index));
      if (parsed && known) {
        const name = resolveToolName(parsed.name, known);
        parsed = name ? { ...parsed, name } : null;
      }
      if (parsed) {
        tools.push(parsed);
        plain += buf.slice(i, start);
        i = end;
        continue;
      }
      // Not a real call: keep it as literal text and step past it.
      plain += buf.slice(i, end);
      i = end;
      continue;
    }

    // Bare: try to close the object from `start`.
    const bal = matchBalancedToolJson(buf.slice(start));
    if (!bal) { i = start + 1; continue; }            // not tool-shaped, advance
    if (!bal.complete) {
      plain += buf.slice(i, start);
      return { text: plain, tools, carry: buf.slice(start) };
    }
    let parsed = parseToolJson(bal.json);
    if (parsed && known) {
      const name = resolveToolName(parsed.name, known);
      parsed = name ? { ...parsed, name } : null;
    }
    if (!parsed) {   // not a call to a real tool: it stays in the text, with what came before it
      plain += buf.slice(i, start + bal.end);
      i = start + bal.end;
      continue;
    }
    tools.push(parsed);
    plain += buf.slice(i, start);
    i = start + bal.end;
  }

  plain += buf.slice(i);
  return { text: plain, tools, carry: '' };
}

// Opening tag only; the body is pulled separately.
const TOOL_TAG_OPEN_RE = /<\s*(?:tool_call|tool_use)\s*>/i;

/**
 * Index of a JSON object that plausibly starts a bare tool call.
 * Requires both a "name" and an "arguments" key somewhere in the object.
 * @returns {number} index, or -1
 */
function findBareToolStart(text) {
  let from = 0;
  // Brace-heavy prose (log files, code dumps) would otherwise make this scan
  // quadratic: every '{' pays for a balanced-JSON walk. Bail out after a
  // bounded number of attempts — a real call starts near the buffer head. #16
  let attempts = 0;
  for (;;) {
    if (++attempts > 200) return -1;
    const at = text.indexOf('{', from);
    if (at < 0) return -1;
    const bal = matchBalancedToolJson(text.slice(at));
    if (bal && bal.complete && /"name"\s*:/.test(bal.json) && /"arguments"\s*:/.test(bal.json)) return at;
    // Incomplete: only treat as a candidate if it could still become one (it
    // already has a "name" key or is still short enough that keys are streaming in).
    if (bal && !bal.complete && (/"name"\s*:/.test(bal.json) || bal.json.length < 40)) return at;
    from = at + 1;
  }
}

const CLOSE_TAG_RE = /<\s*\/\s*(?:tool_call|tool_use)\s*>/i;

/**
 * If the buffer opens with a JSON object, return the balanced slice.
 * @returns {{json:string,end:number,complete:boolean}|null}
 */
function matchBalancedToolJson(buf) {
  let start = 0;
  while (start < buf.length && /\s/.test(buf[start])) start++;
  if (start >= buf.length) return null;
  if (buf[start] !== '{' && buf[start] !== '[') return null;
  const open = buf[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = start; k < buf.length; k++) {
    const ch = buf[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const json = buf.slice(start, k + 1);
        // A dangling close tag right after it is part of the same call.
        const tail = buf.slice(k + 1).match(/^\s*<\s*\/\s*(?:tool_call|tool_use)\s*>/i);
        return { json, end: k + 1 + (tail ? tail[0].length : 0), complete: true };
      }
    }
  }
  return { json: buf.slice(start), end: buf.length, complete: false };
}

/** Parse a tool-call payload string into { name, args }. */
function parseToolJson(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // Strip a stray closing tag left inside the captured group.
  s = s.replace(/<\s*\/\s*(?:tool_call|tool_use)\s*>\s*$/i, '').trim();
  // Some models wrap the JSON in a ```json fence.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  let j;
  try { j = JSON.parse(s); } catch { return null; }
  const name = j && (j.name || (j.function && j.function.name));
  if (!name || typeof name !== 'string') return null;
  let args = j.arguments != null ? j.arguments : j.input != null ? j.input : (j.function && j.function.arguments);
  if (args == null) args = {};
  if (typeof args === 'string') {
    // A string that is not JSON cannot become a tool input object. Drop the
    // call (leaving the text visible) rather than inventing a bogus {_raw}
    // key the engine would try to execute. #17
    try { args = JSON.parse(args); } catch { return null; }
  }
  if (typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, args };
}

// Exported for tests: the text-channel tool-call recovery (#1) is the piece
// small local models depend on, so it gets direct unit coverage.
/**
 * Which buffer slot does this streamed tool_call chunk belong to? Normally its
 * `index`; but a provider that reuses an index for a NEW call (different id)
 * would otherwise get two calls' arguments glued together.
 */
/** Prompt tokens served from the provider's cache: OpenAI-style, DeepSeek-style or Anthropic-style. */
function cachedFrom(u) {
  if (!u) return 0;
  return Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
    || Number(u.prompt_cache_hit_tokens) || Number(u.cache_read_input_tokens) || 0;
}

/** Anthropic usage: cache reads are reported apart from, and not counted in, input_tokens. */
function anthropicUsage(prompt, out, cached) {
  const c = Math.min(Math.max(0, cached | 0), Math.max(0, prompt | 0));
  const u = { input_tokens: Math.max(0, (prompt | 0) - c), output_tokens: out | 0 };
  if (c) u.cache_read_input_tokens = c;
  return u;
}

function pickToolSlot(toolBuf, tc) {
  // A chunk that names its call's id belongs to the slot already holding that
  // id, whatever index it carries (interleaved parallel calls).
  if (tc.id) {
    for (const [k, v] of toolBuf) if (v.real && v.id === tc.id) return k;
  }
  // No index and no id: a continuation of the call opened last.
  if (tc.index == null && !tc.id) return toolBuf.size ? Math.max(...toolBuf.keys()) : 0;
  const k = tc.index != null ? tc.index : toolBuf.size;
  const cur = toolBuf.get(k);
  if (cur && cur.real && tc.id && cur.id !== tc.id) {
    return Math.max(...toolBuf.keys(), k) + 1;
  }
  return k;
}

module.exports = {
  pickToolSlot, cachedFrom, anthropicUsage,
  startProxy,
  CCE_PROXY_PORT,
  isTokenValid,
  extractTextToolCalls,
  parseToolJson,
  matchBalancedToolJson,
  findBareToolStart,
  inTokens,
  openaiBase,
  mapError,
  fallbackModel,
  toolPayloadError,
  toolArgsComplete,
  aggregateToAnthropic,
  clearLastGoodModel,
  lastGoodModel,
};
