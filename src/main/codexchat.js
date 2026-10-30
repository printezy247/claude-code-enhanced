// Codex chats over `codex app-server` (JSON-RPC on stdio) instead of one
// `codex exec` per message. The server keeps the conversation (thread) alive,
// takes images, resumes a thread by id, and asks the client before running a
// command or changing files, so CCE can show its usual Allow / Deny card.
// Emits the same Agent SDK message shapes as EngineChat, so the chat view,
// Board and window routing need to know nothing about it. #feat-codex-appserver
'use strict';
const { spawn } = require('child_process');
const { frames } = require('./enginechat');
const { terminate, appendTail, stubQuery } = require('./procutil');

// "untrusted": Codex asks before any command that is not a known-safe read,
// which is what the Allow / Deny card is for. ("on-request" let it run
// anything inside its sandbox without asking.)
const APPROVAL_POLICY = 'untrusted';
const REQUEST_TIMEOUT_MS = 30_000;

/** Anthropic-style content blocks (text, base64 images) -> app-server UserInput items. */
function toUserInput(text, blocks) {
  const input = [];
  const t = String(text || '');
  if (t) input.push({ type: 'text', text: t, text_elements: [] });
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.type === 'text' && b.text) input.push({ type: 'text', text: String(b.text), text_elements: [] });
    else if (b.type === 'image' && b.source && b.source.type === 'base64' && b.source.data) {
      input.push({ type: 'image', url: 'data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data });
    }
  }
  return input;
}

// What the footbar offers for Codex: the permission modes it can run in.
const MODES = [
  ['default', 'ask', 'Asks before running commands and editing files; edits stay inside this folder.'],
  ['plan', 'read-only', 'Read-only sandbox: Codex explores and proposes, and changes nothing.'],
  ['bypassPermissions', 'yolo', 'Nothing is asked or checked. Only for throwaway folders or containers.'],
];
// Mode -> what turn/start takes (the sandbox policy and approval policy).
const POLICY = {
  default: { approvalPolicy: APPROVAL_POLICY, sandboxPolicy: { type: 'workspaceWrite' } },
  plan: { approvalPolicy: APPROVAL_POLICY, sandboxPolicy: { type: 'readOnly' } },
  bypassPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
};

const fileKind = (c) => (c && c.kind && c.kind.type) || 'update';

class CodexChat {
  /**
   * `ask({ toolName, input, title, description })` resolves 'allow' | 'always'
   * | 'deny' (the host shows the card). `yolo` never asks and lifts the sandbox.
   */
  constructor({ command, cwd, env, yolo = false, model = '', extraArgs = [], sessionId = null, emit, ask, onThread }) {
    Object.assign(this, { command, cwd, env, yolo: !!yolo, model: model || '', extraArgs: extraArgs || [], emit: emit || (() => {}), ask: ask || (async () => 'deny'), onThread: onThread || (() => {}) });
    this.engine = 'codex';
    this.label = 'Codex';
    this.sessionId = sessionId;      // the Codex thread id
    this.busy = false;
    this.queue = [];
    this.child = null;
    this.rpcId = 0;
    this.pending = new Map();
    this.ready = null;               // promise: server initialised and thread open
    this.turnId = null;
    this.started = 0;
    this.lastText = '';
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.initSent = false;
    this.mode = this.yolo ? 'bypassPermissions' : 'default';
    this.effort = '';
    this.modelList = null;           // model/list, kept for the effort levels
    this.closed = false;
    this.interrupted = false;
    this.q = this._stub();
  }

  /* ---- JSON-RPC ---------------------------------------------------------- */

  _write(obj) {
    if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = ++this.rpcId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex did not answer ' + method)); }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this._write({ id, method, params });
    });
  }

  _onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && m.method == null) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'Codex error')); else p.resolve(m.result);
    } else if (m.id != null) {
      this._onServerRequest(m).catch(() => this._write({ id: m.id, error: { code: -32603, message: 'CCE could not handle this request' } }));
    } else if (m.method) {
      this._onNotification(m.method, m.params || {});
    }
  }

  /* ---- approvals --------------------------------------------------------- */

  async _onServerRequest(m) {
    const p = m.params || {};
    const reply = (result) => this._write({ id: m.id, result });
    if (m.method === 'item/commandExecution/requestApproval') {
      const decision = await this.ask({
        toolName: 'Bash', input: { command: p.command || '' },
        title: p.command ? 'Codex wants to run: ' + p.command : 'Codex wants to run a command',
        description: p.reason || '', itemId: p.itemId,
      });
      return reply({ decision: decision === 'always' ? 'acceptForSession' : decision === 'allow' ? 'accept' : 'decline' });
    }
    if (m.method === 'item/fileChange/requestApproval') {
      const decision = await this.ask({
        toolName: 'Edit', input: { file_path: p.grantRoot || '', reason: p.reason || '' },
        title: 'Codex wants to change files' + (p.grantRoot ? ' under ' + p.grantRoot : ''),
        description: p.reason || '', itemId: p.itemId,
      });
      return reply({ decision: decision === 'always' ? 'acceptForSession' : decision === 'allow' ? 'accept' : 'decline' });
    }
    // User-input, extra-permission, MCP-elicitation and dynamic-tool requests have
    // no card yet: refuse them rather than leave Codex waiting on a silent client.
    this._write({ id: m.id, error: { code: -32601, message: 'CCE does not handle ' + m.method + ' yet' } });
  }

  /* ---- notifications -> SDK frames --------------------------------------- */

  _frame(msg) { this.emit({ kind: 'message', msg }); }

  _onNotification(method, p) {
    const sid = this.sessionId;
    if (method === 'turn/started') { this.turnId = p.turn && p.turn.id; return; }
    if (method === 'thread/tokenUsage/updated') {
      const u = (p.tokenUsage && p.tokenUsage.total) || {};
      this.usage = { input_tokens: Number(u.inputTokens) || 0, output_tokens: Number(u.outputTokens) || 0 };
      this.contextWindow = Number(p.tokenUsage && p.tokenUsage.modelContextWindow) || 0;
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      this._onItem(p.item || {}, method === 'item/completed', sid);
      return;
    }
    if (method === 'turn/completed') { this._endTurn(p.turn || {}); return; }
    if (method === 'error' && p.error && !p.willRetry) this.lastError = p.error.message || this.lastError;
  }

  _onItem(it, done, sid) {
    switch (it.type) {
      case 'agentMessage':
        if (done && it.text) { this.lastText = it.text; this._frame(frames.textMsg(sid, it.text)); }
        break;
      case 'reasoning': {
        const t = [...(it.summary || []), ...(it.content || [])].join('\n').trim();
        if (done && t) this._frame(frames.thinkingMsg(sid, t));
        break;
      }
      case 'commandExecution':
        if (!done) this._frame(frames.toolUse(sid, it.id, 'Bash', { command: it.command }));
        else this._frame(frames.toolResult(sid, it.id,
          it.status === 'declined' ? 'Denied: the command was not run.' : it.aggregatedOutput,
          it.status === 'failed' || it.status === 'declined' || (it.exitCode != null && it.exitCode !== 0)));
        break;
      case 'fileChange': {
        const changes = Array.isArray(it.changes) ? it.changes : [];
        if (!done) this._frame(frames.toolUse(sid, it.id, 'Edit', { file_path: changes.map((c) => c.path).join(', '), changes }));
        else this._frame(frames.toolResult(sid, it.id, it.status === 'declined' ? 'Denied: the changes were not applied.' : changes.map((c) => `${fileKind(c)} ${c.path}`).join('\n'),
          it.status === 'failed' || it.status === 'declined'));
        break;
      }
      case 'mcpToolCall':
        if (!done) this._frame(frames.toolUse(sid, it.id, `mcp__${it.server}__${it.tool}`, it.arguments));
        else {
          const failed = it.status === 'failed' || !!it.error;
          const body = failed ? (it.error && it.error.message) || 'failed'
            : (it.result && Array.isArray(it.result.content) ? it.result.content.map((c) => c.text || '').join('\n') : '');
          this._frame(frames.toolResult(sid, it.id, body, failed));
        }
        break;
      case 'webSearch':
        if (!done) this._frame(frames.toolUse(sid, it.id, 'WebSearch', { query: it.query }));
        else this._frame(frames.toolResult(sid, it.id, '', false));
        break;
      case 'plan':
        if (done && it.text) this._frame(frames.textMsg(sid, it.text));
        break;
      case 'contextCompaction':
        if (done) this._frame({ type: 'system', subtype: 'compact_boundary', session_id: sid, compact_metadata: { trigger: 'manual' } });
        break;
      default: break;   // userMessage echoes, sleeps, review markers
    }
  }

  _endTurn(turn) {
    if (!this.busy) return;
    const status = turn.status;
    const failed = status === 'failed';
    const message = failed ? (turn.error && turn.error.message) || this.lastError || 'Codex turn failed' : this.lastText;
    if (status === 'interrupted') this._frame(frames.resultMsg(this.sessionId, { ok: false, text: 'Interrupted', usage: this.usage, started: this.started }));
    else this._frame(frames.resultMsg(this.sessionId, { ok: !failed, text: message, usage: this.usage, started: this.started }));
    this._turnEnded();
  }

  /* ---- lifecycle --------------------------------------------------------- */

  _start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.command, ['app-server', ...this.extraArgs], { cwd: this.cwd, env: this.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) { reject(err); return; }
      this.child = child;
      let buf = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) this._onLine(line); }
      });
      child.stderr.on('data', (d) => { stderr = appendTail(stderr, d); });
      child.stdin.on('error', () => {});
      const gone = (err) => {
        const wasBusy = this.busy;
        this.child = null; this.ready = null; this.turnId = null;
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (this.closed) return;
        if (wasBusy) {
          this._frame(frames.resultMsg(this.sessionId, { ok: false, text: String(err.message || err), usage: this.usage, started: this.started }));
          this._turnEnded();
        }
        reject(err);
      };
      child.on('error', (err) => gone(err));
      child.on('exit', (code) => gone(new Error('Codex app-server exited (code ' + code + ')' + (stderr.trim() ? ': ' + stderr.trim().slice(-300) : ''))));
      (async () => {
        await this._request('initialize', { clientInfo: { name: 'claude-code-enhanced', title: 'Claude Code Enhanced', version: '1' }, capabilities: null });
        this._write({ method: 'initialized', params: {} });
        const opts = {
          cwd: this.cwd, approvalPolicy: this.yolo ? 'never' : APPROVAL_POLICY,
          sandbox: this.yolo ? 'danger-full-access' : 'workspace-write',
          ...(this.model ? { model: this.model } : {}),
        };
        const res = this.sessionId
          ? await this._request('thread/resume', { threadId: this.sessionId, ...opts })
          : await this._request('thread/start', opts);
        const resumed = !!this.sessionId;
        this.sessionId = res.thread.id;
        this.onThread(this.sessionId);
        if (!this.initSent) { this.initSent = true; this._frame(frames.initMsg(this.sessionId, 'codex', { model: res.model || this.model || 'Codex' })); }
        if (resumed) await this._replay().catch(() => {});
        resolve();
      })().catch((err) => { try { this.child && this.child.kill(); } catch { /* gone */ } this.ready = null; reject(err); });
    });
    return this.ready;
  }

  /** Draw the earlier turns of a resumed thread, as the chat view draws a Claude transcript. */
  async _replay() {
    const r = await this._request('thread/read', { threadId: this.sessionId, includeTurns: true }, 30_000);
    const sid = this.sessionId;
    for (const turn of (r.thread && r.thread.turns) || []) {
      for (const it of turn.items || []) {
        if (it.type === 'userMessage') {
          const text = (it.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          if (text) this._frame({ type: 'user', session_id: sid, uuid: it.id, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
        } else {
          this._onItem(it, false, sid);
          this._onItem(it, true, sid);
        }
      }
    }
  }

  send(text, blocks) {
    if (/^\/compact\b/.test(String(text || '').trim())) return this.compact();
    const input = toUserInput(text, blocks);
    if (!input.length) return { ok: false };
    if (this.busy) { this.queue.push(input); return { ok: true, queued: true }; }
    this._run(input);
    return { ok: true };
  }

  _run(input) {
    this.busy = true;
    this.interrupted = false;
    this.lastText = ''; this.lastError = '';
    this.started = Date.now();
    this.emit({ kind: 'status', busy: true });
    this._start()
      // Model, effort and mode ride on every turn, so a change in the footbar
      // applies from the next message on.
      .then(() => this._request('turn/start', {
        threadId: this.sessionId, input, ...POLICY[this.mode],
        ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}),
      }, 60_000))
      .then((r) => { this.turnId = (r && r.turn && r.turn.id) || this.turnId; })
      .catch((err) => {
        if (!this.busy) return;
        this._frame(frames.resultMsg(this.sessionId, { ok: false, text: String((err && err.message) || err), usage: this.usage, started: this.started }));
        this._turnEnded();
      });
  }

  _turnEnded() {
    this.turnId = null;
    const next = this.queue.shift();
    if (next) return this._run(next);
    this.busy = false;
    this.emit({ kind: 'status', busy: false });
  }

  async interrupt() {
    const stillQueued = this.queue.length;
    this.queue = [];
    this.interrupted = true;
    if (this.child && this.turnId && this.sessionId) {
      try { await this._request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }, 5000); } catch { /* the turn may have just ended */ }
    }
    this.emit({ kind: 'interrupted', stillQueued });
  }

  /* ---- footbar controls ---------------------------------------------------- */

  get controls() { return { model: true, modes: MODES, effort: true, compact: true, context: true }; }

  async models() {
    if (!this.modelList) {
      await this._start();
      const r = await this._request('model/list', { limit: 100 }, 15_000);
      this.modelList = (r && r.data) || [];
    }
    return this.modelList.filter((m) => !m.hidden).map((m) => ({ id: m.model || m.id, displayName: m.displayName || m.model || m.id }));
  }

  async setModel(model) { this.model = String(model || ''); return { model: this.model }; }

  setMode(mode) {
    if (!POLICY[mode]) throw new Error('Codex has no ' + mode + ' mode');
    this.mode = mode;
    this.yolo = mode === 'bypassPermissions';   // yolo never asks
    return { permissionMode: mode };
  }

  setEffort(effort) { this.effort = String(effort || ''); return true; }

  /** Reasoning levels the current model accepts (the default model before one is picked). */
  async effortLevels() {
    await this.models();
    const m = this.modelList.find((x) => (x.model || x.id) === this.model) || this.modelList.find((x) => x.isDefault) || this.modelList[0];
    return ((m && m.supportedReasoningEfforts) || []).map((e) => e.reasoningEffort).filter(Boolean);
  }

  /** Summarize the thread in place. The server runs it as a turn of its own. */
  compact() {
    if (this.busy) return { ok: false, error: 'wait for the current turn to finish, then compact' };
    this.busy = true;
    this.interrupted = false;
    this.lastText = ''; this.lastError = '';
    this.started = Date.now();
    this.emit({ kind: 'status', busy: true });
    this._start()
      .then(() => this._request('thread/compact/start', { threadId: this.sessionId }, 30_000))
      .catch((err) => {
        if (!this.busy) return;
        this._frame(frames.resultMsg(this.sessionId, { ok: false, text: String((err && err.message) || err), usage: this.usage, started: this.started }));
        this._turnEnded();
      });
    return { ok: true };
  }

  close() {
    this.closed = true;
    this.queue = [];
    const child = this.child;
    if (!child) return;
    terminate(child);
  }

  /** Stand-in for the Agent SDK query object, as EngineChat has. */
  _stub() {
    return stubQuery('Codex', {
      interrupt: () => this.interrupt(),
      usage: () => ({ totalTokens: this.usage.input_tokens, maxTokens: this.contextWindow || 0, percentage: 0, categories: [] }),
      extra: {
        supportedModels: () => this.models(),
        setModel: (m) => this.setModel(m),
        setPermissionMode: async (m) => this.setMode(m),
        applyFlagSettings: async (patch) => this.setEffort(patch && patch.effort),
      },
    });
  }
}

module.exports = { CodexChat, toUserInput, APPROVAL_POLICY, MODES };
