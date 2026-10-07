// Chat sessions backed by the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
// One streaming-input query() process per chat tab — the same message stream the
// Claude Code desktop app renders: init (skills/slash commands/mcp/model),
// streaming text+thinking deltas, tool_use/tool_result, permission requests,
// and result frames with cost/usage.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const providers = require('./providers');

// The Agent SDK is ESM-only; load it lazily via dynamic import from CJS.
// In packaged builds the module must load from the UNPACKED on-disk copy —
// from inside app.asar the SDK can't resolve/spawn its engine (ENOTDIR).
let sdkPromise = null;
// Injection seam: tests pass a fake SDK so no engine process is spawned. The
// dynamic import below bypasses vitest's mock registry (the module is loaded
// through Node's CJS require), so a constructor argument is the reliable hook.
let sdkOverride = null;
function sdk() {
  if (sdkOverride) return Promise.resolve(sdkOverride);
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const { app } = require('electron');
      if (app.isPackaged) {
        const { pathToFileURL } = require('url');
        const p = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
        return await import(pathToFileURL(p).href);
      }
      return await import('@anthropic-ai/claude-agent-sdk');
    })();
  }
  return sdkPromise;
}

const PERM_TIMEOUT_MS = 6 * 60_000;

// Session files are uuid-v4 jsonl names; also the path-traversal guard.
function isSessionId(id) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(id || ''));
}

// Preview + summary from the head of a stored transcript (shared by the
// per-folder history panel and the flat all-session index).
function previewOf(full) {
  let text = '';
  try {
    const fd = fs.openSync(full, 'r');
    const b = Buffer.alloc(65536);
    const n = fs.readSync(fd, b, 0, 65536, 0);
    fs.closeSync(fd);
    text = b.slice(0, n).toString('utf8');
  } catch { return '(empty session)'; }
  let preview = '', summary = '';
  for (const line of text.split('\n')) {
    if (!summary && line.includes('"type":"summary"')) {
      try { const j = JSON.parse(line); if (j.summary) summary = j.summary; } catch { /* skip */ }
    }
    if (!preview && line.includes('"type":"user"')) {
      try {
        const j = JSON.parse(line);
        const c = j.message && j.message.content;
        const t = typeof c === 'string'
          ? c
          : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '');
        preview = String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      } catch { /* skip */ }
    }
    if (summary && preview) break;
  }
  return summary || preview || '(empty session)';
}

function cwdOf(full) {
  try {
    const fd = fs.openSync(full, 'r');
    const b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, 8192, 0);
    fs.closeSync(fd);
    const m = b.slice(0, n).toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (m) return JSON.parse('"' + m[1] + '"');
  } catch { /* skip */ }
  return null;
}

class ChatManager extends EventEmitter {
  constructor({ proxyToken = null, sdk = null } = {}) {
    super();
    this.proxyToken = proxyToken;
    if (sdk) sdkOverride = sdk;
    this.chats = new Map();      // id -> chat
    this.pendingPerms = new Map(); // requestId -> {resolve, timer, toolName}
    this.nextId = 1;
    this.permSeq = 1;
    this.lastCreatedId = null;
  }

  /** Remove a pending permission entry. Returns false if it was already gone. */
  _dropPerm(requestId) {
    const entry = this.pendingPerms.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingPerms.delete(requestId);
    return true;
  }

  /** Pending permission requests for one chat (used by close/interrupt). */
  _permsOf(chatId) {
    return [...this.pendingPerms.values()].filter(e => e.chatId === chatId);
  }

  async create({ cwd, providerInstance, settings, model, permissionMode, yolo, resume, resumeAt, claudePath, fork, anthropicBaseUrl }) {
    const { query } = await sdk();
    const opts_fork = !!fork;
    const id = 'c' + this.nextId++;
    const dir = (cwd || os.homedir()).replace(/^~(?=\/|$)/, os.homedir());
    const effMode = yolo ? 'bypassPermissions' : (permissionMode || 'default');

    // Streaming-input generator: stays open so every composer send feeds the
    // same CLI process (turns share session state, like the desktop app).
    const stream = this._makeInputStream();
    const options = {
      cwd: dir,
      permissionMode: effMode,
      allowDangerouslySkipPermissions: !!yolo,
      // 'local' was missing, so .claude/settings.local.json was never loaded — that
      // is where the CLI stores its own "always allow" rules, so approving a
      // tool in a terminal tab had no effect on chat tabs. #12
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,          // stream_event frames for live typing
      // Desktop-parity surface: file checkpoints (rewind), nested subagent
      // transcript, hook lifecycle frames, questions that never AFK-timeout.
      enableFileCheckpointing: true,
      extraArgs: { 'replay-user-messages': null },  // user messages carry uuid -> rewind anchors
      forwardSubagentText: true,
      includeHookEvents: true,
      askUserQuestionTimeout: 'never',
      env: { ...process.env, ...providers.envFor(providerInstance, settings) },
    };
    // Fail faster than the 300s default when the engine stream stalls mid-turn
    // (long Bash runs keep streaming, so a dead body means a dead turn).
    options.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '180000';
    if (model) options.model = model;
    if (resume && resume !== 'last') options.resume = resume;
    if (resume === 'last') {
      const last = this.lastChatFor(dir);
      if (last) options.resume = last;
    }
    // Branch the conversation itself from a message (edit-and-resubmit). The
    // SDK branches history; `resumeSessionAt` is the message anchor. #30
    if (resumeAt) options.resumeSessionAt = String(resumeAt);
    if (opts_fork) options.forkSession = true;   // branch from a session without touching the original
    // Per-provider lean tool set. Fewer tool schemas = a much smaller base
    // prompt, which is the real lever on the ~70K context floor that blocks
    // 3-4B local models. #41
    if (settings && settings.leanTools) {
      const lean = Array.isArray(settings.leanTools) ? settings.leanTools : [];
      if (lean.length) {
        options.tools = lean;
        options.disallowedTools = (settings.disallowedTools || []).map(String);
      }
    }
    // Sandboxed command execution (claude code sandbox: Bubblewrap on Linux).
    if (settings && settings.sandbox && settings.sandbox.enabled) {
      const s = settings.sandbox;
      options.sandbox = {
        enabled: true,
        failIfUnavailable: false,   // degrade gracefully if bwrap is missing
        autoAllowBashIfSandboxed: s.autoAllowBashIfSandboxed !== false,
        allowUnsandboxedCommands: !!s.allowUnsandboxedCommands,
        network: {
          allowLocalBinding: s.allowLocalBinding !== false,
          ...(Array.isArray(s.allowedDomains) && s.allowedDomains.length ? { allowedDomains: s.allowedDomains } : {}),
        },
      };
    }
    // Run the user's real claude executable (same auth/skills as the TUI);
    // the SDK's bundled copy can't be spawned from inside the asar archive.
    if (claudePath) options.pathToClaudeCodeExecutable = claudePath;
    // Optional caps from settings (#7): spend ceiling, turn ceiling, fallback model.
    if (settings) {
      if (Number(settings.maxBudgetUsd) > 0) options.maxBudgetUsd = Number(settings.maxBudgetUsd);
      if (Number(settings.maxTurns) > 0) options.maxTurns = Number(settings.maxTurns);
      if (settings.fallbackModel) options.fallbackModel = String(settings.fallbackModel);
      if (settings.context1m) options.betas = ['context-1m-2025-08-07'];
      if (Number(settings.thinkingBudget) > 0) {
        options.thinking = { type: 'enabled', budgetTokens: Number(settings.thinkingBudget) };
      }
      if (['low', 'medium', 'high', 'xhigh', 'max'].includes(String(settings.effort || '').trim())) {
        options.effort = String(settings.effort).trim();
      }
    }
    // Attribute the claude engine's stderr (debug logs, MCP/auth warnings).
    options.stderr = (data) => {
      for (const line of String(data).split('\n')) {
        if (line.trim()) console.error('[claude]', line);
      }
    };
    // (The duplicate `resume === 'last'` block that read a nonexistent
    // settings._lastChatByCwd was removed here — lastChatFor above is the one
    // real source. #18)

    if (anthropicBaseUrl) {
      // Route the engine through the built-in OpenAI-format translator
      options.env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
      // The proxy's own token, not the provider key: the proxy already holds
      // the credential and rejects requests without its token. #8
      options.env.ANTHROPIC_AUTH_TOKEN = this.proxyToken || 'proxy-key';
      options.env.ANTHROPIC_API_KEY = '';
    }

    // Each request keeps its own entry; several tools can be pending at once
    // (parallel tool calls, subagents). The old single-slot UI dropped all but
    // the last card and left the rest to time out. #2
    options.canUseTool = async (toolName, input, ctx = {}) => {
      const requestId = 'r' + (this.permSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
      return await new Promise((resolve) => {
        const entry = {
          chatId: id, requestId, toolName, input, resolve,
          // Suggestions come from the engine: they are the exact rule set that
          // would cover THIS call (e.g. `npm test *`), not the whole tool. #3
          suggestions: ctx.suggestions || [],
          suppressAlwaysAllowRule: !!ctx.suppressAlwaysAllowRule,
          // Metadata for the prompt text instead of a raw JSON dump. #28
          title: ctx.title || '', description: ctx.description || '',
          decisionReason: ctx.decisionReason || '', blockedPath: ctx.blockedPath || '',
          displayName: ctx.displayName || '', toolUseID: ctx.toolUseID || '',
          timer: setTimeout(() => {
            this._dropPerm(requestId);
            this.emit('event', id, { kind: 'permission-timeout', requestId });
            resolve({ behavior: 'deny', message: 'Permission request timed out (no answer in 6 minutes)' });
          }, PERM_TIMEOUT_MS),
        };
        this.pendingPerms.set(requestId, entry);
        ctx.signal && ctx.signal.addEventListener && ctx.signal.addEventListener('abort', () => {
          if (!this._dropPerm(requestId)) return;
          // Tell the UI so the card does not linger after an interrupt. #11
          this.emit('event', id, { kind: 'permission-cleared', requestId, reason: 'interrupted' });
          resolve({ behavior: 'deny', message: 'Interrupted' });
        }, { once: true });
        this.emit('event', id, {
          kind: 'permission', requestId, toolName, input,
          suggestions: entry.suggestions,
          suppressAlwaysAllowRule: entry.suppressAlwaysAllowRule,
          title: entry.title, description: entry.description,
          decisionReason: entry.decisionReason, blockedPath: entry.blockedPath,
          displayName: entry.displayName, toolUseID: entry.toolUseID,
          expiresAt: Date.now() + PERM_TIMEOUT_MS,
        });
      });
    };

    const chat = {
      id, cwd: dir, model: model || '', permissionMode: effMode,
      busy: false, sessionId: null,
      provider: providerInstance ? providers.publicInstance(providerInstance) : null,
      providerInstance,
      push: stream.push, close: null, lastResult: null,
      checkpoints: [],   // user-message uuids -> rewind anchors (file checkpointing)
    };
    this.lastCreatedId = id;
    const abort = new AbortController();
    chat.abort = abort;
    options.abortController = abort;
    this.chats.set(id, chat);

    const q = query({ prompt: stream.iterate(), options });
    chat.q = q;

    // Watchdog: if the engine never emits anything, tell the user instead of
    // leaving the tab silently dead (e.g. spawn failures inside the SDK).
    chat.gotFirstFrame = false;
    chat.watchdog = setTimeout(() => {
      if (!chat.gotFirstFrame) {
        this.emit('event', id, {
          kind: 'error',
          error: 'Chat engine did not start (no frames from the claude engine within 20s). '
            + 'Check the terminal output for [claude]/[cce] diagnostics — common causes: '
            + 'claude CLI path wrong in Settings, or auth expired (run /login in a terminal tab).',
        });
      }
    }, 20_000);

    (async () => {
      try {
        for await (const msg of q) {
          if (!chat.gotFirstFrame) {
            chat.gotFirstFrame = true;
            clearTimeout(chat.watchdog);
          }
          if (process.env.CCE_SMOKE) {
            console.log('[frame]', msg.type, msg.subtype || '',
              msg.type === 'assistant' ? JSON.stringify((msg.message?.content || []).map(b => b.type)) : '',
              msg.type === 'result' ? (msg.subtype + ' err=' + msg.is_error + ' ' + String(msg.result).slice(0, 120)) : '');
          }
          if (msg.session_id) chat.sessionId = msg.session_id;
          if (msg.type === 'system' && msg.subtype === 'init') {
            chat.model = msg.model || chat.model;
            this._rememberSession(dir, chat.sessionId);
          }
          if (msg.type === 'result') {
            chat.busy = false;
            chat.lastResult = msg;
            this.emit('event', id, { kind: 'status', busy: false });
          }
          // Rewind anchors: uuid-stamped user prompts (checkpointing on).
          if (msg.type === 'user' && msg.uuid && !msg.parent_tool_use_id) {
            const c = msg.message && msg.message.content;
            const isResult = Array.isArray(c) && c.some(b => b.type === 'tool_result');
            if (!isResult) {
              const text = typeof c === 'string'
                ? c
                : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '');
              chat.checkpoints.push({ uuid: msg.uuid, text: String(text || '(prompt)').slice(0, 120), at: Date.now() });
              if (chat.checkpoints.length > 100) chat.checkpoints.shift();
            }
          }
          if (msg.type === 'auth_status') {
            this.emit('event', id, { kind: 'auth', authenticating: !!msg.isAuthenticating, output: msg.output || [], error: msg.error || '' });
          }
          if (msg.type === 'system' && ['task_started', 'task_updated', 'task_progress', 'task_notification'].includes(msg.subtype)) {
            this.emit('event', id, { kind: 'task', msg });
          } else if (msg.type === 'system' && (msg.subtype === 'hook_started' || msg.subtype === 'hook_response')) {
            this.emit('event', id, { kind: 'hook', msg });
          }
          this.emit('event', id, { kind: 'message', msg });
        }
        this.emit('event', id, { kind: 'exit' });
        this.chats.delete(id);
      } catch (err) {
        if (!/abort/i.test(String(err && err.message))) {
          this.emit('event', id, { kind: 'error', error: String((err && err.message) || err) });
        }
        this.emit('event', id, { kind: 'exit' });
        this.chats.delete(id);
      }
    })();

    return {
      id, cwd: dir, model: chat.model, permissionMode: effMode,
      provider: chat.provider, sandbox: !!(settings && settings.sandbox && settings.sandbox.enabled),
      resumedFrom: (options.resume || null),
    };
  }

  _makeInputStream() {
    const queue = [];
    let wake = null;
    return {
      push(m) {
        if (wake) { const w = wake; wake = null; w(m); }
        else queue.push(m);
      },
      iterate: async function* () {
        for (;;) {
          if (queue.length) yield queue.shift();
          else yield await new Promise((r) => { wake = r; });
        }
      },
    };
  }

  _rememberSession(dir, sessionId) {
    if (!sessionId) return;
    try {
      // Stored outside settings.set (which would rewrite the file per chat);
      // keep a side-file to avoid config.json churn.
      const file = path.join(process.env.HOME || os.homedir(), '.claude', 'cce-chat-sessions.json');
      let data = {};
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
      data[dir] = sessionId;
      // keep it bounded
      const keys = Object.keys(data);
      if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(k => delete data[k]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch { /* non-fatal */ }
  }

  lastChatFor(cwd) {
    try {
      const dir = (cwd || '~').replace(/^~(?=\/|$)/, os.homedir());
      const file = path.join(process.env.HOME || os.homedir(), '.claude', 'cce-chat-sessions.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data[dir] || null;
    } catch { return null; }
  }

  send(id, text, blocks) {
    const chat = this.chats.get(id);
    if (!chat || (!text && !(blocks && blocks.length))) return { ok: false };
    // Anthropic content blocks (e.g. pasted images) or plain text
    const content = blocks && blocks.length
      ? [...blocks, ...(text ? [{ type: 'text', text }] : [])]
      : text;
    chat.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: chat.sessionId || '' });
    chat.busy = true;
    this.emit('event', id, { kind: 'status', busy: true });
    return { ok: true };
  }

  async interrupt(id) {
    const chat = this.chats.get(id);
    if (!chat) return;
    let stillQueued = 0;
    try {
      const r = await chat.q.interrupt();
      stillQueued = (r && Array.isArray(r.still_queued)) ? r.still_queued.length : 0;
    } catch { /* may already be stopping */ }
    chat.busy = false;
    this.emit('event', id, { kind: 'status', busy: false });
    this.emit('event', id, { kind: 'interrupted', stillQueued });
  }

  /* ---- desktop-parity control surface (context, rewind, mcp, agents…) ---- */

  _chat(id) {
    const c = this.chats.get(id);
    if (!c) throw new Error('chat not found');
    return c;
  }

  // Context-window usage: { totalTokens, maxTokens, percentage, categories }.
  async context(id) {
    return await this._chat(id).q.getContextUsage();
  }

  // File checkpointing: restore every tracked file to the state at a user
  // message uuid. Conversation itself is NOT rewound.
  async rewind(id, uuid, opts = {}) {
    if (!/^[a-f0-9-]{30,}$/i.test(String(uuid || ''))) throw new Error('invalid checkpoint id');
    const r = await this._chat(id).q.rewindFiles(uuid, opts);
    return {
      rewound: true,
      // skippedLinks is a COUNT per the SDK's RewindFilesResult, but older
      // builds returned a list; accept either. The old code checked
      // Array.isArray() and therefore always reported 0.
      skipped: r && typeof r === 'object' ? (Array.isArray(r.skippedLinks) ? r.skippedLinks.length : Number(r.skippedLinks) || 0) : 0,
      filesChanged: (r && r.filesChanged) || [],
      insertions: (r && r.insertions) || 0,
      deletions: (r && r.deletions) || 0,
      canRewind: r ? r.canRewind !== false : true,
      error: r && r.error,
    };
  }

  checkpoints(id) {
    return this._chat(id).checkpoints.slice(-50);
  }

  async mcpStatus(id) { return await this._chat(id).q.mcpServerStatus(); }
  async mcpToggle(id, name, enabled) { return await this._chat(id).q.toggleMcpServer(String(name), !!enabled); }
  async mcpReconnect(id, name) { return await this._chat(id).q.reconnectMcpServer(String(name)); }
  async agents(id) { return await this._chat(id).q.supportedAgents(); }
  async applyFlags(id, patch) { return await this._chat(id).q.applyFlagSettings(patch || {}); }
  async stopTask(id, taskId) { await this._chat(id).q.stopTask(String(taskId)); return { stopped: true }; }

  async setModel(id, model) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    await chat.q.setModel(model || undefined);
    chat.model = model || chat.model;
    return { model: chat.model };
  }

  async setMode(id, mode) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    await chat.q.setPermissionMode(mode);
    chat.permissionMode = mode;
    return { permissionMode: mode };
  }

  async commands(id) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    return await chat.q.supportedCommands();
  }

  // Fork the live session: renderer re-creates a chat with resume+forkSession.
  forkParams(id) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    if (!chat.sessionId) throw new Error('session has not started yet — send a message first');
    return {
      cwd: chat.cwd,
      providerUid: chat.providerInstance ? chat.providerInstance.uid : null,
      model: chat.model || '',
      permissionMode: chat.permissionMode,
      sessionId: chat.sessionId,
    };
  }

  deleteSession(cwd, sessionId) {
    if (!isSessionId(sessionId)) throw new Error('invalid session id');
    const { projDir } = this.projDirFor(cwd);
    fs.rmSync(path.join(projDir, sessionId + '.jsonl'), { force: true });
    return { deleted: true };
  }

  deleteFolder(cwd) {
    if (!cwd) throw new Error('cwd required');
    const { projDir } = this.projDirFor(cwd);
    let n = 0;
    try {
      for (const f of fs.readdirSync(projDir)) {
        if (f.endsWith('.jsonl')) { fs.rmSync(path.join(projDir, f), { force: true }); n++; }
      }
    } catch { /* folder absent */ }
    return { deleted: n };
  }

  // The engine stores transcripts in ~/.claude/projects/<munged cwd>/<id>.jsonl,
  // where the munge turns every non-alphanum char into '-'. A guessed munge
  // misses on some paths (spaces, dots, unicode), so when the guess is absent
  // match the cwd recorded inside the transcripts instead.
  projDirFor(cwd) {
    const home = process.env.HOME || os.homedir();
    const dir = (cwd || '~').replace(/^~(?=\/|$)/, home);
    const root = path.join(home, '.claude', 'projects');
    const guess = path.join(root, dir.replace(/[^a-zA-Z0-9-]/g, '-'));
    if (fs.existsSync(guess)) return { dir, projDir: guess };
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const p = path.join(root, d.name);
        let files = [];
        try { files = fs.readdirSync(p).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        for (const f of files.slice(0, 5)) {
          let head = '';
          try {
            const fd = fs.openSync(path.join(p, f), 'r');
            const b = Buffer.alloc(8192);
            const n = fs.readSync(fd, b, 0, 8192, 0);
            fs.closeSync(fd);
            head = b.slice(0, n).toString('utf8');
          } catch { continue; }
          const m = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
          if (!m) continue;
          try { if (JSON.parse('"' + m[1] + '"') === dir) return { dir, projDir: p }; } catch { /* bad json */ }
        }
      }
    } catch { /* unreadable root */ }
    return { dir, projDir: guess };
  }

  // Replay a stored session transcript so resumed chats show their past conversation.
  // Items are ordered as written: user text, thinking, tool_use (+ its tool_result
  // output attached), assistant text.
  transcript(cwd, sessionId) {
    if (!isSessionId(sessionId)) throw new Error('invalid session id');
    const { projDir } = this.projDirFor(cwd);
    let raw = '';
    try { raw = fs.readFileSync(path.join(projDir, sessionId + '.jsonl'), 'utf8'); } catch { return { items: [] }; }
    const items = [];
    const tools = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.isSidechain || j.isMeta || j.type === 'summary') continue;
      if (j.type !== 'user' && j.type !== 'assistant') continue;
      const msg = j.message;
      if (!msg || !msg.content) continue;
      if (j.type === 'user') {
        const c = msg.content;
        if (typeof c === 'string') {
          const t = c.replace(/<[^>]+>/g, '').trim();
          if (t) items.push({ t: 'user', text: t });
        } else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'text') {
              const t = b.text.replace(/<[^>]+>/g, '').trim();
              if (t) items.push({ t: 'user', text: t });
            } else if (b.type === 'tool_result') {
              const it = tools.get(b.tool_use_id);
              if (it) {
                const out = typeof b.content === 'string'
                  ? b.content
                  : Array.isArray(b.content) ? b.content.map(x => x.type === 'text' ? x.text : '[' + x.type + ']').join('\n') : '';
                it.output = String(out || '').slice(0, 4000);
                it.isError = !!b.is_error;
              }
            }
          }
        }
      } else {
        for (const b of msg.content || []) {
          if (b.type === 'text' && b.text && b.text.trim()) items.push({ t: 'assistant', text: b.text });
          else if (b.type === 'thinking' && b.thinking) items.push({ t: 'thinking', text: b.thinking });
          else if (b.type === 'tool_use') {
            const it = { t: 'tool', name: b.name, input: b.input || {} };
            items.push(it);
            tools.set(b.id, it);
          }
        }
      }
    }
    return { items: items.slice(-300) };
  }

  // Past sessions for a folder, from the claude engine's own transcript store  // (~/.claude/projects/<path-with-dashes>/<sessionId>.jsonl) — includes TUI sessions.
  history(cwd) {
    const { projDir } = this.projDirFor(cwd);
    let files = [];
    try { files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
    const out = [];
    for (const f of files) {
      const full = path.join(projDir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      out.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        mtime: st.mtimeMs,
        preview: previewOf(full).slice(0, 140),
      });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, 40);
  }

  // Flat, recency-sorted index of every stored session across all folders.
  index() {
    const home = process.env.HOME || os.homedir();
    const root = path.join(home, '.claude', 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return []; }
    // newest folders first — old folders are dead weight on big disks
    const folders = dirs.map(d => {
      const full = path.join(root, d.name);
      let m = 0;
      try { m = fs.statSync(full).mtimeMs; } catch { /* unreadable */ }
      return { name: d.name, full, m };
    }).sort((a, b) => b.m - a.m).slice(0, 80);

    const found = [];
    for (const fo of folders) {
      let files = [];
      try { files = fs.readdirSync(fo.full).filter(x => x.endsWith('.jsonl')); } catch { continue; }
      for (const file of files) {
        try {
          const full = path.join(fo.full, file);
          const st = fs.statSync(full);
          found.push({ folder: fo.name, full, sessionId: file.replace(/\.jsonl$/, ''), mtime: st.mtimeMs });
        } catch { /* skip */ }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    // previews are IO — only for the rows we will actually show
    return found.slice(0, 300).map(s => ({
      folder: s.folder,
      cwd: cwdOf(s.full),
      sessionId: s.sessionId,
      mtime: s.mtime,
      preview: previewOf(s.full).slice(0, 120),
    }));
  }

  answer(id, requestId, decision, answers) {
    const entry = this.pendingPerms.get(requestId);
    // Scope by chat: requestIds are unique, but a stale card in another tab
    // must never be able to answer this tab's request. #20
    if (!entry || entry.chatId !== id) return { ok: false, error: 'request no longer pending' };
    this._dropPerm(requestId);
    if (decision === 'deny') {
      entry.resolve({ behavior: 'deny', message: 'User denied this tool use.' });
    } else if (answers && typeof answers === 'object' && Object.keys(answers).length) {
      // AskUserQuestion: picked labels ride on the permission result as the
      // tool's answers (engine reads updatedInput.answers, keyed by question).
      entry.resolve({ behavior: 'allow', updatedInput: { ...(entry.input || {}), answers } });
    } else if (decision === 'always') {
      // Use the engine's own suggestions. A bare { toolName } rule approves EVERY
      // use of the tool for the session — one "yes" to `ls` would have allowed
      // `rm -rf`. The SDK documents updatedPermissions as the intended channel. #3
      if (entry.suppressAlwaysAllowRule) {
        entry.resolve({ behavior: 'allow' });
      } else if (entry.suggestions.length) {
        entry.resolve({ behavior: 'allow', updatedPermissions: entry.suggestions });
      } else {
        // No suggestions available: allow just this call rather than granting a
        // blanket rule. Safer default than the old behaviour.
        entry.resolve({ behavior: 'allow' });
      }
    } else entry.resolve({ behavior: 'allow' });
    return { ok: true };
  }

  close(id) {
    const chat = this.chats.get(id);
    // Deny anything still waiting so no promise is left hanging after close. #20
    for (const entry of this._permsOf(id)) {
      if (this._dropPerm(entry.requestId)) {
        this.emit('event', id, { kind: 'permission-cleared', requestId: entry.requestId, reason: 'closed' });
        try { entry.resolve({ behavior: 'deny', message: 'Session closed' }); } catch { /* resolved already */ }
      }
    }
    if (!chat) return;
    try { chat.abort.abort(); } catch { /* already closing */ }
  }

  killAll() {
    for (const id of [...this.chats.keys()]) this.close(id);
  }

  // Skills panel data: names from the live init frame are authoritative; this
  // filesystem scan adds descriptions + invocation hints from SKILL.md frontmatter.
  scanSkills(cwd) {
    const out = [];
    const roots = [
      path.join(process.env.HOME || os.homedir(), '.claude', 'skills'),
      path.join((cwd || '').replace(/^~(?=\/|$)/, os.homedir()), '.claude', 'skills'),
    ];
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const file = path.join(root, e.name, 'SKILL.md');
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const fm = text.split(/^---\s*$/m)[1] || '';
        const name = (fm.match(/^name:\s*(.+)$/m) || [])[1] || e.name;
        const description = (fm.match(/^description:\s*(.+)$/m) || [])[1] || '';
        out.push({ name: name.trim(), description: description.trim(), source: root.startsWith(process.env.HOME || os.homedir()) ? 'user' : 'project' });
      }
    }
    return out;
  }
}

module.exports = ChatManager;
