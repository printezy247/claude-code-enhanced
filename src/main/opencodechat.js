// OpenCode chats over `opencode serve` (HTTP + an event stream) instead of one
// `opencode run` per message. The server keeps the session, takes images,
// resumes a session by id and asks before running a command or editing a file,
// so CCE shows its usual Allow / Deny card. Emits the Agent SDK message shapes
// EngineChat and CodexChat emit. The server listens on 127.0.0.1 behind a
// random per-chat password. #feat-opencode-serve
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const { frames } = require('./enginechat');
const { terminate, appendTail, stubQuery } = require('./procutil');

// OpenCode tool names -> the names the chat view knows.
const TOOL_NAMES = {
  bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', patch: 'Edit', multiedit: 'Edit',
  grep: 'Grep', glob: 'Glob', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite', task: 'Task',
};
const toolName = (t) => TOOL_NAMES[t] || t;
// Input keys the chat view's cards read (Edit/Read take file_path).
function toolInput(tool, input) {
  const i = input && typeof input === 'object' ? { ...input } : {};
  if ((tool === 'edit' || tool === 'write' || tool === 'read' || tool === 'multiedit') && i.filePath && !i.file_path) i.file_path = i.filePath;
  return i;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** "cce/qwen3-coder" -> { providerID, modelID }; '' -> null (the CLI's own default). */
function splitModel(model) {
  const m = String(model || '');
  const i = m.indexOf('/');
  return i > 0 ? { providerID: m.slice(0, i), modelID: m.slice(i + 1) } : null;
}

/** Anthropic-style content blocks -> OpenCode prompt parts. */
function toParts(text, blocks) {
  const parts = [];
  const t = String(text || '');
  if (t) parts.push({ type: 'text', text: t });
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: String(b.text) });
    else if (b.type === 'image' && b.source && b.source.type === 'base64' && b.source.data) {
      const mime = b.source.media_type || 'image/png';
      parts.push({ type: 'file', mime, filename: 'image.' + (mime.split('/')[1] || 'png'), url: 'data:' + mime + ';base64,' + b.source.data });
    }
  }
  return parts;
}

/** The permission rules: ask for commands and edits unless YOLO. */
function withPermissions(configJson, yolo) {
  let cfg = {};
  try { cfg = configJson ? JSON.parse(configJson) : {}; } catch { cfg = {}; }
  cfg.permission = yolo ? { bash: 'allow', edit: 'allow', webfetch: 'allow' } : { bash: 'ask', edit: 'ask', webfetch: 'ask' };
  return JSON.stringify(cfg);
}

class OpenCodeChat {
  constructor({ command, cwd, env, yolo = false, model = '', sessionId = null, emit, ask, onThread }) {
    Object.assign(this, { command, cwd, env: env || process.env, yolo: !!yolo, model: model || '', emit: emit || (() => {}), ask: ask || (async () => 'deny'), onThread: onThread || (() => {}) });
    this.engine = 'opencode';
    this.label = 'OpenCode';
    this.sessionId = sessionId;
    this.busy = false;
    this.queue = [];
    this.child = null;
    this.base = '';
    this.auth = '';
    this.ready = null;
    this.eventAbort = null;
    this.started = 0;
    this.lastText = '';
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.initSent = false;
    this.closed = false;
    this.seenTool = new Set();
    this.doneParts = new Set();
    this.tokens = new Map();   // step-finish part id -> tokens, summed per turn
    this.q = this._stub();
  }

  /* ---- HTTP -------------------------------------------------------------- */

  async _api(method, path, body, timeoutMs = 30_000) {
    const r = await fetch(this.base + path, {
      method, headers: { 'content-type': 'application/json', authorization: this.auth },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('OpenCode ' + method + ' ' + path + ' -> ' + r.status + (text ? ': ' + text.slice(0, 200) : ''));
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }

  /* ---- server + event stream --------------------------------------------- */

  _start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const port = await freePort();
      const password = crypto.randomBytes(18).toString('hex');
      this.auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
      this.base = 'http://127.0.0.1:' + port;
      const env = { ...this.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: withPermissions(this.env.OPENCODE_CONFIG_CONTENT, this.yolo) };
      const child = spawn(this.command, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: this.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = appendTail(stderr, d); });
      const exited = new Promise((_, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => {
          const err = new Error('OpenCode server exited (code ' + code + ')' + (stderr.trim() ? ': ' + stderr.trim().slice(-300) : ''));
          this._gone(err);
          reject(err);
        });
      });
      exited.catch(() => {});
      const listening = new Promise((resolve) => {
        let buf = '';
        child.stdout.on('data', (d) => { buf += d; if (/listening on http/.test(buf)) resolve(); });
      });
      await Promise.race([listening, exited, new Promise((_, rej) => setTimeout(() => rej(new Error('OpenCode server did not start within 30 s')), 30_000).unref())]);
      await this._listen();
      let session;
      if (this.sessionId) {
        session = await this._api('GET', '/session/' + encodeURIComponent(this.sessionId));
      } else {
        session = await this._api('POST', '/session', { title: 'CCE chat' });
      }
      const resumed = !!this.sessionId;
      this.sessionId = session.id;
      this.onThread(this.sessionId);
      if (!this.initSent) { this.initSent = true; this.emit({ kind: 'message', msg: frames.initMsg(this.sessionId, 'opencode', { model: this.model || 'OpenCode' }) }); }
      if (resumed) await this._replay().catch(() => {});
    })();
    this.ready.catch(() => { this.ready = null; try { this.child && this.child.kill(); } catch { /* gone */ } });
    return this.ready;
  }

  _gone(err) {
    this.child = null; this.ready = null;
    if (this.eventAbort) { try { this.eventAbort.abort(); } catch { /* done */ } this.eventAbort = null; }
    if (this.closed || !this.busy) return;
    this._frame(frames.resultMsg(this.sessionId, { ok: false, text: String(err.message || err), usage: this.usage, started: this.started }));
    this._turnEnded();
  }

  /** Read the server's event stream for the life of the chat. */
  _listen() {
    this.eventAbort = new AbortController();
    const signal = this.eventAbort.signal;
    let connected;
    const ready = new Promise((resolve, reject) => { connected = { resolve, reject }; });
    (async () => {
      const r = await fetch(this.base + '/event', { headers: { authorization: this.auth }, signal });
      if (!r.ok) throw new Error('OpenCode event stream -> ' + r.status);
      connected.resolve();
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let e = null;
          try { e = JSON.parse(line.slice(5)); } catch { continue; }
          try { this._onEvent(e); } catch { /* one bad event must not end the stream */ }
        }
      }
    })().catch((err) => { connected.reject(err); /* later: aborted on close, or the server went away (handled by exit) */ });
    // A prompt sent before the stream is open would lose its first events.
    return ready;
  }

  _frame(msg) { this.emit({ kind: 'message', msg }); }

  _onEvent(e) {
    const p = e.properties || {};
    if (p.sessionID && p.sessionID !== this.sessionId) return;
    switch (e.type) {
      case 'message.part.updated': this._onPart(p.part || {}, true); break;
      case 'permission.asked': this._onPermission(p); break;
      case 'question.asked': this._rejectQuestion(p); break;
      case 'session.error': this.lastError = (p.error && (p.error.data && p.error.data.message || p.error.message || p.error.name)) || this.lastError; break;
      case 'session.idle': this._endTurn(); break;
      default: break;
    }
  }

  _onPart(part, live) {
    const sid = this.sessionId;
    if (part.type === 'text' || part.type === 'reasoning') {
      if (!part.time || !part.time.end || !part.text || this.doneParts.has(part.id)) return;
      this.doneParts.add(part.id);
      if (part.type === 'text') { this.lastText = part.text; this._frame(frames.textMsg(sid, part.text)); }
      else this._frame(frames.thinkingMsg(sid, part.text));
    } else if (part.type === 'tool') {
      const st = part.state || {};
      if (!this.seenTool.has(part.callID) && (st.status === 'running' || st.status === 'completed' || st.status === 'error')) {
        this.seenTool.add(part.callID);
        this._frame(frames.toolUse(sid, part.callID, toolName(part.tool), toolInput(part.tool, st.input)));
      }
      if (st.status === 'completed' && !this.doneParts.has(part.id)) {
        this.doneParts.add(part.id);
        this._frame(frames.toolResult(sid, part.callID, st.output, false));
      } else if (st.status === 'error' && !this.doneParts.has(part.id)) {
        this.doneParts.add(part.id);
        const denied = /reject|denied|permission/i.test(String(st.error || ''));
        this._frame(frames.toolResult(sid, part.callID, denied ? 'Denied: the tool was not run.' : String(st.error || 'failed'), true));
      }
    } else if (part.type === 'step-finish' && live) {
      const t = part.tokens || {};
      this.tokens.set(part.id, { input: Number(t.input) || 0, output: Number(t.output) || 0 });
    }
  }

  async _onPermission(p) {
    const patterns = Array.isArray(p.patterns) ? p.patterns : [];
    const meta = p.metadata || {};
    const isBash = p.permission === 'bash';
    const subject = isBash ? (meta.command || patterns.join(' && ')) : (meta.filepath || meta.filePath || patterns.join(', '));
    let decision = 'deny';
    try {
      decision = await this.ask({
        toolName: isBash ? 'Bash' : (p.permission === 'webfetch' ? 'WebFetch' : 'Edit'),
        input: isBash ? { command: subject } : p.permission === 'webfetch' ? { url: meta.url || subject } : { file_path: subject },
        title: 'OpenCode wants to ' + (isBash ? 'run: ' : p.permission === 'webfetch' ? 'fetch: ' : 'change: ') + subject,
        description: '', itemId: (p.tool && p.tool.callID) || p.id,
      });
    } catch { decision = 'deny'; }
    try {
      await this._api('POST', '/permission/' + encodeURIComponent(p.id) + '/reply', { reply: decision === 'always' ? 'always' : decision === 'allow' ? 'once' : 'reject' });
    } catch { /* the turn ended or was aborted meanwhile */ }
  }

  /** OpenCode's own questions to the user have no card yet: decline rather than hang. */
  async _rejectQuestion(p) {
    try { await this._api('POST', '/question/' + encodeURIComponent(p.id) + '/reject', {}); } catch { /* gone */ }
  }

  _endTurn() {
    if (!this.busy) return;
    let input = 0; let output = 0;
    for (const t of this.tokens.values()) { input += t.input; output += t.output; }
    this.usage = { input_tokens: input, output_tokens: output };
    this.tokens.clear();
    const failed = !!this.lastError && !this.lastText;
    this._frame(frames.resultMsg(this.sessionId, {
      ok: !this.interrupted && !failed,
      text: this.interrupted ? 'Interrupted' : failed ? this.lastError : this.lastText,
      usage: this.usage, started: this.started,
    }));
    this._turnEnded();
  }

  async _replay() {
    const sid = this.sessionId;
    const msgs = await this._api('GET', '/session/' + encodeURIComponent(sid) + '/message', undefined, 30_000);
    for (const m of Array.isArray(msgs) ? msgs : []) {
      const role = m.info && m.info.role;
      for (const part of m.parts || []) {
        if (role === 'user') {
          if (part.type === 'text' && part.text && !part.synthetic) {
            this._frame({ type: 'user', session_id: sid, uuid: part.id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: part.text }] } });
          }
        } else {
          this._onPart(part, false);
        }
      }
    }
    this.lastText = '';
  }

  /* ---- lifecycle --------------------------------------------------------- */

  send(text, blocks) {
    const parts = toParts(text, blocks);
    if (!parts.length) return { ok: false };
    if (this.busy) { this.queue.push(parts); return { ok: true, queued: true }; }
    this._run(parts);
    return { ok: true };
  }

  _run(parts) {
    this.busy = true;
    this.interrupted = false;
    this.lastText = ''; this.lastError = '';
    this.started = Date.now();
    this.emit({ kind: 'status', busy: true });
    this._start()
      .then(() => {
        const model = splitModel(this.model);
        return this._api('POST', '/session/' + encodeURIComponent(this.sessionId) + '/prompt_async', { ...(model ? { model } : {}), parts }, 60_000);
      })
      .catch((err) => {
        if (!this.busy) return;
        this._frame(frames.resultMsg(this.sessionId, { ok: false, text: String((err && err.message) || err), usage: this.usage, started: this.started }));
        this._turnEnded();
      });
  }

  _turnEnded() {
    const next = this.queue.shift();
    if (next) return this._run(next);
    this.busy = false;
    this.emit({ kind: 'status', busy: false });
  }

  async interrupt() {
    const stillQueued = this.queue.length;
    this.queue = [];
    this.interrupted = true;
    if (this.child && this.sessionId) {
      try { await this._api('POST', '/session/' + encodeURIComponent(this.sessionId) + '/abort', {}, 5000); } catch { /* the turn may have just ended */ }
    }
    this.emit({ kind: 'interrupted', stillQueued });
    // An aborted turn goes idle by itself; if the server stays silent, end it here.
    setTimeout(() => { if (this.busy && this.interrupted) this._endTurn(); }, 3000).unref();
  }

  close() {
    this.closed = true;
    this.queue = [];
    if (this.eventAbort) { try { this.eventAbort.abort(); } catch { /* done */ } }
    const child = this.child;
    if (!child) return;
    terminate(child);
  }

  _stub() {
    return stubQuery('OpenCode', {
      interrupt: () => this.interrupt(),
      usage: () => ({ totalTokens: this.usage.input_tokens, maxTokens: 0, percentage: 0, categories: [] }),
    });
  }
}

module.exports = { OpenCodeChat, toParts, splitModel, withPermissions, toolName };
