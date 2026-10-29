// OpenAI Responses API on top of the proxy's Anthropic pipeline. Codex (since
// Feb 2026) only speaks Responses, while most CCE providers speak chat
// completions. The proxy already turns an Anthropic Messages request into any
// provider's dialect and the reply back into Anthropic SSE, so a Responses
// request is translated to Anthropic on the way in and the Anthropic SSE to
// Responses events on the way out.
'use strict';

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
};

/** An image_url (data: URL or http URL) as an Anthropic image block. */
function imageBlock(url) {
  const s = String(url || '');
  const m = s.match(/^data:([^;,]+);base64,(.*)$/);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return s ? { type: 'image', source: { type: 'url', url: s } } : null;
}

function contentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (!p) continue;
    if ((p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') && p.text) out.push({ type: 'text', text: p.text });
    else if (p.type === 'input_image') { const b = imageBlock(p.image_url); if (b) out.push(b); }
  }
  return out;
}

function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try { const v = JSON.parse(String(s || '{}')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/**
 * Responses request -> Anthropic Messages request. Returns the body and the
 * names of freeform ("custom") tools, whose calls go back as custom_tool_call.
 * Hosted tools (web_search, file_search…) and tool namespaces cannot run on a
 * third-party model and are left out.
 */
function responsesToAnthropic(req) {
  const custom = new Set();
  const system = [];
  if (req.instructions) system.push(String(req.instructions));
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  const items = typeof req.input === 'string' ? [{ type: 'message', role: 'user', content: req.input }] : (req.input || []);
  for (const it of items) {
    if (!it) continue;
    const type = it.type || (it.role ? 'message' : '');
    if (type === 'message') {
      if (it.role === 'system' || it.role === 'developer') { const t = textOf(it.content); if (t) system.push(t); continue; }
      push(it.role === 'assistant' ? 'assistant' : 'user', contentBlocks(it.content));
    } else if (type === 'function_call') {
      push('assistant', [{ type: 'tool_use', id: it.call_id || it.id, name: it.name, input: parseArgs(it.arguments) }]);
    } else if (type === 'custom_tool_call') {
      push('assistant', [{ type: 'tool_use', id: it.call_id || it.id, name: it.name, input: { input: String(it.input || '') } }]);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const out = it.output;
      const content = typeof out === 'string' ? out
        : Array.isArray(out) ? contentBlocks(out)
          : (out && typeof out.content === 'string' ? out.content : JSON.stringify(out == null ? '' : out));
      push('user', [{ type: 'tool_result', tool_use_id: it.call_id, content }]);
    }
    // reasoning items carry OpenAI's encrypted state: nothing to send elsewhere
  }
  const tools = [];
  for (const t of req.tools || []) {
    if (!t) continue;
    if (t.type === 'function' && t.name) {
      tools.push({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } });
    } else if (t.type === 'custom' && t.name) {
      custom.add(t.name);
      tools.push({ name: t.name, description: (t.description || '') + (t.format && t.format.definition ? '\n\nInput format:\n' + t.format.definition : ''),
        input_schema: { type: 'object', properties: { input: { type: 'string', description: 'The raw tool input' } }, required: ['input'] } });
    }
  }
  const body = {
    model: req.model,
    max_tokens: Number(req.max_output_tokens) > 0 ? Number(req.max_output_tokens) : 16384,
    stream: true,   // the pipeline always streams; a non-stream caller gets the aggregate
    messages: messages.length ? messages : [{ role: 'user', content: [{ type: 'text', text: '' }] }],
  };
  if (system.length) body.system = system.join('\n\n');
  if (tools.length) body.tools = tools;
  const tc = req.tool_choice;
  if (tools.length && (tc === 'required')) body.tool_choice = { type: 'any' };
  else if (tools.length && tc && tc.type === 'function' && tc.name) body.tool_choice = { type: 'tool', name: tc.name };
  else if (tc === 'none') { delete body.tools; }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.top_p != null) body.top_p = req.top_p;
  const effort = req.reasoning && req.reasoning.effort;
  if (effort) body.effort = effort;
  return { body, custom };
}

let seq = 0;
const rid = (p) => p + '_' + Date.now().toString(36) + (seq++).toString(36);

/**
 * Anthropic SSE events in, Responses SSE events out. `emit(event, data)`
 * writes one Responses event; `event(name, data)` takes one Anthropic event;
 * `fail(message, code)` ends with response.failed.
 */
function createResponsesStream({ model, custom = new Set(), emit }) {
  const response = { id: rid('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'in_progress', output: [] };
  const blocks = new Map();   // anthropic index -> { item, outputIndex, text }
  const usage = { input_tokens: 0, output_tokens: 0, cached: 0 };
  let started = false;
  let done = false;
  const start = () => {
    if (started) return;
    started = true;
    emit('response.created', { type: 'response.created', response: { ...response } });
    emit('response.in_progress', { type: 'response.in_progress', response: { ...response } });
  };
  const usageOut = () => ({
    input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens,
    input_tokens_details: { cached_tokens: usage.cached }, output_tokens_details: { reasoning_tokens: 0 },
  });
  const finishBlock = (b) => {
    const { item, outputIndex } = b;
    if (item.type === 'message') {
      const part = { type: 'output_text', text: b.text, annotations: [] };
      emit('response.output_text.done', { type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: 0, text: b.text });
      emit('response.content_part.done', { type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: 0, part });
      item.content = [part];
    } else if (item.type === 'reasoning') {
      emit('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: item.id, output_index: outputIndex, summary_index: 0, text: b.text });
      item.summary = [{ type: 'summary_text', text: b.text }];
    } else if (item.type === 'function_call') {
      const args = b.text || '{}';
      emit('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: args });
      item.arguments = args;
    } else if (item.type === 'custom_tool_call') {
      item.input = String(parseArgs(b.text).input || '');
    }
    item.status = 'completed';
    response.output[outputIndex] = item;
    emit('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
  };
  return {
    event(name, d) {
      if (done || !d) return;
      start();
      if (name === 'message_start') {
        const u = (d.message && d.message.usage) || {};
        usage.input_tokens = Number(u.input_tokens) || 0;
        usage.cached = Number(u.cache_read_input_tokens) || 0;
      } else if (name === 'content_block_start') {
        const cb = d.content_block || {};
        const outputIndex = response.output.length;
        let item;
        if (cb.type === 'text') item = { type: 'message', id: rid('msg'), role: 'assistant', status: 'in_progress', content: [] };
        else if (cb.type === 'thinking') item = { type: 'reasoning', id: rid('rs'), summary: [] };
        else if (cb.type === 'tool_use') {
          item = custom.has(cb.name)
            ? { type: 'custom_tool_call', id: rid('ctc'), call_id: cb.id, name: cb.name, input: '', status: 'in_progress' }
            : { type: 'function_call', id: rid('fc'), call_id: cb.id, name: cb.name, arguments: '', status: 'in_progress' };
        } else return;
        response.output.push(item);
        blocks.set(d.index, { item, outputIndex, text: '' });
        emit('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
        if (item.type === 'message') {
          emit('response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        } else if (item.type === 'reasoning') {
          emit('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: item.id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
        }
      } else if (name === 'content_block_delta') {
        const b = blocks.get(d.index);
        if (!b) return;
        const delta = d.delta || {};
        const { item, outputIndex } = b;
        if (delta.type === 'text_delta' && item.type === 'message') {
          b.text += delta.text || '';
          emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: 0, delta: delta.text || '' });
        } else if (delta.type === 'thinking_delta' && item.type === 'reasoning') {
          b.text += delta.thinking || '';
          emit('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index: outputIndex, summary_index: 0, delta: delta.thinking || '' });
        } else if (delta.type === 'input_json_delta') {
          b.text += delta.partial_json || '';
          if (item.type === 'function_call') {
            emit('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: delta.partial_json || '' });
          }
        }
      } else if (name === 'content_block_stop') {
        const b = blocks.get(d.index);
        if (b) { blocks.delete(d.index); finishBlock(b); }
      } else if (name === 'message_delta') {
        const u = d.usage || {};
        if (u.output_tokens != null) usage.output_tokens = Number(u.output_tokens) || 0;
        if (u.input_tokens) usage.input_tokens = Number(u.input_tokens) || usage.input_tokens;
        if (u.cache_read_input_tokens) usage.cached = Number(u.cache_read_input_tokens) || usage.cached;
      } else if (name === 'message_stop') {
        this.end();
      } else if (name === 'error') {
        this.fail((d.error && d.error.message) || 'upstream error', d.error && d.error.type);
      }
    },
    end() {
      if (done) return;
      start();
      for (const b of blocks.values()) finishBlock(b);
      blocks.clear();
      done = true;
      response.status = 'completed';
      response.output = response.output.filter(Boolean);
      response.usage = usageOut();
      emit('response.completed', { type: 'response.completed', response: { ...response } });
    },
    fail(message, code) {
      if (done) return;
      start();
      done = true;
      response.status = 'failed';
      response.error = { code: code || 'server_error', message: String(message || 'upstream error') };
      emit('response.failed', { type: 'response.failed', response: { ...response } });
    },
    get response() { return response; },
    get done() { return done; },
  };
}

/** Split Anthropic SSE text into [event, data] pairs as it arrives. */
function createSseParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      let d = null;
      try { d = JSON.parse(data.join('\n')); } catch { continue; }
      onEvent(ev === 'message' && d && d.type ? d.type : ev, d);
    }
  };
}

module.exports = { responsesToAnthropic, createResponsesStream, createSseParser };
