// Engine chats: Codex, Antigravity and OpenCode in the chat view instead of a
// raw terminal. Each user message is one headless CLI run (codex exec --json,
// agy -p --output-format stream-json, opencode run --format json); the next
// turn resumes the same engine session. The JSON each CLI prints is translated
// into the Agent SDK message shapes the chat view already renders (system
// init, assistant text/thinking/tool_use, user tool_result, result), so no
// renderer code has to know which engine it is talking to. #feat-engine-chat
'use strict';
const { spawn } = require('child_process');
const { REGISTRY } = require('./engines');
const { stripAnsi } = require('./ansi');
const { aliasOf } = require('./toolcalls');
const { terminate, appendTail, tail, capOutput, textOf, stubQuery } = require('./procutil');

const labelOf = (engine) => (REGISTRY.find((e) => e.id === engine) || {}).label || engine;

const PROVIDER_KEY_ENV = 'CCE_PROVIDER_KEY';

/**
 * Point an engine at a CCE provider instead of its own login: extra argv,
 * extra env and the model id to pass. `prov` is { name, proxyBase, token }:
 * the engine talks to CCE's local proxy, which serves every CCE provider in
 * its own dialect. Codex speaks only the Responses API (its chat-completions
 * mode was removed in Feb 2026), so it uses the proxy's /v1/responses; OpenCode
 * uses its built-in Anthropic SDK against the proxy's /v1/messages, which
 * needs no extra package. Antigravity has no custom providers. The proxy
 * token goes in the env, never on the command line.
 */
function providerSetup(engine, prov, model) {
  if (!prov) return { args: [], env: {}, model: model || '' };
  if (!prov.proxyBase) return { error: 'the local provider proxy is not running, so ' + labelOf(engine) + ' cannot reach CCE providers' };
  if (!model) return { error: 'pick a model of this provider for ' + labelOf(engine) };
  const base = String(prov.proxyBase).replace(/\/+$/, '') + '/v1';
  const env = { [PROVIDER_KEY_ENV]: prov.token || 'cce' };
  if (engine === 'codex') {
    const q = (v) => JSON.stringify(String(v));   // a TOML basic string
    const args = ['-c', 'model_provider="cce"',
      '-c', 'model_providers.cce.name=' + q(prov.name || 'CCE'),
      '-c', 'model_providers.cce.base_url=' + q(base),
      '-c', 'model_providers.cce.wire_api="responses"',
      '-c', 'model_providers.cce.env_key=' + q(PROVIDER_KEY_ENV)];
    return { args, env, model };
  }
  if (engine === 'opencode') {
    const config = { provider: { cce: {
      npm: '@ai-sdk/anthropic', name: prov.name || 'CCE',
      options: { baseURL: base, apiKey: '{env:' + PROVIDER_KEY_ENV + '}' },
      // OpenCode drops an image sent to a model not declared as taking images.
      // The proxy answers an image for a text-only model with a short note.
      models: { [model]: { name: model, attachment: true, tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] } } },
    } } };
    return { args: [], env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, model: 'cce/' + model };
  }
  return { error: labelOf(engine) + ' uses its own login and models only' };
}

/** argv (and stdin) for one turn. The prompt never goes through a shell. */
function argsFor(engine, { prompt, sessionId = null, yolo = false, model = '', extraArgs = [] } = {}) {
  const text = String(prompt || '');
  if (engine === 'codex') {
    // `exec resume` takes no -s, so the sandbox is set through config on both.
    const common = ['--json', '--skip-git-repo-check',
      ...(yolo ? ['--dangerously-bypass-approvals-and-sandbox'] : ['-c', 'sandbox_mode="workspace-write"']),
      ...extraArgs,
      ...(model ? ['-m', model] : [])];
    // "-" reads the prompt from stdin: no argv length limit, no flag confusion.
    const args = sessionId ? ['exec', 'resume', ...common, sessionId, '-'] : ['exec', ...common, '-'];
    return { args, stdin: text };
  }
  if (engine === 'antigravity') {
    // agy reads `-p <next arg>` greedily; attaching the prompt keeps a prompt
    // that starts with "-" from being taken for a flag.
    return {
      args: ['--output-format', 'stream-json',
        ...(sessionId ? ['--conversation', sessionId] : []),
        ...(yolo ? ['--dangerously-skip-permissions'] : []),
        ...(model ? ['--model', model] : []),
        '-p=' + text],
      stdin: null,
    };
  }
  if (engine === 'opencode') {
    return {
      args: ['run', '--format', 'json',
        ...(sessionId ? ['--session', sessionId] : []),
        ...(yolo ? ['--auto'] : []),
        ...(model ? ['-m', model] : []),
        '--', text],
      stdin: null,
    };
  }
  throw new Error('unknown engine: ' + engine);
}

/* ---- SDK-shaped frames ---------------------------------------------------- */

const assistant = (sid, content) => ({ type: 'assistant', session_id: sid || '', parent_tool_use_id: null, message: { role: 'assistant', content } });
const textMsg = (sid, text) => assistant(sid, [{ type: 'text', text: stripAnsi(text) }]);
const thinkingMsg = (sid, thinking) => assistant(sid, [{ type: 'thinking', thinking: stripAnsi(thinking) }]);
const toolUse = (sid, id, name, input) => assistant(sid, [{ type: 'tool_use', id, name, input: input || {} }]);
const toolResult = (sid, id, content, isError) => ({
  type: 'user', session_id: sid || '', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: capOutput(stripAnsi(String(content == null ? '' : content))), is_error: !!isError }] },
});
const initMsg = (sid, engine, extra = {}) => ({
  type: 'system', subtype: 'init', session_id: sid || '', engine, model: labelOf(engine),
  tools: [], mcp_servers: [], slash_commands: [], ...extra,
});
const usageOf = (u) => ({ input_tokens: Number(u && u.input_tokens) || 0, output_tokens: Number(u && u.output_tokens) || 0 });
const resultMsg = (sid, { ok, text, usage, started }) => ({
  type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok,
  result: stripAnsi(String(text || '')), session_id: sid || '', num_turns: 1,
  duration_ms: started ? Date.now() - started : 0,
  usage: usageOf(usage),
});

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/* ---- per-engine translators ------------------------------------------------ */

/**
 * One translator per turn. feed(line) returns the frames that line produced;
 * finish({ code, stderr }) closes the turn and always yields exactly one
 * result frame in total, so the chat view never waits on a turn forever.
 */
function createTranslator(engine, { sessionId = null, initSent = false } = {}) {
  const st = { sid: sessionId, initSent, done: false, lastText: '', error: '', usage: { input_tokens: 0, output_tokens: 0 }, started: Date.now(), seen: new Set(), agyText: new Map() };
  const out = [];
  const init = (sid, extra) => {
    if (sid) st.sid = sid;
    if (!st.initSent && st.sid) { st.initSent = true; out.push(initMsg(st.sid, engine, extra)); }
  };
  const text = (t) => { if (t) { st.lastText = t; out.push(textMsg(st.sid, t)); } };
  const use = (id, name, input) => { if (!st.seen.has(id)) { st.seen.add(id); out.push(toolUse(st.sid, id, name, input)); } };
  // A tool call, plus its result once there is one: res = { body, err }.
  const tool = (id, name, input, res) => { use(id, name, input); if (res) out.push(toolResult(st.sid, id, res.body, res.err)); };
  const finishWith = (ok, msg) => { if (!st.done) { st.done = true; out.push(resultMsg(st.sid, { ok, text: msg, usage: st.usage, started: st.started })); } };

  const agyStep = (s) => {
    if (s.conversation_id) init(s.conversation_id);
    if (s.step_type === 'agent_response') {
      const acc = (st.agyText.get(s.step_index) || '') + (s.text_delta || '');
      st.agyText.set(s.step_index, acc);
      if (s.state === 'DONE' || s.state === 'ERROR') { text(acc); st.agyText.delete(s.step_index); }
    } else if (s.step_type === 'tool') {
      const info = s.tool_info || {};
      const name = s.tool_name || info.name || 'tool';
      const params = info.parameters || {};
      const res = s.state === 'DONE' ? { body: asText(info.output != null ? info.output : info.result) }
        : s.state === 'ERROR' ? { body: (info.error && info.error.message) || 'tool failed', err: true } : null;
      if (name === 'run_command') tool('agy-' + s.step_index, 'Bash', { command: params.CommandLine || params.command || '' }, res);
      else tool('agy-' + s.step_index, name, params, res);
    }
  };
  const agyResult = (r) => {
    if (r.conversation_id) init(r.conversation_id);
    st.usage = usageOf(r.usage);
    // Headless agy cannot ask for permission; say why the action did not happen.
    const denied = Array.isArray(r.denied_actions) ? r.denied_actions : [];
    if (denied.length) {
      text(`Antigravity blocked ${denied.length} action(s) that need permission (${denied.map((d) => d.display_name || d.action).join(', ')}). `
        + 'Headless runs cannot ask you. Start this chat with YOLO on to let it run them.');
    }
    const ok = String(r.status || '').toUpperCase() === 'SUCCESS';
    return finishWith(ok, ok ? (r.response || st.lastText) : asText(r.error || r.message || r.status || 'Antigravity run failed'));
  };

  const handlers = {
    codex(ev) {
      if (ev.type === 'thread.started') return init(ev.thread_id);
      if (ev.type === 'error') { st.error = ev.message || st.error; return; }
      if (ev.type === 'turn.failed') return finishWith(false, (ev.error && ev.error.message) || st.error || 'Codex turn failed');
      if (ev.type === 'turn.completed') {
        st.usage = usageOf(ev.usage);
        return finishWith(true, st.lastText);
      }
      if (ev.type !== 'item.started' && ev.type !== 'item.completed') return;
      const it = ev.item || {};
      const done = ev.type === 'item.completed';
      switch (it.type) {
        case 'agent_message': if (done) text(it.text); break;
        case 'reasoning': if (done && it.text) out.push(thinkingMsg(st.sid, it.text)); break;
        case 'command_execution':
          tool(it.id, 'Bash', { command: it.command }, done && { body: it.aggregated_output, err: it.exit_code !== 0 && it.exit_code != null });
          break;
        case 'file_change': {
          const changes = Array.isArray(it.changes) ? it.changes : [];
          tool(it.id, 'Edit', { file_path: changes.map((c) => c.path).join(', '), changes },
            done && { body: changes.map((c) => `${c.kind} ${c.path}`).join('\n'), err: it.status === 'failed' });
          break;
        }
        case 'mcp_tool_call':
        {
          const failed = it.status === 'failed' || !!it.error;
          const body = failed ? (it.error && it.error.message) || 'failed'
            : ((it.result && Array.isArray(it.result.content)) ? textOf(it.result.content) : asText(it.result));
          tool(it.id, `mcp__${it.server}__${it.tool}`, it.arguments, done && { body, err: failed });
          break;
        }
        case 'web_search':
          tool(it.id, 'WebSearch', { query: it.query }, done && { body: '' });
          break;
        case 'todo_list':
          if (done) tool(it.id, 'TodoWrite', { todos: (it.items || []).map((i) => ({ content: i.text, activeForm: i.text, status: i.completed ? 'completed' : 'pending' })) }, { body: '' });
          break;
        // `error` items are warnings (e.g. "skills context budget"); the turn
        // goes on, so they are not shown as failures.
        default: break;
      }
    },

    antigravity(ev) {
      if (ev.event === 'init') return init(ev.conversation_id, { cwd: ev.init && ev.init.cwd });
      if (ev.event === 'step_update') return agyStep(ev.step_update || {});
      if (ev.event === 'result') return agyResult(ev.result || {});
    },

    opencode(ev) {
      if (ev.sessionID) init(ev.sessionID);
      const p = ev.part || {};
      if (ev.type === 'text') return text(p.text);
      if (ev.type === 'reasoning') { if (p.text) out.push(thinkingMsg(st.sid, p.text)); return; }
      if (ev.type === 'tool_use') {
        const s = p.state || {};
        const input = s.input || {};
        const id = p.callID || p.id;
        const name = aliasOf(p.tool) || p.tool || 'tool';
        tool(id, name, input.filePath && !input.file_path ? { ...input, file_path: input.filePath } : input,
          s.status === 'completed' ? { body: s.output } : s.status === 'error' ? { body: s.error || 'tool failed', err: true } : null);
        return;
      }
      if (ev.type === 'step_finish') {
        const t = p.tokens || {};
        st.usage.input_tokens += Number(t.input) || 0;
        st.usage.output_tokens += Number(t.output) || 0;
        return;
      }
      if (ev.type === 'error') {
        const e = ev.error || {};
        st.error = (e.data && e.data.message) || e.message || e.name || 'OpenCode error';
      }
    },
  };
  const handle = handlers[engine];
  if (!handle) throw new Error('unknown engine: ' + engine);

  return {
    get sessionId() { return st.sid; },
    get initSent() { return st.initSent; },
    feed(line) {
      out.length = 0;
      const s = String(line || '').trim();
      if (!s.startsWith('{')) return [];
      let ev;
      try { ev = JSON.parse(s); } catch { return []; }
      handle(ev);
      return out.splice(0);
    },
    finish({ code = 0, stderr = '' } = {}) {
      out.length = 0;
      // codex and agy always print a final frame; opencode does not, so its
      // turn ends here. A crash before any final frame ends here too.
      if (!st.done) {
        const ok = code === 0 && !st.error;
        finishWith(ok, ok ? st.lastText : (st.error || tail(stderr) || `${labelOf(engine)} exited with code ${code}`));
      }
      return out.splice(0);
    },
  };
}

/* ---- runner --------------------------------------------------------------- */

/**
 * One engine chat. Emits the same events ChatManager does ({kind:'status'},
 * {kind:'message', msg}, {kind:'interrupted'}, {kind:'error'}), so the chat
 * view and the Board treat it like any other chat.
 */
class EngineChat {
  constructor({ engine, command, cwd, env, yolo = false, model = '', extraArgs = [], sessionId = null, emit, onThread }) {
    if (!REGISTRY.some((e) => e.id === engine)) throw new Error('unknown engine: ' + engine);
    Object.assign(this, { engine, command, cwd, env, yolo: !!yolo, model: model || '', extraArgs: extraArgs || [], sessionId, emit: emit || (() => {}), onThread: onThread || (() => {}) });
    this.label = labelOf(engine);
    this.busy = false;
    this.queue = [];
    this.child = null;
    this.initSent = false;
    this.lastUsage = { input_tokens: 0, output_tokens: 0 };
    this.q = this._stub();
  }

  send(text, blocks) {
    if (Array.isArray(blocks) && blocks.some((b) => b && b.type !== 'text')) {
      return { ok: false, error: `${this.label} chats take text only — images and files are not passed to the CLI yet` };
    }
    const prompt = [text, ...((blocks || []).map((b) => b.text))].filter(Boolean).join('\n');
    if (!prompt.trim()) return { ok: false };
    if (this.busy) { this.queue.push(prompt); return { ok: true, queued: true }; }
    this._run(prompt);
    return { ok: true };
  }

  _run(prompt) {
    this.busy = true;
    this.emit({ kind: 'status', busy: true });
    const t = createTranslator(this.engine, { sessionId: this.sessionId, initSent: this.initSent });
    const { args, stdin } = argsFor(this.engine, { prompt, sessionId: this.sessionId, yolo: this.yolo, model: this.model, extraArgs: this.extraArgs });
    const push = (msgs) => {
      for (const msg of msgs) {
        if (msg.type === 'result') this.lastUsage = msg.usage;
        this.emit({ kind: 'message', msg });
      }
      if (t.sessionId && t.sessionId !== this.sessionId) { this.sessionId = t.sessionId; this.onThread(t.sessionId); }
      this.initSent = t.initSent;
    };
    let child;
    try {
      // Own process group: Stop must also end the commands the CLI started.
      child = spawn(this.command, args, { cwd: this.cwd, env: this.env, detached: true, stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      push(t.finish({ code: -1, stderr: String((err && err.message) || err) }));
      return this._turnEnded();
    }
    this.child = child;
    if (stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) push(t.feed(line));
    });
    child.stderr.on('data', (d) => { stderr = appendTail(stderr, d, 8000); });
    let ended = false;
    const end = (code, err) => {
      if (ended) return;
      ended = true;
      this.child = null;
      if (child.killedByUser) return this._turnEnded();
      if (buf) push(t.feed(buf));
      push(t.finish({ code, stderr: err ? String(err.message || err) : stderr }));
      this._turnEnded();
    };
    child.on('error', (err) => end(-1, err));
    child.on('close', (code) => end(code == null ? -1 : code));
    // A grandchild holding stdout open delays 'close'; a stopped turn ends now.
    child.on('exit', () => { if (child.killedByUser) end(-1); });
  }

  _turnEnded() {
    const next = this.queue.shift();
    if (next != null) return this._run(next);
    this.busy = false;
    this.emit({ kind: 'status', busy: false });
  }

  async interrupt() {
    const stillQueued = this.queue.length;
    this.queue = [];
    const child = this.child;
    if (!child) return;
    terminate(child);   // SIGKILL follows for a CLI that ignores SIGTERM
    this.emit({ kind: 'interrupted', stillQueued });
  }

  close() {
    this.queue = [];
    if (this.child) terminate(this.child);
  }

  /** Stand-in for the Agent SDK query object, so the chat panels that ask it
   *  for commands, models or context get an empty answer, not a crash. */
  _stub() {
    return stubQuery(this.label, {
      interrupt: () => this.interrupt(),
      usage: () => ({ totalTokens: Number(this.lastUsage.input_tokens) || 0, maxTokens: 0, percentage: 0, categories: [] }),
    });
  }
}

const frames = { assistant, textMsg, thinkingMsg, toolUse, toolResult, initMsg, resultMsg };

module.exports = { argsFor, createTranslator, EngineChat, labelOf, providerSetup, PROVIDER_KEY_ENV, frames };
