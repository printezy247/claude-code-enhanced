// Chat sessions backed by the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
// One streaming-input query() process per chat tab — the same message stream the
// Claude Code desktop app renders: init (skills/slash commands/mcp/model),
// streaming text+thinking deltas, tool_use/tool_result, permission requests,
// and result frames with cost/usage.
'use strict';
const { classifyUserText } = require('../shared/usertext.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const providers = require('./providers');
const { promptAppend: bootstrapPrompt, syncedSkillsPlugin } = require('./bootstrap');
const { atomicWriteJson, readJsonSafe } = require('./atomic');
const { compactBashOutput, compactToolOutput, toolResultText, clampMaxChars } = require('./toolfilter');
const managedconfig = require('./managedconfig');
const { createLoopGuard } = require('./loopguard');
const { absFor, shareablePath } = require('./fileshare');
const sdkoptions = require('./sdkoptions');

// The Agent SDK is ESM-only; load it lazily via dynamic import from CJS.
// In packaged builds the module must load from the UNPACKED on-disk copy —
// from inside app.asar the SDK can't resolve/spawn its engine (ENOTDIR).
// Injection seam: tests pass a fake SDK so no engine process is spawned. The
// dynamic import below bypasses vitest's mock registry (the module is loaded
// through Node's CJS require), so a constructor argument is the reliable hook —
// and it must stay per-instance, or one fake leaks into every later manager.
let sdkPromise = null;
function loadSdk() {
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
// How often a running shell task is polled for its output tail, and how long
// the first poll waits. The first one is quick so the card starts filling
// almost at once; the rest are steady. #feat-live-output
const TASK_POLL_FIRST_MS = 250;
const TASK_POLL_MS = 700;
const PERM_TIMEOUT_MESSAGE = 'The user did not answer this permission request within 6 minutes (they may be away). '
  + 'Do not retry this call or a variant of it. Finish anything that needs no permission, then stop and tell '
  + 'the user exactly which action is waiting for their approval.';

// Policy helpers live in tools.js (single source of truth); alias locally so
// the rest of this module keeps reading the same names. #B1
const toolPolicy = require('./tools');
const WRITE_TOOLS = toolPolicy.WRITE_TOOLS;
const isVmPath = toolPolicy.isVmPath;
const targetFilePath = toolPolicy.targetFilePath;
const isOutsideDirs = toolPolicy.isOutsideDirs;

/** Chat models are assumed to have this window unless told otherwise. */
const { ENGINE_DEFAULT_WINDOW } = require('./modelcontext');

/**
 * Engine settings that shrink every request on a translated provider, where
 * there is no prompt caching and each call pays for the whole prompt again.
 *
 * - Tool search: MCP tools are announced by name and loaded when the model asks
 *   for one, instead of sending every schema (~75k tokens with a dozen MCP
 *   servers) on every request. The engine turns it off for non-Anthropic base
 *   URLs because most proxies drop its `tool_reference` results; this proxy
 *   translates them.
 * - Context window: the engine's 200k default is overridden whenever the
 *   model's real window differs — smaller so compaction happens in time
 *   instead of failing with "prompt is too long", larger so 1M models
 *   actually get 1M.
 *
 * Values the user set themselves are left alone.
 */
function leanEngineEnv({ env = {}, provider, model, settings = {}, contextOf } = {}) {
  const out = {};
  if (!provider || (provider.protocol || 'openai') === 'anthropic') return out;
  if (settings.toolSearch !== false && env.ENABLE_TOOL_SEARCH == null) out.ENABLE_TOOL_SEARCH = 'true';
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS != null) {
    out.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS); // user's own choice wins
  } else if (typeof contextOf === 'function') {
    const ctx = Number(contextOf(provider, model)) || 0;
    if (ctx > 0 && ctx !== ENGINE_DEFAULT_WINDOW) out.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx);
  }
  return out;
}

/**
 * A writable npm cache for sandboxed chats (`npx` needs to write one; the
 * sandbox keeps ~/.npm read-only). Null when the folder cannot be made.
 */
function sandboxNpmCache(home = os.homedir()) {
  const dir = path.join(home, '.cache', 'claude-code-enhanced', 'npm');
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return null; }
}

/**
 * Plugins that replace tool output with "indexed, search for it" stubs. Claude
 * follows that up; most third-party models do not, re-run the same command
 * and loop. Off by default on translated providers; `settings.contextMode`
 * 'on' keeps them, 'off' drops them everywhere.
 */
const OUTPUT_HIDING_PLUGINS = ['context-mode@context-mode'];

function pluginOverrides({ provider, settings = {} } = {}) {
  const mode = settings.contextMode || 'auto';
  const translated = !!provider && (provider.protocol || 'openai') !== 'anthropic';
  if (mode === 'on' || (mode === 'auto' && !translated)) return null;
  return { enabledPlugins: Object.fromEntries(OUTPUT_HIDING_PLUGINS.map((p) => [p, false])) };
}

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
    try {
      const b = Buffer.alloc(65536);
      const n = fs.readSync(fd, b, 0, 65536, 0);
      text = b.slice(0, n).toString('utf8');
    } finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
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

/**
 * Turn stored transcript records into the flat item list the chat pane replays:
 * user text, thinking, tool_use (with its tool_result output attached),
 * assistant text. Shared by the file reader and the SDK reader.
 */
function transcriptItems(records) {
  const items = [];
  const tools = new Map();
  for (const j of records || []) {
    if (j.isSidechain || j.isMeta || j.type === 'summary') continue;
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const msg = j.message;
    if (!msg || !msg.content) continue;
    if (j.type === 'user') {
      const c = msg.content;
      // Keep the uuid: it is what forkSession({ upToMessageId }) needs, so the
      // transcript can branch from any message rather than only the latest.
      const pushText = (raw) => {
        const k = classifyUserText(raw, j);
        if (k.kind === 'skip' || !k.text) return;
        if (k.kind === 'prompt') items.push({ t: 'user', text: k.text.replace(/<[^>]+>/g, '').trim(), uuid: j.uuid || null });
        else items.push({ t: k.kind, text: k.text });
      };
      if (typeof c === 'string') {
        pushText(c);
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text') {
            pushText(b.text);
          } else if (b.type === 'tool_result') {
            const it = tools.get(b.tool_use_id);
            if (it) {
              const out = typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content) ? b.content.map((x) => x.type === 'text' ? x.text : '[' + x.type + ']').join('\n') : '';
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
  return items.slice(-300);
}

function cwdOf(full) {
  try {
    const fd = fs.openSync(full, 'r');
    try {
      const b = Buffer.alloc(8192);
      const n = fs.readSync(fd, b, 0, 8192, 0);
      const m = b.slice(0, n).toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse('"' + m[1] + '"');
    } finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
  } catch { /* skip */ }
  return null;
}

class ChatManager extends EventEmitter {
  constructor({ proxyToken = null, sdk = null, contextOf = null } = {}) {
    super();
    this.proxyToken = proxyToken;
    // (provider, model) -> context window in tokens, or 0 when unknown.
    this.contextOf = contextOf;
    // Per instance, not module-global: a global leaked one instance's fake SDK
    // into every later ChatManager, so the session helpers silently fell back
    // to the disk scan in tests and in any second manager.
    this.sdkOverride = sdk || null;
    this.chats = new Map();      // id -> chat
    this.pendingPerms = new Map(); // requestId -> {resolve, timer, toolName}
    this.pendingElicits = new Map(); // requestId -> {resolve, timer} for MCP elicitations #feat-elicitation
    this.nextId = 1;
    this.permSeq = 1;
    this.lastCreatedId = null;
    // taskId -> { chatId, toolUseId, timer, text }: the running shell tasks
    // whose output is streamed into the tool card. #feat-live-output
    this.taskPolls = new Map();
    // toolUseId -> taskId: the join key between a task and its tool call.
    this.taskByTool = new Map();
  }

  /** The SDK for this manager: the injected fake, else the real module. */
  sdk() {
    return this.sdkOverride ? Promise.resolve(this.sdkOverride) : loadSdk();
  }

  /** Remove a pending permission entry. Returns false if it was already gone. */
  _dropElicit(requestId) {
    const entry = this.pendingElicits.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingElicits.delete(requestId);
    return true;
  }

  /** Answer a pending MCP elicitation from the renderer card. #feat-elicitation */
  answerElicitation(id, requestId, action, content) {
    const entry = this.pendingElicits.get(requestId);
    if (!entry || entry.chatId !== id) return { ok: false, error: 'no pending elicitation' };
    this._dropElicit(requestId);
    const a = (action === 'accept' || action === 'decline' || action === 'cancel') ? action : 'decline';
    entry.resolve({ action: a, content: a === 'accept' ? (content && typeof content === 'object' ? content : {}) : undefined });
    return { ok: true };
  }

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

  /**
   * The tools the user already approved for this chat ('always_ask_session').
   * The grant lives on the chat, so it ends with the chat and never leaks
   * into the next one.
   */
  _sessionGrants(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    if (!chat.sessionGrants) chat.sessionGrants = new Set();
    return chat.sessionGrants;
  }

  _hasSessionGrant(chatId, toolName) {
    const grants = this._sessionGrants(chatId);
    return !!grants && grants.has(String(toolName));
  }

  _grantSession(chatId, toolName) {
    const grants = this._sessionGrants(chatId);
    if (grants) grants.add(String(toolName));
  }

  /**
   * A dialog the CLI asks the host to render (`request_user_dialog`).
   *
   * Only the kinds CCE declares are answered. An undeclared kind must NOT be
   * answered with {behavior:'cancelled'}: that is a real settlement which
   * counts as the user dismissing the dialog. Returning null leaves it
   * unanswered, and the CLI cancels it when its own deadline passes. #t1
   */
  async _userDialog(chatId, request, ctx = {}) {
    const kind = String((request && request.dialog_kind) || '');
    if (kind !== 'refusal_fallback_prompt') return null;
    if (ctx.signal && ctx.signal.aborted) return null;
    const payload = (request && request.payload) || {};
    const content = String(payload.content || payload.text || payload.message || '');
    const requestId = 'd' + (this.permSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
    const answer = await new Promise((resolve) => {
      const entry = {
        chatId, requestId, resolve,
        timer: setTimeout(() => {
          this._dropElicit(requestId);
          this.emit('event', chatId, { kind: 'elicitation-cleared', requestId, reason: 'timeout' });
          resolve({ action: 'decline' });
        }, PERM_TIMEOUT_MS),
      };
      this.pendingElicits.set(requestId, entry);
      ctx.signal && ctx.signal.addEventListener && ctx.signal.addEventListener('abort', () => {
        if (!this._dropElicit(requestId)) return;
        this.emit('event', chatId, { kind: 'elicitation-cleared', requestId, reason: 'interrupted' });
        resolve({ action: 'cancel' });
      }, { once: true });
      this.emit('event', chatId, {
        kind: 'elicitation', requestId,
        serverName: 'claude', message: content,
        mode: 'form', url: '', elicitationId: '',
        requestedSchema: {
          type: 'object',
          properties: { content: { type: 'string', title: 'Your answer' } },
          required: ['content'],
        },
        title: 'Claude needs your input',
        displayName: 'Claude needs your input',
        description: 'The model refused this prompt. Send a new one, or let it continue.',
        expiresAt: Date.now() + PERM_TIMEOUT_MS,
      });
    });
    if (!answer || answer.action !== 'accept') return { behavior: 'deny' };
    const text = String((answer.content && answer.content.content) || content || '');
    // The exact result shape for this kind is not published in the SDK types;
    // the CLI only checks that the result carries a `behavior`. Extra keys are
    // ignored, so the text travels under every name the CLI looks for.
    return {
      behavior: 'allow',
      content: text,
      updatedInput: { content: text, text, prompt: text },
      refusal_fallback: { content: text },
    };
  }

  async create({ cwd, providerInstance, settings, model, permissionMode, yolo, resume, resumeAt, claudePath, fork, anthropicBaseUrl }) {
    const { query } = await this.sdk();
    const opts_fork = !!fork;
    const id = 'c' + this.nextId++;
    const dir = (cwd || os.homedir()).replace(/^~(?=\/|$)/, os.homedir());
    const effMode = normalizeMode(permissionMode, providerInstance, yolo);

    // Streaming-input generator: stays open so every composer send feeds the
    // same CLI process (turns share session state, like the desktop app).
    const stream = this._makeInputStream();
    const options = {
      cwd: dir,
      permissionMode: effMode,
      allowDangerouslySkipPermissions: !!yolo || effMode === 'bypassPermissions',
      // 'local' was missing, so .claude/settings.local.json was never loaded — that
      // is where the CLI stores its own "always allow" rules, so approving a
      // tool in a terminal tab had no effect on chat tabs. #12
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,          // stream_event frames for live typing
      allowedTools: Array.from(new Set([
        'WebFetch',
        'WebSearch',
        ...(Array.isArray(settings?.allowedTools) ? settings.allowedTools : []),
      ])),
      // Desktop-parity surface: file checkpoints (rewind), nested subagent
      // transcript, hook lifecycle frames, questions that never AFK-timeout.
      enableFileCheckpointing: true,
      extraArgs: { 'replay-user-messages': null },  // user messages carry uuid -> rewind anchors
      forwardSubagentText: true,
      includeHookEvents: true,
      // Suggested next prompts and subagent progress summaries: both feed the
      // UI chips the desktop app shows. #37
      promptSuggestions: true,
      agentProgressSummaries: true,
      askUserQuestionTimeout: 'never',
      env: { ...process.env, ...providers.envFor(providerInstance, settings) },
      // PATH from the user's login shell, so the agent's Bash tool can see
      // bun/uv/nvm and anything else in .bashrc. #13
      ...(settings && settings.loginEnv ? { PATH: settings.loginEnv.PATH || process.env.PATH } : {}),
    };
    // Fail faster than the 300s default when the engine stream stalls mid-turn
    // (long Bash runs keep streaming, so a dead body means a dead turn).
    options.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '180000';
    // Shell-output filter. The model reads a compacted result; the card in the
    // UI keeps the original, so nothing is hidden from the user. #feat-output-filter
    if (!settings || settings.outputFilter !== 'off') {
      // The budget is clamped to the range the Settings row promises, in the
      // main process: this is the code that uses the number, and a
      // hand-edited config.json must not hand the model an unbounded result.
      // #F1
      const maxChars = clampMaxChars(settings && settings.outputFilterMaxChars);
      options.hooks = {
        PostToolUse: [{
          matcher: 'Bash',
          hooks: [async (input) => {
            const name = String((input && input.tool_name) || '');
            if (name !== 'Bash') return {};
            const original = toolResultText(input.tool_response);
            if (!original) return {};
            const command = (input.tool_input && input.tool_input.command) || '';
            const r = compactBashOutput({ output: original, command, maxChars });
            // Nothing was cut: the model already reads everything, and the
            // card would show the same text twice.
            if (!r.compacted) return {};
            this.emit('event', id, { kind: 'tool-original', toolUseId: input.tool_use_id, text: r.original });
            return {
              hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput: r.text,
              },
            };
          }],
        }],
      };
    }
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
    // The deny list is not a lean-mode extra: a tool the user blocked must
    // stay blocked in every mode. It used to be set only inside the lean
    // branch, so the normal mode ignored the block list completely. #t0
    options.disallowedTools = (settings && Array.isArray(settings.disallowedTools))
      ? settings.disallowedTools.map(String).filter(Boolean)
      : [];
    // Per-provider lean tool set. Fewer tool schemas = a much smaller base
    // prompt, which is the real lever on the ~70K context floor that blocks
    // 3-4B local models. #41
    let isLean = false;
    if (settings && settings.leanTools) {
      const lean = Array.isArray(settings.leanTools) ? settings.leanTools : [];
      if (lean.length) {
        options.tools = lean;
        isLean = true;
      }
    } else if (settings && settings.autoLean) {
      // Auto-lean for small-context models when explicitly configured in settings
      const ctx = (typeof this.contextOf === 'function' && Number(this.contextOf(providerInstance, model))) || 0;
      if (ctx > 0 && ctx < 131072) {
        options.tools = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
        isLean = true;
      }
    }
    if (isLean) {
      console.log('[chat] explicit lean tool mode active for chat ' + id + ' (' + options.tools.join(', ') + ')');
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
      // ~/.npm is read-only inside the sandbox, so `npx` died half-installed
      // (EROFS, then MODULE_NOT_FOUND). Give npm its own writable cache.
      const npmCache = sandboxNpmCache();
      if (npmCache) {
        options.sandbox.filesystem = { allowWrite: [npmCache] };
        options.env.npm_config_cache = npmCache;
      }
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
    // ---- The SDK options the desktop passes and CCE did not ----------------
    // The machine's policy file (managed-settings.json). A managed workstation
    // must not run the GUI unmanaged just because the GUI never looked for
    // the file. #t0-managed-settings
    const managed = managedconfig.load();
    // Scoped connectors: the engine gets exactly these servers and stops
    // reading the CLI's own .mcp.json, so a chat can be pinned to a known
    // server set. Off until the user scopes a list — otherwise the CLI's own
    // config stays the single source and nothing is registered twice.
    let scopedMcp = null;
    const scopedNames = (settings && Array.isArray(settings.scopedMcpServers))
      ? settings.scopedMcpServers.map(String).filter(Boolean)
      : [];
    if (scopedNames.length) {
      try {
        const connectors = require('./connectors');
        const defs = await connectors.definitions(claudePath);
        scopedMcp = {};
        for (const d of defs) if (scopedNames.includes(d.name)) scopedMcp[d.name] = d.config;
        if (!Object.keys(scopedMcp).length) scopedMcp = null;
      } catch (err) {
        console.error('[chat] scoped MCP servers could not be read: ' + String(err && err.message));
      }
    }
    Object.assign(options, sdkoptions.buildSdkOptions({
      settings: settings || {},
      dir,
      managed,
      mcpServers: scopedMcp,
      onUserDialog: (request, ctx) => this._userDialog(id, request, ctx),
    }));
    // Every CCE chat starts with the caveman (lite) voice, rtk command
    // compression and the superpowers skill set (brainstorming first) baked
    // into the engine's system prompt, so connector tools stay available. #feat-cce-bootstrap
    // The capabilities are detected on disk, so the model is never told to use
    // a toolkit this machine does not have.
    // Minimal-prompt mode drops the bootstrap (skills/agents/project context)
    // to shrink the base prompt for quick chats. #token-cost
    const isTranslated = Boolean(anthropicBaseUrl || (providerInstance && providerInstance.baseUrl));
    const minimalBootstrap = Boolean(settings && settings.minimalBootstrap) || (isTranslated && !(settings && settings.fullBootstrap));
    const includeReadme = Boolean(settings && settings.includeReadmeExcerpt);
    const bootstrap = settings && settings.minimalPrompt
      ? ''
      : await bootstrapPrompt(dir, { minimal: minimalBootstrap, includeReadme });
    if (bootstrap) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: bootstrap,
        snapshot: true,
      };
    }
    // Skills synced from Claude Desktop live one folder too deep for the engine.
    const synced = settings && settings.minimalPrompt ? null : syncedSkillsPlugin();
    if (synced) options.plugins = [...(options.plugins || []), { type: 'local', path: synced }];
    // Every model/provider gets the todo discipline, not just the ones that
    // remember it: plan before multi-step work, update on steer, check off as
    // items finish. Works with the object-form systemPrompt above — the SDK
    // only ignores appendSystemPrompt when systemPrompt is a plain string.
    // #todos-every-model
    options.appendSystemPrompt = 'For any multi-step request, before starting: create a todo list with TodoWrite (or TaskCreate/TaskUpdate if those tools are available). Example: TodoWrite with todos=[{content:"...",status:"pending"}]. Update the list when the user steers the request. Mark each item completed as soon as it finishes. When all items are finished, say the list is complete. Prefer the tool over prose checklists. If two tools share a name, prefer the one whose server matches the task and read its description first.';
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
      // Titles, summaries and other background calls default to a Claude model
      // by name. A translated provider does not serve it, so point them at the
      // model this chat already uses.
      const own = model || (providerInstance && providerInstance.model) || '';
      if (providerInstance && providerInstance.smallFastModel) {
        options.env.ANTHROPIC_SMALL_FAST_MODEL = String(providerInstance.smallFastModel);
        delete options.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      } else if (own) {
        options.env.ANTHROPIC_SMALL_FAST_MODEL = own;
        options.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = own;
      }
      Object.assign(options.env, leanEngineEnv({
        env: options.env, provider: providerInstance, model: own, settings, contextOf: this.contextOf,
      }));
    }

    const plug = pluginOverrides({ provider: providerInstance, settings: settings || {} });
    if (plug) options.settings = plug;

    // Each request keeps its own entry; several tools can be pending at once
    // (parallel tool calls, subagents). The old single-slot UI dropped all but
    // the last card and left the rest to time out. #2
    options.canUseTool = async (toolName, input, ctx = {}) => {
      // Pin the judged input: clone up front so a later mutation of the
      // caller's object cannot change this decision, and so any "allow"
      // (prompt path via answer()) returns the input that was actually judged
      // (updatedInput), not a stale original. #B1 updatedInput pinning.
      input = input && typeof input === 'object' ? { ...input } : (input || {});
      const targetPath = targetFilePath(toolName, input);

      // 1. VM-path denial
      if (targetPath && isVmPath(targetPath)) {
        return { behavior: 'deny', message: toolPolicy.MESSAGES.vmPath };
      }

      // 2. Read-only session policy
      if (settings && settings.readOnly && WRITE_TOOLS.has(toolName)) {
        return { behavior: 'deny', message: toolPolicy.MESSAGES.readOnly };
      }

      // 3. Write-tool block rules
      if (settings && Array.isArray(settings.blockedTools) && settings.blockedTools.includes(toolName)) {
        return { behavior: 'deny', message: toolPolicy.MESSAGES.blockedTool };
      }

      // 4. Path outside allowed working directories
      if (targetPath && settings && settings.restrictToCwd) {
        const allowed = [dir, ...(settings.allowedDirectories || [])];
        if (isOutsideDirs(targetPath, allowed)) {
          return { behavior: 'deny', message: toolPolicy.MESSAGES.outsideAllowed };
        }
      }

      // 5. Connector tool policy — the connector track is separate from the
      // session permission mode (the desktop keeps chromePermissionMode next
      // to permissionMode for the same reason). A connector the user marked
      // "ask once per session" is asked once, not once per call. #t0-ask-session
      const connPol = toolPolicy.connectorPolicy(toolName, settings);
      const isConn = toolPolicy.isConnectorTool(toolName);
      const bypass = effMode === 'bypassPermissions' || !!yolo;
      // A destructive connector tool always needs a confirmation, unless the
      // session skips every prompt on purpose.
      const destructive = isConn && !bypass && toolPolicy.isDestructiveTool(toolName);
      if (connPol === 'always_deny') {
        return { behavior: 'deny', message: toolPolicy.MESSAGES.connectorDeny };
      }
      if (connPol === 'always_allow' && !destructive) {
        return { behavior: 'allow' };
      }
      let alwaysAsk = connPol === 'always_ask';
      if (connPol === 'always_ask_session') {
        // The grant lives in the host, so it dies with the chat and never
        // leaks into the next one.
        if (this._hasSessionGrant(id, toolName)) return { behavior: 'allow' };
        alwaysAsk = true;
      }
      if (destructive) alwaysAsk = true;
      if (alwaysAsk) {
        // always_ask must win over bypass/yolo and over any allow rule: the
        // user is asked every time, never silently allowed. #B1
        ctx.suppressAlwaysAllowRule = true;
      }

      // 6. Auto-allow safe inspection / web tools and bypass modes
      if (!alwaysAsk && (effMode === 'bypassPermissions' || !!yolo)) {
        return { behavior: 'allow' };
      }
      if (!alwaysAsk && ['WebFetch', 'WebSearch'].includes(toolName)) {
        if (!settings || !Array.isArray(settings.blockedTools) || !settings.blockedTools.includes(toolName)) {
          return { behavior: 'allow' };
        }
      }
      if (!alwaysAsk && settings && Array.isArray(settings.allowedTools) && settings.allowedTools.includes(toolName)) {
        return { behavior: 'allow' };
      }

      const requestId = 'r' + (this.permSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
      return await new Promise((resolve) => {
        const entry = {
          chatId: id, requestId, toolName, input, resolve,
          // The connector policy that produced this prompt. 'always_ask_session'
          // needs it: the grant is recorded when the user answers. #t0-ask-session
          policy: connPol || null,
          destructive: !!destructive,
          // Suggestions come from the engine: they are the exact rule set that
          // would cover THIS call (e.g. `npm test *`), not the whole tool. #3
          suggestions: ctx.suggestions || [],
          suppressAlwaysAllowRule: !!ctx.suppressAlwaysAllowRule,
          // Metadata for the prompt text instead of a raw JSON dump. #28
          title: ctx.title || '', description: ctx.description || (destructive ? toolPolicy.MESSAGES.destructive : ''),
          decisionReason: ctx.decisionReason || '', blockedPath: ctx.blockedPath || '',
          displayName: ctx.displayName || '', toolUseID: ctx.toolUseID || '',
          timer: setTimeout(() => {
            this._dropPerm(requestId);
            this.emit('event', id, { kind: 'permission-timeout', requestId });
            // Worded for the model: "timed out" alone read as a glitch to retry,
            // and one chat asked for the same write six times.
            resolve({ behavior: 'deny', message: PERM_TIMEOUT_MESSAGE });
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

    // MCP connectors ask the user for input mid-call. 'url' mode is the OAuth
    // dance (open this URL, authorize, the server completes via the MCP server);
    // 'form' mode asks for structured input. Without a handler the SDK declines
    // everything, which is why auth-gated connectors silently never connected.
    // Mirrors the permission card plumbing above. #feat-elicitation
    options.onElicitation = async (req, ctx = {}) => {
      const requestId = 'e' + (this.permSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
      // Already interrupted: the abort event will never fire, so do not wait out the timeout.
      if (ctx.signal && ctx.signal.aborted) return { action: 'cancel' };
      return await new Promise((resolve) => {
        const entry = {
          chatId: id, requestId, resolve,
          timer: setTimeout(() => {
            this._dropElicit(requestId);
            this.emit('event', id, { kind: 'elicitation-cleared', requestId, reason: 'timeout' });
            resolve({ action: 'decline' });
          }, PERM_TIMEOUT_MS),
        };
        this.pendingElicits.set(requestId, entry);
        ctx.signal && ctx.signal.addEventListener && ctx.signal.addEventListener('abort', () => {
          if (!this._dropElicit(requestId)) return;
          this.emit('event', id, { kind: 'elicitation-cleared', requestId, reason: 'interrupted' });
          resolve({ action: 'cancel' });
        }, { once: true });
        this.emit('event', id, {
          kind: 'elicitation', requestId,
          serverName: String(req.serverName || ''), message: String(req.message || ''),
          mode: req.mode === 'url' ? 'url' : 'form',
          url: String(req.url || ''), elicitationId: String(req.elicitationId || ''),
          requestedSchema: req.requestedSchema || null,
          title: String(req.title || ''), displayName: String(req.displayName || ''),
          description: String(req.description || ''),
          expiresAt: Date.now() + PERM_TIMEOUT_MS,
        });
      });
    };

    const chat = {
      id, cwd: dir, model: model || '', permissionMode: effMode,
      busy: false, sessionId: null,
      provider: providerInstance ? providers.publicInstance(providerInstance) : null,
      providerInstance,
      push: stream.push, close: stream.close, lastResult: null,
      checkpoints: [],   // user-message uuids -> rewind anchors (file checkpointing)
      guard: createLoopGuard(),   // stops an agent that repeats itself
      written: new Set(),         // files the agent wrote: the only ones the UI may share
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
      if (!chat.gotFirstFrame && this.chats.has(id)) {
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
            // The init frame echoes the engine's effective model. It must not
            // clobber an explicit user selection: a slow engine start delivers
            // init AFTER chat:set-model ran, which reset the dropdown to the
            // engine default on every switch.
            if (!chat.model) chat.model = msg.model || chat.model;
            this._rememberSession(dir, chat.sessionId);
          }
          if (msg.type === 'assistant' && !msg.parent_tool_use_id && Array.isArray(msg.message && msg.message.content)) {
            for (const b of msg.message.content) {
              if (!b || b.type !== 'tool_use') continue;
              const fp = b.input && (b.input.file_path || b.input.notebook_path);
              if (fp && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
                if (chat.written.size >= 500) chat.written.delete(chat.written.values().next().value);
                chat.written.add(absFor(dir, fp));
              }
              const trip = chat.guard.record(b);
              if (trip.tripped && !chat.guardTripped) {
                chat.guardTripped = true;
                this.emit('event', id, { kind: 'loop-guard', reason: trip.reason });
                this.interrupt(id).catch(() => {});
              }
            }
          }
          if (msg.type === 'result') {
            chat.guard.reset();
            chat.guardTripped = false;
            chat.lastResult = msg;
            // Two prompts sent back to back: the first result is not the end.
            // Stay busy (Stop stays visible) until the queue drains.
            if (!(Number(msg.queued_turn_count) > 0)) {
              chat.busy = false;
              this.emit('event', id, { kind: 'status', busy: false });
            }
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
          // A finished tool call ends the live stream of its output. #feat-live-output
          if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
            for (const b of msg.message.content) {
              if (b && b.type === 'tool_result' && b.tool_use_id) this._endTaskByTool(id, b.tool_use_id);
            }
          }
          if (msg.type === 'system' && TASK_SUBTYPES.includes(msg.subtype)) {
            this.emit('event', id, { kind: 'task', msg });
            this._onTaskFrame(id, chat, msg);
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
      } finally {
        // The watchdog must not outlive the loop either way: a tab closed
        // before the first frame would otherwise fire a phantom "engine did
        // not start" error into a removed chat. #sec
        clearTimeout(chat.watchdog);
        // The loop is over (it ended, or it threw): the live tail stops with
        // it, so no timer outlives the chat and no dead engine is polled. The
        // chat is gone, so no end-of-stream event is needed. #F2
        this._stopTasksForChat(id, false);
        this._settlePending(id);
        stream.close();
      }
    })();

    return {
      id, cwd: dir, model: chat.model, permissionMode: effMode,
      provider: chat.provider, sandbox: !!(settings && settings.sandbox && settings.sandbox.enabled),
      resumedFrom: (options.resume || null),
      isLean,
    };
  }

  _makeInputStream() {
    const queue = [];
    let wake = null;
    let closed = false;
    return {
      // false when the stream is closed: the message went nowhere.
      push(m) {
        if (closed) return false;
        if (wake) { const w = wake; wake = null; w(m); }
        else queue.push(m);
        return true;
      },
      // End the generator instead of leaving it suspended forever on the
      // pending `wake` promise — a suspended generator keeps the whole chat
      // (SDK stream + closures) alive after close. #sec
      close() {
        closed = true;
        const w = wake; wake = null;
        if (w) w(undefined);
      },
      iterate: async function* () {
        for (;;) {
          if (queue.length) { yield queue.shift(); continue; }
          if (closed) return;
          const v = await new Promise((r) => { wake = r; });
          if (closed) return;
          yield v;
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
      const loaded = readJsonSafe(file);
      if (loaded && typeof loaded === 'object') data = loaded;
      data[dir] = sessionId;
      // keep it bounded
      const keys = Object.keys(data);
      if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(k => delete data[k]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteJson(file, data);
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
    if (chat.guard) chat.guard.reset();
    chat.guardTripped = false;
    const content = blocks && blocks.length
      ? [...blocks, ...(text ? [{ type: 'text', text }] : [])]
      : text;
    // A closed input stream drops the message silently; say so instead of
    // marking the chat busy forever.
    const delivered = chat.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: chat.sessionId || '' });
    if (delivered === false) return { ok: false, error: 'this session has ended — open a new chat (Ctrl+Shift+T)' };
    chat.busy = true;
    this.emit('event', id, { kind: 'status', busy: true });
    return { ok: true };
  }

  /** The real path of a file the agent wrote in this chat, or null. */
  shareable(id, p) {
    const chat = this.chats.get(id);
    return chat ? shareablePath(chat.written, chat.cwd || '', p) : null;
  }

  async steer(id, text, blocks) {
    const chat = this.chats.get(id);
    if (!chat || (!text && !(blocks && blocks.length))) return { ok: false };
    if (chat.busy) {
      // Interrupt active thinking / tool loop immediately so Claude redirects
      await this.interrupt(id);
      await new Promise(r => setTimeout(r, 60));
    }
    return this.send(id, text, blocks);
  }

  async interrupt(id) {
    const chat = this.chats.get(id);
    if (!chat) return;
    // The Stop button ends the turn: the live tail must stop with it, or the
    // card keeps updating and the engine is polled every 700 ms for a turn
    // the user already ended. #F2
    this._stopTasksForChat(id, true);
    let stillQueued = 0;
    try {
      // A wedged engine must not leave Stop hanging: give up after 5 s.
      const r = await Promise.race([
        chat.q.interrupt(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('interrupt timed out')), 5000).unref()),
      ]);
      stillQueued = (r && Array.isArray(r.still_queued)) ? r.still_queued.length : 0;
    } catch (err) { console.warn('[chat] interrupt:', (err && err.message) || err); }
    // Permission cards still pending for this chat are answered here, so a
    // stop never leaves a clickable card behind a 6-minute timeout.
    for (const entry of this._permsOf(id)) {
      this._dropPerm(entry.requestId);
      this.emit('event', id, { kind: 'permission-cleared', requestId: entry.requestId, reason: 'interrupted' });
      try { entry.resolve({ behavior: 'deny', message: 'Interrupted by the user' }); } catch { /* settled */ }
    }
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

  // Context-window usage: { totalTokens, maxTokens, percentage, categories,
  // declared }. The engine may report its 200k default when the model's real
  // window differs (a chat started before env took effect, or a clamped
  // proxy) — report the declared limit instead so the UI shows the truth.
  async context(id) {
    const chat = this._chat(id);
    const u = await chat.q.getContextUsage();
    const provider = chat.providerInstance || chat.provider;
    const model = chat.model || (provider && provider.model) || '';
    const declared = (typeof this.contextOf === 'function' && Number(this.contextOf(provider, model))) || 0;
    let maxTokens = u.maxTokens || declared || ENGINE_DEFAULT_WINDOW;
    if (u.maxTokens === ENGINE_DEFAULT_WINDOW && declared > 0 && declared !== ENGINE_DEFAULT_WINDOW) maxTokens = declared;
    // When the limit is overridden the engine's percentage (computed against
    // its own number) is no longer truthful — recompute against the reported
    // maxTokens so the meter and the rail agree. #context-exact
    let percentage = u.percentage;
    if (maxTokens > 0 && maxTokens !== u.maxTokens) {
      percentage = Math.max(0, Math.min(100, ((Number(u.totalTokens) || 0) / maxTokens) * 100));
    }
    let categories = Array.isArray(u.categories) ? u.categories : [];
    if (!categories.length && (Number(u.totalTokens) || 0) > 0) {
      const used = Number(u.totalTokens) || 0;
      const free = Math.max(0, maxTokens - used);
      categories = [
        { name: 'conversation', kind: 'used', tokens: used, color: '#3b82f6' },
        { name: 'free', kind: 'free', tokens: free, color: 'transparent' },
      ];
    }
    // Diagnostic: keep both numbers so the UI can show declared vs engine.
    return { ...u, categories, maxTokens, percentage, declared, engineMaxTokens: u.maxTokens || 0 };
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

  /**
   * Apply a per-tool permission policy to a connector (the desktop app's
   * "always ask" for connector tools).
   *
   * The SDK carries the policy on the server definition, so applying it means
   * re-registering that server. Two facts, both verified against a live
   * session, shape this method:
   *
   *  - setMcpServers REPLACES the whole dynamic server set: a payload that
   *    omits a server drops it (a working 47-tool connector went to 0 tools).
   *    The complete accumulated set is therefore always sent.
   *  - The re-registered copy must carry the server's own credentials. With
   *    the real definition it stays healthy (47 tools); with a stale or
   *    missing Authorization header the server fails and loses every tool.
   *    The caller resolves the definition from the CLI config for that reason.
   *
   * @param {string} id chat id
   * @param {string} name server name
   * @param {object} config the server definition (SDK McpServerConfig shape)
   * @param {string[]} tools tool names to gate
   * @param {'always_ask'|'always_ask_session'|'always_allow'|'always_deny'} policy
   */
  async mcpSetPolicy(id, name, config, tools, policy) {
    const chat = this._chat(id);
    const names = (Array.isArray(tools) ? tools : []).map(String).filter(Boolean);
    if (!names.length) throw new Error('no tools to gate');
    const key = String(name);
    // The SDK knows three per-tool policies. 'always_ask_session' is a
    // host-side decision (the grant lives here, not in the CLI), so at the
    // SDK boundary it degrades to 'always_ask' — the safe direction.
    const sdkPolicy = toolPolicy.SDK_POLICY[policy] || 'always_ask';
    const updated = {
      ...(config || {}),
      tools: names.map((t) => ({ name: t, permission_policy: sdkPolicy })),
    };
    // Always send the full accumulated set: a partial payload drops servers.
    // Serialise per chat: two quick changes must not both start from the old set.
    const run = async () => {
      const next = { ...(chat.dynamicMcp || {}), [key]: updated };
      const res = await chat.q.setMcpServers(next);
      chat.dynamicMcp = next;
      return res;
    };
    const turn = (chat.mcpQueue || Promise.resolve()).then(run, run);
    chat.mcpQueue = turn.catch(() => {});
    return turn;
  }
  async agents(id) {
    const skilltoggle = require('./skilltoggle');
    const raw = await this._chat(id).q.supportedAgents();
    return (Array.isArray(raw) ? raw : []).map(a => {
      const name = typeof a === 'string' ? a : (a && a.name) || '';
      return {
        ...(typeof a === 'object' && a !== null ? a : { name }),
        enabled: skilltoggle.isAgentEnabled(name),
      };
    });
  }
  async applyFlags(id, patch) { return await this._chat(id).q.applyFlagSettings(patch || {}); }
  // Output styles are files on disk; the CLI lists them after a reload. #feat-output-styles
  async styles(id) {
    try {
      const r = await this._chat(id).q.reloadOutputStyles();
      return Array.isArray(r && r.available_output_styles) ? r.available_output_styles : [];
    } catch { return []; }
  }
  async stopTask(id, taskId) { await this._chat(id).q.stopTask(String(taskId)); return { stopped: true }; }

  async setModel(id, model) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    await chat.q.setModel(model || undefined);
    chat.model = model || chat.model;
    const uid = (chat.providerInstance && (chat.providerInstance._uid || chat.providerInstance.uid))
      || (chat.provider && (chat.provider._uid || chat.provider.uid));
    if (uid) {
      try { const proxy = require('./proxy'); proxy.clearLastGoodModel(uid); } catch { /* ignore */ }
    }
    return { model: chat.model };
  }

  async setMode(id, mode) {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('chat not found');
    const eff = normalizeMode(mode, chat.providerInstance);
    await chat.q.setPermissionMode(eff);
    chat.permissionMode = eff;
    return { permissionMode: eff, changed: eff !== mode };
  }

  /** Engine-reported model list, for the picker. #39 */
  async supportedModels(id) {
    const chat = this.chats.get(id);
    if (!chat) return [];
    try { return await chat.q.supportedModels(); } catch { return []; }
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

  // A live chat on this session would write the transcript straight back, so it
  // is closed first. The file is found by id across every project folder (a
  // guessed folder missed worktree and odd-path sessions, and `force` hid the
  // miss), and the delete is checked: "deleted" now means gone.
  async deleteSession(cwd, sessionId) {
    if (!isSessionId(sessionId)) throw new Error('invalid session id');
    const closed = [];
    for (const [id, chat] of this.chats) {
      if (chat.sessionId === sessionId) { this.close(id); closed.push(id); }
    }
    if (closed.length) await new Promise((r) => setTimeout(r, 300));
    const files = this.sessionFiles(cwd, sessionId);
    if (!files.length) throw new Error('This conversation is no longer on disk.');
    for (const f of files) {
      fs.rmSync(f, { force: true });
      fs.rmSync(f.replace(/\.jsonl$/, ''), { recursive: true, force: true });
    }
    const left = files.filter((f) => fs.existsSync(f));
    if (left.length) throw new Error('Could not delete ' + left[0]);
    return { deleted: true, closed };
  }

  sessionFiles(cwd, sessionId) {
    const name = sessionId + '.jsonl';
    const out = new Set();
    try { const { projDir } = this.projDirFor(cwd); if (fs.existsSync(path.join(projDir, name))) out.add(path.join(projDir, name)); } catch { /* no cwd */ }
    const root = path.join(process.env.HOME || os.homedir(), '.claude', 'projects');
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && fs.existsSync(path.join(root, d.name, name))) out.add(path.join(root, d.name, name));
      }
    } catch { /* no projects dir */ }
    return [...out];
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
    const records = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { continue; }
    }
    return { items: transcriptItems(records) };
  }

  // Same replay, but through the SDK: getSessionMessages parses the transcript
  // for us off the main thread instead of reading a whole JSONL synchronously.
  async transcriptVia(cwd, sessionId) {
    if (!isSessionId(sessionId)) return null;
    try {
      const { getSessionMessages } = await this.sdk();
      if (typeof getSessionMessages !== 'function') return null;
      const msgs = await getSessionMessages(sessionId, { dir: cwd, limit: 2000 });
      if (!Array.isArray(msgs) || !msgs.length) return null;
      return { items: transcriptItems(msgs) };
    } catch (err) {
      console.warn('[chats] getSessionMessages unavailable, reading the file:', String((err && err.message) || err));
      return null;
    }
  }

  // Past sessions for a folder, from the claude engine's own transcript store  // (~/.claude/projects/<path-with-dashes>/<sessionId>.jsonl) — includes TUI sessions.
  // listSessions({ dir }) covers this without the per-file head read; the scan
  // stays as the fallback.
  async history(cwd) {
    try {
      const { listSessions } = await this.sdk();
      if (typeof listSessions === 'function') {
        const rows = await listSessions({ dir: cwd, limit: 40 });
        return rows
          .filter((r) => isSessionId(r.sessionId))
          .map((r) => ({
            sessionId: r.sessionId,
            mtime: r.lastModified || r.createdAt || 0,
            preview: r.customTitle || r.summary || r.firstPrompt || '',
            branch: r.gitBranch || '',
          }))
          .sort((a, b) => b.mtime - a.mtime);
      }
    } catch (err) {
      console.warn('[chats] listSessions(dir) unavailable, falling back:', String((err && err.message) || err));
    }
    return this.scanHistory(cwd);
  }

  scanHistory(cwd) {
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
        branch: '',
      });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, 40);
  }

  // Flat, recency-sorted index of every stored session across all folders.
  // The SDK's listSessions does this without spawning anything and without
  // reading 64KB+8KB per file: it stats the transcripts and slices only the
  // head/tail it needs. That also keeps the Electron main thread free (the
  // hand-rolled scan was fully synchronous) and yields fields we could never
  // compute here — gitBranch for every session, customTitle for the renamed
  // ones. Falls back to the disk scan if the SDK is unavailable or errors.
  async index() {
    try {
      const { listSessions } = await this.sdk();
      if (typeof listSessions === 'function') {
        const rows = await listSessions({ limit: 300 });
        return rows
          .filter((r) => isSessionId(r.sessionId))
          .map((r) => ({
            sessionId: r.sessionId,
            cwd: r.cwd || null,
            mtime: r.lastModified || r.createdAt || 0,
            // A renamed session shows its custom title; otherwise the generated
            // summary; otherwise the first prompt.
            preview: r.customTitle || r.summary || r.firstPrompt || '',
            renamed: !!r.customTitle,
            branch: r.gitBranch || '',
            tag: r.tag || '',
            size: r.fileSize || 0,
          }))
          .sort((a, b) => b.mtime - a.mtime);
      }
    } catch (err) {
      console.warn('[chats] listSessions unavailable, falling back to the disk scan:', String((err && err.message) || err));
    }
    return this.scanIndex();
  }

  // The original hand-rolled scan, kept as the fallback path.
  scanIndex() {
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
    // Same row shape as the SDK path (branch/tag are simply unknown here) so the
    // renderer does not have to branch on which one produced the list.
    return found.slice(0, 300).map(s => ({
      folder: s.folder,
      cwd: cwdOf(s.full),
      sessionId: s.sessionId,
      mtime: s.mtime,
      preview: previewOf(s.full).slice(0, 120),
      renamed: false,   // a /rename is only visible to the SDK
      branch: '',
      tag: '',
      size: 0,
    }));
  }

  answer(id, requestId, decision, answers, message) {
    const entry = this.pendingPerms.get(requestId);
    // Scope by chat: requestIds are unique, but a stale card in another tab
    // must never be able to answer this tab's request. #20
    if (!entry || entry.chatId !== id) return { ok: false, error: 'request no longer pending' };
    this._dropPerm(requestId);
    // 'always_ask_session': the user approved this tool for the rest of the
    // chat. The grant dies with the chat. #t0-ask-session
    if (entry.policy === 'always_ask_session' && decision !== 'deny') {
      this._grantSession(id, entry.toolName);
    }
    if (decision === 'deny') {
      // A deny message is how plan-mode feedback reaches the model. #40
      entry.resolve({ behavior: 'deny', message: String(message || 'User denied this tool use.') });
    } else if (answers && typeof answers === 'object' && Object.keys(answers).length) {
      // AskUserQuestion: picked labels ride on the permission result as the
      // tool's answers (engine reads updatedInput.answers, keyed by question).
      entry.resolve({ behavior: 'allow', updatedInput: { ...(entry.input || {}), answers } });
    } else if (decision === 'always') {
      // Use the engine's own suggestions. A bare { toolName } rule approves EVERY
      // use of the tool for the session — one "yes" to `ls` would have allowed
      // `rm -rf`. The SDK documents updatedPermissions as the intended channel. #3
      if (entry.suppressAlwaysAllowRule) {
        entry.resolve({ behavior: 'allow', updatedInput: entry.input });
      } else if (entry.suggestions.length) {
        entry.resolve({ behavior: 'allow', updatedInput: entry.input, updatedPermissions: entry.suggestions });
      } else {
        // No suggestions available: allow just this call rather than granting a
        // blanket rule. Safer default than the old behaviour.
        entry.resolve({ behavior: 'allow', updatedInput: entry.input });
      }
    } else if (decision === 'allow') {
      entry.resolve({ behavior: 'allow', updatedInput: entry.input });
    } else {
      // Fail closed: anything that is not a recognised decision (a typo, a
      // corrupted payload) must deny the tool call, never allow it.
      entry.resolve({ behavior: 'deny', message: 'Unrecognised permission decision — tool call denied.' });
    }
    return { ok: true };
  }

  // ---------- live shell output ---------------------------------------------
  /**
   * A frame about a background task.
   *
   * The engine does not stream a tool's output: a Bash call ends with one
   * tool_result frame. A shell task the engine knows about can be read while
   * it runs, though — get_task_output returns the tail it wrote so far — so
   * the card fills while the command is still running. #feat-live-output
   */
  _onTaskFrame(id, chat, msg) {
    const taskId = msg && msg.task_id;
    if (!taskId) return;
    if (msg.subtype === 'task_started') {
      // Without a tool_use_id there is no card to write into.
      if (!msg.tool_use_id) return;
      // The live tail needs the engine's get_task_output control request. It
      // exists at runtime (sdk.mjs: getTaskOutput) and its wire types are
      // declared, but the method is NOT declared on the published Query
      // interface — so an upstream rename is expected to fail soft here
      // instead of throwing. #F4
      if (!chat || !chat.q || typeof chat.q.getTaskOutput !== 'function') return;
      // A backgrounded task's tool_result is only a placeholder: the real
      // result arrives later as a task_notification, so the live tail must
      // keep running. #F7
      this._followTask(id, chat, taskId, msg.tool_use_id, !!msg.is_backgrounded);
      return;
    }
    // The task is over: the tool_result that follows carries the real text.
    if (msg.subtype === 'task_notification') this._endTask(id, taskId, true);
    if (msg.subtype === 'task_updated') {
      // A task that moves to the background later says so here: from then on
      // its tool_result is only a placeholder, so the live tail must keep
      // running until the task_notification ends it. #R2
      const entry = this.taskPolls.get(taskId);
      if (entry && msg.patch && typeof msg.patch.is_backgrounded === 'boolean') {
        entry.backgrounded = msg.patch.is_backgrounded;
      }
      return;
    }
  }

  /**
   * Poll a running task for its output tail.
   *
   * The first poll is quick so the card starts filling almost at once; the
   * rest are steady. One poll per task: a second start for the same task
   * would double the control requests the engine sees.
   */
  _followTask(id, chat, taskId, toolUseId, backgrounded) {
    if (this.taskPolls.has(taskId)) return;
    const entry = { chatId: id, taskId, toolUseId, timer: null, text: '', stopped: false, backgrounded: !!backgrounded };
    this.taskPolls.set(taskId, entry);
    this.taskByTool.set(toolUseId, taskId);

    const poll = async () => {
      if (entry.stopped) return;
      let res = null;
      try {
        res = await chat.q.getTaskOutput(taskId);
      } catch (err) {
        // The engine refuses this task — it is not a shell task, or it is
        // already gone. Stop asking: a refused poll must not become a loop.
        this._endTask(id, taskId, false);
        return;
      }
      if (entry.stopped) return;
      const text = res && typeof res.output === 'string' ? res.output : '';
      if (text) {
        entry.text = text;
        this.emit('event', id, { kind: 'tool-output', toolUseId, text, done: false });
      }
      if (entry.stopped) return;
      entry.timer = setTimeout(poll, TASK_POLL_MS);
    };
    entry.timer = setTimeout(poll, TASK_POLL_FIRST_MS);
  }

  /**
   * Stop polling a task.
   *
   * `emitDone` tells the card that the live stream is over: the tool_result
   * that follows carries the authoritative text, and the card must not keep
   * showing a stale tail as if it were current.
   */
  _endTask(id, taskId, emitDone) {
    const entry = this.taskPolls.get(taskId);
    if (!entry) return;
    this.taskPolls.delete(taskId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.stopped = true;
    if (this.taskByTool.get(entry.toolUseId) === taskId) this.taskByTool.delete(entry.toolUseId);
    if (emitDone) {
      this.emit('event', id, { kind: 'tool-output', toolUseId: entry.toolUseId, text: entry.text, done: true });
    }
  }

  /** The tool call ended: its live output stops. #feat-live-output */
  _endTaskByTool(id, toolUseId) {
    const taskId = this.taskByTool.get(toolUseId);
    if (!taskId) return;
    const entry = this.taskPolls.get(taskId);
    // A backgrounded task's tool_result is only a PLACEHOLDER — the real
    // result arrives later as a task_notification. Stopping the poll here
    // would cut the live tail short, so the task_notification ends it. #F7
    if (entry && entry.backgrounded) return;
    this._endTask(id, taskId, true);
  }

  /**
   * Stop every live-output poll belonging to one chat.
   *
   * A poll that outlives its chat keeps a timer alive and keeps asking a dead
   * engine for output nobody is watching. `emitDone` tells the cards that the
   * live stream is over, so they stop auto-expanding and stop showing a stale
   * tail as if it were still live.
   *
   * @param {string} id chat id
   * @param {boolean} emitDone  emit the end-of-stream event for each tool call
   */
  _stopTasksForChat(id, emitDone) {
    for (const [taskId, entry] of [...this.taskPolls]) {
      if (entry.chatId !== id) continue;
      this._endTask(id, taskId, emitDone);
    }
  }

  /** Deny every permission/elicitation card still waiting so no promise hangs. #20 */
  _settlePending(id) {
    for (const entry of this._permsOf(id)) {
      if (this._dropPerm(entry.requestId)) {
        this.emit('event', id, { kind: 'permission-cleared', requestId: entry.requestId, reason: 'closed' });
        try { entry.resolve({ behavior: 'deny', message: 'Session closed' }); } catch { /* resolved already */ }
      }
    }
    for (const [rid, entry] of [...this.pendingElicits]) {
      if (entry.chatId !== id) continue;
      if (this._dropElicit(rid)) {
        this.emit('event', id, { kind: 'elicitation-cleared', requestId: rid, reason: 'closed' });
        try { entry.resolve({ action: 'cancel' }); } catch { /* resolved already */ }
      }
    }
  }

  close(id) {
    const chat = this.chats.get(id);
    // A poll that outlives its chat would keep asking the engine for output
    // nobody is watching. #feat-live-output
    this._stopTasksForChat(id, false);
    this._settlePending(id);
    if (!chat) return;
    clearTimeout(chat.watchdog);       // never fire "engine did not start" on a closed tab
    try { chat.close && chat.close(); } catch { /* stream already ended */ }
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
        const n = name.trim();
        const skilltoggle = require('./skilltoggle');
        out.push({
          name: n,
          description: description.trim(),
          source: root.startsWith(process.env.HOME || os.homedir()) ? 'user' : 'project',
          enabled: skilltoggle.isSkillEnabled(n),
        });
      }
    }
    return out;
  }
}

// CCE offers four permission modes, like the Claude Code desktop app's picker:
//   auto        a second "classifier" model reviews every action instead of asking you
//   acceptEdits file edits + simple filesystem commands run; shell commands still ask
//   plan        read-only planning
//   bypassPermissions (yolo)  nothing is checked
// Manual ("default": ask before every edit) is not offered; it maps to acceptEdits.
// auto only works when the classifier is a real Claude: against a third-party
// provider (qwen, GLM, a proxy…) its requests run on that provider's model, whose
// answers often do not parse, and Claude Code then denies the action silently and
// stops the turn after ten no-verdict responses. So auto falls back to acceptEdits there.
const MODES = ['auto', 'acceptEdits', 'plan', 'bypassPermissions'];

// Engine frames about background work. background_tasks_changed is a LEVEL (the
// complete live set on every change) while the rest are edges — the renderer
// needs both to keep a running-task indicator honest. #48
const TASK_SUBTYPES = ['task_started', 'task_updated', 'task_progress', 'task_notification', 'background_tasks_changed'];
function normalizeMode(mode, providerInstance, yolo) {
  if (yolo) return 'bypassPermissions';
  let m = MODES.includes(mode) ? mode : 'acceptEdits';
  if (m === 'auto' && providerInstance && providerInstance.baseUrl) m = 'acceptEdits';
  return m;
}

module.exports = ChatManager;
module.exports.normalizeMode = normalizeMode;
module.exports.MODES = MODES;
module.exports.TASK_SUBTYPES = TASK_SUBTYPES;
module.exports.transcriptItems = transcriptItems;
module.exports.leanEngineEnv = leanEngineEnv;
module.exports.pluginOverrides = pluginOverrides;
module.exports.sandboxNpmCache = sandboxNpmCache;
module.exports.PERM_TIMEOUT_MESSAGE = PERM_TIMEOUT_MESSAGE;
// B1 policy helpers re-exported for tests/consumers that import from chats.js.
module.exports.WRITE_TOOLS = WRITE_TOOLS;
module.exports.isVmPath = isVmPath;
module.exports.targetFilePath = targetFilePath;
module.exports.isOutsideDirs = isOutsideDirs;
