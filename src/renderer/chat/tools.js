// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, loadMonaco, toast } from '../app/core.js';
import { enhanceMarkdown, monacoThemeName } from './markdown.js';
import { openPlanViewer, updatePlanViewer } from './panels.js';
import { noteToolOutcome } from './picker.js';
import { hiddenThoughtNode, thoughtNode } from './stream.js';
import { scrollDownSoft } from './transcript.js';
import { el, md, splitThink, stripAnsi, thinkingText } from './util.js';
import { isTestCommand } from './queue.js';

/* ---------------- tool metadata ---------------- */

// One stroke icon per tool, from the shared SVG set. They were emoji, which
// render at different sizes per platform, ignore currentColor (so they could
// not follow the theme), and were announced before the tool name. #54
const TOOL_ICONS = {
  Bash: 'terminal', BashOutput: 'terminal', Read: 'file', NotebookRead: 'notebook',
  Write: 'pencil', Edit: 'pencil', MultiEdit: 'pencil', NotebookEdit: 'notebook',
  Grep: 'search', Glob: 'folder', WebFetch: 'globe', WebSearch: 'globe',
  Task: 'bot', Agent: 'bot', TodoWrite: 'check', ExitPlanMode: 'map',
  Skill: 'bolt', AskUserQuestion: 'question', KillShell: 'stop',
};

export const toolIcon = (name) => CCEIcons.svg(
  name && name.startsWith('mcp__') ? 'plug' : (TOOL_ICONS[name] || 'wrench'), 15);

export function toolTitle(name, input = {}) {
  const mcp = name.startsWith('mcp__') ? name.replace(/^mcp__/, '').split('__') : null;
  switch (name) {
    case 'Bash': return input.command || 'shell';
    case 'Read': case 'NotebookRead': return input.file_path || 'read';
    case 'Write': return 'write ' + (input.file_path || '');
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit ' + (input.file_path || '');
    case 'Glob': return input.pattern || 'glob';
    case 'Grep': return input.pattern || 'grep';
    case 'WebFetch': return input.url || 'fetch';
    case 'WebSearch': return input.query || 'search';
    case 'Task': case 'Agent': return input.description || input.prompt?.slice(0, 80) || 'subagent';
    case 'TodoWrite': return 'update todos';
    case 'ExitPlanMode': return 'plan ready for review';
    case 'Skill': return 'skill: ' + (input.skill || input.command || '');
    case 'AskUserQuestion': return 'asks: ' + ((input.questions && input.questions[0] && input.questions[0].question) || '').slice(0, 80);
    case 'TaskCreate': return 'task: ' + (input.subject || '');
    case 'TaskUpdate': return 'task #' + (input.taskId || '') + (input.status ? ' → ' + input.status : '');
    default: {
      if (!mcp) return name;
      // Name the server's short tool plus what it was asked to do: a column of
      // identical "server ▸ execute" rows hid what each call ran. #mcp-titles
      const server = mcp[0].replace(/^plugin_[^_]+_/, '');
      const what = mcpGist(input);
      return server + ' ▸ ' + mcp.slice(1).join('.') + (what ? ' · ' + what : '');
    }
  }
}

function mcpGist(input) {
  if (!input || typeof input !== 'object') return '';
  const first = (v) => String(v).split('\n').map(s => s.trim()).find(s => s && !s.startsWith('#') && !s.startsWith('//')) || '';
  for (const k of ['command', 'query', 'url', 'path', 'file_path', 'pattern', 'name', 'title']) {
    if (typeof input[k] === 'string' && input[k].trim()) return first(input[k]).slice(0, 90);
  }
  if (typeof input.code === 'string') return first(input.code).slice(0, 90);
  for (const k of ['commands', 'queries', 'paths']) {
    const a = input[k];
    if (Array.isArray(a) && a.length) {
      const v = typeof a[0] === 'string' ? a[0] : (a[0] && (a[0].label || a[0].command)) || '';
      return first(v).slice(0, 80) + (a.length > 1 ? ' +' + (a.length - 1) : '');
    }
  }
  return '';
}

function toolKind(name) {
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'Task' || name === 'Agent') return 'agent';
  if (name === 'Skill') return 'skill';
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'edit';
  return 'tool';
}

/* ---------------- nested subagent timelines ---------------- */

// Frames produced inside a Task/Agent subagent carry parent_tool_use_id —
// render them nested inside their parent card (orchestration view).
export function nestedTarget(chat, parentId) {
  if (!parentId) return null;
  // A subagent-of-a-subagent names its parent by agent_id, not by the tool_use
  // id the outer frame carried. Resolve through that map so depth >= 2 still
  // lands in the right card instead of falling back to the top level. #49
  const ctx = chat.tools.get(parentId) || chat.tools.get((chat.agentTasks || new Map()).get(parentId) || '');
  if (!ctx) return null;
  if (!ctx.nested) {
    ctx.nested = el('div', 'nested-agents');
    const deep = toolDepth(chat, parentId);
    ctx.nested.appendChild(el('div', 'nested-label', deep > 1 ? '⌥ subagent activity · depth ' + deep : '⌥ subagent activity'));
    ctx.body.insertBefore(ctx.nested, ctx.body.firstChild);
    ctx.body.classList.remove('hidden');
  }
  return ctx.nested;
}

/* ---------------- blocks (final) ---------------- */

// Read-only lookups produce long runs of near-identical cards; the desktop app
// collapses them. #27
const GROUPABLE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch']);

const lastGroupNode = new WeakMap();

function makeGroup(host, name) {
  const wrap = el('details', 'tool-group');
  const sum = el('summary', 'group-head');
  sum.appendChild(elIcon('span', 'tool-ico', toolIcon(name)));
  const countEl = el('span', 'group-count', '');
  sum.appendChild(countEl);
  wrap.appendChild(sum);
  const list = el('div', 'group-items');
  wrap.appendChild(list);
  host.appendChild(wrap);
  // count starts at 0; the caller adds the first item.
  return { node: wrap, list, countEl, count: 0, name };
}

/** Reuse the previous group only when it is the host's last child. */
function lastGroup(host, name) {
  const g = lastGroupNode.get(host);
  if (!g) return null;
  if (g.name !== name) return null;
  if (g.node.nextElementSibling) return null;   // something else came after it
  return g;
}

export function renderBlock(chat, block, parentId) {
  if (!block) return;
  const host = nestedTarget(chat, parentId) || chat.msgs;
  if (block.type === 'text') {
    if (!block.text) return;
    const cut = splitThink(block.text);
    if (cut.thinking) host.appendChild(thoughtNode(cut.thinking));
    if (!cut.text) return;
    const w = el('div', 'msg assistant-msg' + (parentId ? ' nested' : ''));
    const body = el('div', 'md');
    body.innerHTML = md(cut.text);
    w.appendChild(body);
    enhanceMarkdown(body, cut.text);
    host.appendChild(w);
  } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    // The text that streamed live wins over a final copy that left it out.
    // A block that carries its summary in a `summary` field is not a thought
    // the provider kept to itself. #feat-reasoning-summaries
    const streamed = chat.streamedThoughts?.get(parentId || 'main')?.shift();
    const text = block.thinking || streamed || thinkingText(block) || '';
    host.appendChild(text ? thoughtNode(text) : hiddenThoughtNode());
  } else if (block.type === 'tool_use') {
    // Group long runs of read-only lookups into one collapsible row, the way
    // the desktop app does, so a 40-file sweep is 2 lines instead of 40. #27
    if (GROUPABLE_TOOLS.has(block.name)) {
      let group = lastGroup(host, block.name);
      if (!group) {
        group = makeGroup(host, block.name);
        lastGroupNode.set(host, group);
      }
      group.count++;
      group.list.appendChild(el('div', 'group-item mono', toolTitle(block.name, block.input || {})));
      group.countEl.textContent = group.count + ' ' + block.name.toLowerCase() + (group.count === 1 ? ' call' : ' calls');
      makeToolCard(chat, block.id, block.name, block.input || {}, parentId).setStatus('done');
      if (!parentId) scrollDownSoft(chat);
      return;
    }
    const card = makeToolCard(chat, block.id, block.name, block.input || {}, parentId);
    // A result that beat its card resolves immediately instead of flashing 'running'.
    if (card.earlyResolved) card.setStatus(card.isError ? 'err' : 'done');
    else card.setStatus('running');
    if (block.name === 'ExitPlanMode') {
      openPlanViewer(chat);
      updatePlanViewer(chat, JSON.stringify({ plan: (block.input || {}).plan || '' }));
    }
    host.appendChild(card.card);
  }
  if (!parentId) scrollDownSoft(chat);
}

/* ---------------- tool cards ---------------- */

/** Nesting depth of a tool call: how many subagent layers produced it. */
function toolDepth(chat, parentId) {
  let depth = 0;
  let cur = parentId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const ctx = chat.tools.get(cur);
    if (!ctx) break;
    depth++;
    cur = ctx.parentId || null;
  }
  return depth;
}

/** Buttons under a finished Write card: reveal the file, or save a copy. */
function addFileShare(chat, ctx) {
  const file = String(ctx.input.file_path);
  const bar = el('div', 'file-share');
  bar.appendChild(el('span', 'fs-name mono', file.split('/').pop()));
  const act = (label, action, hint) => {
    const b = el('button', 'btn small', label);
    b.title = hint;
    b.addEventListener('click', async () => {
      try {
        const r = await ccx.invoke('file:share', { id: chat.id, path: file, action });
        if (r && r.savedTo) toast('Saved to ' + r.savedTo, 'ok');
      } catch (e) { toast(String((e && e.message) || e), 'err'); }
    });
    return b;
  };
  bar.appendChild(act('Show in folder', 'reveal', 'Open the file manager at this file'));
  bar.appendChild(act('Save a copy…', 'save', 'Save a copy of this file where you choose'));
  const copy = el('button', 'btn small', 'Copy path');
  copy.addEventListener('click', () => { ccx.invoke('clipboard:write', { text: file }); toast('Path copied', 'ok'); });
  bar.appendChild(copy);
  ctx.shareBar = bar;
  ctx.card.appendChild(bar);
}

export function makeToolCard(chat, toolUseId, name, input, parentId) {
  chat.msgs.querySelector('.chat-empty')?.remove();
  const card = el('div', 'tool-card kind-' + toolKind(name));
  const head = el('div', 'tool-head');
  const dot = el('span', 'tool-dot running');
  const icon = elIcon('span', 'tool-ico', toolIcon(name));
  const title = el('span', 'tool-title mono', toolTitle(name, input));
  const chip = el('span', 'chip', name.startsWith('mcp__') ? 'mcp' : toolKind(name));
  head.appendChild(dot); head.appendChild(icon); head.appendChild(title); head.appendChild(chip);
  // Depth indicator: without it a Agent → Bash → Agent → Bash loop looks
  // like a flat list and the user cannot tell how deep the model is. #18
  const depth = toolDepth(chat, parentId);
  if (depth > 0) {
    const d = el('span', 'chip depth-chip', '↳'.repeat(Math.min(depth, 3)) + ' depth ' + depth);
    d.title = 'Nested ' + depth + ' subagent layer' + (depth === 1 ? '' : 's') + ' deep';
    head.appendChild(d);
  }
  // Shortcuts into the side pane: an edited file opens in Review.
  const tip = (b, text) => { b.title = text; b.setAttribute('aria-label', text); b.type = 'button'; return b; };
  const filePath = input && (input.file_path || input.notebook_path);
  if (toolKind(name) === 'edit' && filePath) {
    const b = tip(el('button', 'tool-act tool-open-diff', 'diff'), 'Open this file in the diff pane');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cwd = String(chat.cwd || '').replace(/\/+$/, '');
      window.__reviewPick = cwd && String(filePath).startsWith(cwd + '/') ? String(filePath).slice(cwd.length + 1) : String(filePath);
      if (window.openSplitTab) window.openSplitTab('review');
    });
    head.appendChild(b);
  }
  const body = el('div', 'tool-body hidden');
  card.appendChild(head); card.appendChild(body);

  const ctx = {
    // `body` was missing here even though renderOutput() and nestedTarget()
    // both read ctx.body, so every tool_result threw and the output pane was
    // never rendered (the throw was swallowed by the event handler's catch).
    card, body, name, input, dot, title, status: 'running', source: null,
    parentId: parentId || null,
    // A Task/Agent call is the subagent itself: remember which agent_id the
    // engine stamps on the frames it emits, so nested-of-nested frames can
    // find this card by agent id instead of falling back to top level. #49
    agentId: (name === 'Task' || name === 'Agent') ? String((input && input.agentId) || toolUseId) : null,
    setStatus(status, note) {
      ctx.status = status;
      dot.className = 'tool-dot ' + status;
      if (status === 'err' && name === 'Bash' && !head.querySelector('.tool-fix')) {
        const f = tip(el('button', 'tool-act tool-fix', 'fix in chat'), 'Put this failed command in the message box');
        f.addEventListener('click', (e) => {
          e.stopPropagation();
          chat.composer.value = 'This command failed, please fix it:\n$ ' + String((ctx.input && ctx.input.command) || '') + '\n';
          chat.composer.focus();
        });
        head.appendChild(f);
      }
      if (note) title.textContent = note + ' — ' + toolTitle(name, ctx.input);
      else title.textContent = toolTitle(name, ctx.input);
      if (status === 'done' || status === 'err') renderOutput(chat, toolUseId);
      if (status === 'done' && name === 'Write' && ctx.input && ctx.input.file_path && !ctx.shareBar) addFileShare(chat, ctx);
    },
    setInput(inp) { ctx.input = inp || {}; title.textContent = toolTitle(name, ctx.input); renderInput(); },
  };

  function renderInput() {
    const prev = body.querySelector('.monaco-diff');
    if (prev && prev.__ed) prev.__ed.dispose();
    body.innerHTML = '';
    if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') {
      const wrap = renderDiff(name, ctx.input, ctx.source);
      body.appendChild(wrap);
      // Kick off the file read once so the diff gets real context. #29
      if (!ctx.source && !ctx._sourced && (name === 'Edit' || name === 'MultiEdit')) {
        ctx._sourced = true;
        loadDiffSource(ctx.input.file_path).then((src) => {
          if (!src || !ctx.body) return;
          ctx.source = src;
          if (!body.classList.contains('hidden')) renderInput();
        });
      }
    }
    const pre = el('pre', 'tool-io mono');
    pre.textContent = (JSON.stringify(ctx.input == null ? {} : ctx.input, null, 2) || '{}').slice(0, 4000);
    const det = el('details', 'tool-json');
    det.appendChild(el('summary', '', 'raw input'));
    det.appendChild(pre);
    body.appendChild(det);
    const d = body.querySelector('.monaco-diff');
    if (d && d.__init && !body.classList.contains('hidden')) d.__init();
    // The body was just rebuilt, so the output it held is gone with it. Put
    // back whatever belongs there: the final result if the card resolved,
    // the live tail if the task is still running. #feat-live-output
    if (ctx.status === 'done' || ctx.status === 'err') renderOutput(chat, toolUseId, ctx);
    else if (ctx.liveText) writeLiveOutput(ctx);
  }
  head.setAttribute('tabindex', '0');
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', 'false');
  head.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); head.click(); }
  });
  head.addEventListener('click', () => {
    const opening = body.classList.contains('hidden');
    body.classList.toggle('hidden');
    head.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const d = body.querySelector('.monaco-diff');
      if (d && d.__init) d.__init();
    } else {
      const d = body.querySelector('.monaco-diff');
      if (d && d.__ed) {
        try { d.__ed.dispose(); } catch { /* disposed */ }
        d.__ed = null;
        d.classList.add('pending');
        d.innerHTML = '<div class="hint">click the card header to show the diff</div>';
        if (d.__diffData) {
          d.__init = () => {
            const fresh = renderDiff(d.__diffData.name, d.__diffData.input, d.__diffData.source);
            d.replaceWith(fresh);
            if (fresh.__init) fresh.__init();
          };
        }
      }
    }
  });
  renderInput();
  // TodoWrite is the only tool whose output is state, not text: keep the
  // drawer's checklist in sync instead of leaving it permanently empty. #5
  if (name === 'TodoWrite') renderTodos(chat, ctx.input);
  // A result that arrived before its card (out-of-order frames) waits here;
  // apply it now instead of losing the output. #4
  const early = chat.pendingResults && chat.pendingResults.get(toolUseId);
  if (early) {
    chat.pendingResults.delete(toolUseId);
    ctx.output = early.text;
    ctx.isError = early.isError;
  }
  // Live output that arrived before this card (or before the card was
  // re-rendered) waits in chat.liveTasks: apply it now instead of losing
  // the output. #feat-live-output
  const earlyLive = chat.liveTasks && chat.liveTasks.get(toolUseId);
  if (earlyLive) {
    chat.pendingLive?.delete(toolUseId);
    writeLiveOutput(ctx, earlyLive.text);
    ctx.liveDone = earlyLive.done;
    if (!earlyLive.done) ctx.body.classList.remove('hidden');
  }
  // The unfiltered text wins over a buffered (compacted) result: the card
  // must show what the command really printed. #feat-output-filter
  const earlyOriginal = chat.toolOriginals && chat.toolOriginals.get(toolUseId);
  if (earlyOriginal !== undefined) {
    ctx.output = earlyOriginal;
    // Keep the entry when the result has not landed yet — resolveToolResult
    // consumes it there. A result that already arrived is terminal, so the
    // original is used up.
    if (early) chat.toolOriginals.delete(toolUseId);
  }
  chat.tools.set(toolUseId, ctx);
  if (ctx.agentId) {
    chat.agentTasks = chat.agentTasks || new Map();
    chat.agentTasks.set(ctx.agentId, toolUseId);
  }
  // Bound the registry: entries are only needed to resolve results, and a
  // long session would otherwise hold every card's context forever. #8
  if (chat.tools.size > 300) {
    // Never evict a card still waiting on its result: it would spin forever.
    let victim = null;
    for (const [k, v] of chat.tools) { if (v.status !== 'running') { victim = k; break; } }
    // All running (hard cap, e.g. a runaway turn): fall back to the oldest.
    chat.tools.delete(victim !== null ? victim : chat.tools.keys().next().value);
  }
  // Callers set the card to 'running' after creation; when a result arrived
  // first they must resolve instead — see the earlyResolved guards there.
  if (early) ctx.earlyResolved = true;
  return ctx;
}

/* ---------------- live tool output ---------------- */

/**
 * The live tail of a running background task's output. #feat-live-output
 *
 * `text` is a tail (the engine's get_task_output returns the last 8 KiB),
 * not the whole output: the authoritative text arrives later as the
 * tool_result, which overwrites it.
 */
export function applyLiveOutput(chat, toolUseId, text, done) {
  const ctx = chat.tools.get(toolUseId);
  // The tail belongs to the tool call, not to one card: keep it on the chat
  // so a card that is redrawn still shows the running output.
  chat.liveTasks = chat.liveTasks || new Map();
  const live = chat.liveTasks.get(toolUseId) || { text: '', done: false };
  if (text !== undefined && text !== null) live.text = String(text);
  if (done) live.done = true;
  chat.liveTasks.set(toolUseId, live);
  if (chat.liveTasks.size > 50) {
    const oldest = chat.liveTasks.keys().next().value;
    // Never drop the entry we just wrote: re-setting an existing key keeps
    // its old position, so it can be the oldest.
    if (oldest !== toolUseId) chat.liveTasks.delete(oldest);
  }
  if (!ctx) {
    // The frame beat its card: buffer it so the output is not lost. #4
    chat.pendingLive = chat.pendingLive || new Map();
    if (text) chat.pendingLive.set(toolUseId, String(text));
    // A card that never comes is a lost cause — do not buffer forever.
    if (chat.pendingLive.size > 50) {
      const oldest = chat.pendingLive.keys().next().value;
      chat.pendingLive.delete(oldest);
    }
    return;
  }
  // The result is terminal: a late tail must not overwrite the text the
  // engine actually reported.
  if (ctx.status !== 'done' && ctx.status !== 'err') {
    writeLiveOutput(ctx, text);
    // While the task runs the card opens itself so the user sees the output
    // live. Once it is done the card keeps whatever state the user left it in.
    if (!ctx.liveDone) ctx.body.classList.remove('hidden');
    scrollDownSoft(chat);
  }
  if (done) ctx.liveDone = true;
}

/** Write the live text into the card's output element (same element and
 *  insertion point renderOutput uses). */
function writeLiveOutput(ctx, text) {
  if (text !== undefined && text !== null) ctx.liveText = String(text);
  if (!ctx.liveText) return;
  let out = ctx.body.querySelector('.tool-output');
  if (!out) {
    out = el('pre', 'tool-output mono');
    ctx.body.insertBefore(out, ctx.body.firstChild);
  }
  out.textContent = stripAnsi(ctx.liveText).slice(0, 8000);
}

/**
 * The unfiltered text of a result the main process compacted for the model.
 * The card shows this one — the model saw the short version. #feat-output-filter
 */
export function storeToolOriginal(chat, toolUseId, text) {
  chat.toolOriginals = chat.toolOriginals || new Map();
  const value = String(text == null ? '' : text);
  chat.toolOriginals.set(toolUseId, value);
  // The result is terminal: an original nobody consumes is dead weight.
  if (chat.toolOriginals.size > 50) {
    const oldest = chat.toolOriginals.keys().next().value;
    // Never drop the entry we just wrote: re-setting an existing key keeps
    // its old position, so it can be the oldest.
    if (oldest !== toolUseId) chat.toolOriginals.delete(oldest);
  }
  // The result already landed (the frames arrived out of order): the card's
  // output is the only place the original can still show.
  const ctx = chat.tools.get(toolUseId);
  if (ctx && ctx.output !== undefined) {
    ctx.output = value;
    chat.toolOriginals.delete(toolUseId);
    renderOutput(chat, toolUseId);
  }
}

/** Fill the todo drawer from a TodoWrite tool input. #5 */
export function renderTodos(chat, input) {
  renderTodoItems(chat, Array.isArray(input.todos) ? input.todos : []);
}

/**
 * Secondary todo source: models that never call TodoWrite still write
 * checklists in prose. Only assistant text counts — never tool output,
 * which is full of literal "- [ ]" lines — and only runs of ≥2 consecutive
 * checkboxes, so one stray checkbox in prose is not a list. Fenced code
 * blocks are stripped first so a diff snippet never becomes a todo.
 */
/** Seed a pending list from the user's own prompt steps (before the model
 *  answers), so a todo drawer exists even for models that never call the
 *  tools. Only triggers on ≥2 consecutive step lines. #todos-every-model */
export function seedTodosFromPrompt(text) {
  const lines = String(text || '').split('\n');
  const items = [];
  let run = [];
  const flush = () => { if (run.length >= 2) items.push(...run); run = []; };
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/);
    if (m && !/^\s*[-*] \[/.test(line)) run.push({ content: m[1].trim(), status: 'pending' });
    else flush();
  }
  flush();
  return items.length ? items : null;
}

export function parseTodoChecklist(text) {
  const stripped = String(text || '').replace(/```[\s\S]*?```/g, '');
  const lines = stripped.split('\n');
  const items = [];
  let run = [];
  const flushRun = () => { if (run.length >= 2) items.push(...run); run = []; };
  for (const line of lines) {
    const m = line.match(/^\s*[-*] \[( |x|X)\] (.+)$/);
    if (m) run.push({ content: m[2].trim(), status: m[1].toLowerCase() === 'x' ? 'completed' : 'pending' });
    else flushRun();
  }
  flushRun();
  return items.length ? items : null;
}

/**
 * Newer engines track work with TaskCreate / TaskUpdate / TaskList instead of
 * TodoWrite, so the drawer (and the side panel that mirrors it) stayed empty.
 * Keep a per-chat board keyed by task id and render it the same way.
 */
function applyTaskTool(chat, name, input, output) {
  const board = chat.taskBoard || (chat.taskBoard = new Map());
  const text = String(output || '');
  if (name === 'TaskCreate') {
    const m = text.match(/#\s*(\d+)/) || text.match(/\b(?:task|id)\D{0,3}(\d+)/i);
    const id = m ? m[1] : String(board.size + 1);
    board.set(id, { content: String(input.subject || ''), status: 'pending', activeForm: input.activeForm || '' });
  } else if (name === 'TaskUpdate') {
    const id = String(input.taskId || '').replace(/^#/, '');
    const t = board.get(id) || { content: '', status: 'pending' };
    if (input.status === 'deleted') { board.delete(id); }
    else {
      if (input.subject) t.content = String(input.subject);
      if (input.status) t.status = input.status;
      if (input.activeForm) t.activeForm = String(input.activeForm);
      if (!t.content) t.content = 'task ' + id;
      board.set(id, t);
    }
  } else if (name === 'TaskList') {
    const rows = [...text.matchAll(/#\s*(\d+)\s*\[(pending|in_progress|completed)\]\s*(.+)/g)];
    if (rows.length) {
      board.clear();
      for (const r of rows) board.set(r[1], { content: r[3].trim(), status: r[2] });
    }
  } else return;
  renderTodoItems(chat, [...board.values()]);
}

// The agent's task list lives on the chat (chat.todos) and is shown only in
// the side panel's Tasks card; the transcript carries no checklist. A
// finished list stays there until the next prompt retires it.
function setTodos(chat, items) {
  chat.todos = items;
  if (typeof window.refreshTasksRail === 'function') window.refreshTasksRail(chat.id);
}

export const clearTodos = (chat) => setTodos(chat, []);

export function renderTodoItems(chat, items) {
  setTodos(chat, items.map(t => ({
    content: String(t.content || ''),
    status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
    activeForm: t.activeForm ? String(t.activeForm) : '',
  })));
}

// Left/right text for a file-modifying tool call. The pre-edit content is not in
// the tool input, so a real Edit diff needs the surrounding file; `source`
// carries it when the card read the file before the edit landed. #29
function diffPair(name, input, source) {
  if (name === 'Write') return ['', String(input.content || '')];
  if (name === 'Edit' || name === 'MultiEdit') {
    const edits = name === 'MultiEdit'
      ? (input.edits || [])
      : [{ old_string: input.old_string, new_string: input.new_string }];
    // With the original file, replay the edits on it so the diff shows real
    // context and the hunks land where they belong. #29
    const first = edits.find(e => e && e.old_string);
    if (source && typeof source === 'string' && first && source.includes(first.old_string)) {
      let mod = source;
      for (const e of edits) {
        if (!e || !e.old_string) continue;
        mod = mod.split(e.old_string).join(String(e.new_string || ''));
      }
      return [source, mod];
    }
    // Fallback: the replaced region on its own.
    return [
      edits.map(e => e.old_string || '').join('\n'),
      edits.map(e => e.new_string || '').join('\n'),
    ];
  }
  if (name === 'NotebookEdit') return ['', String(input.new_source || '')];
  return ['', ''];
}

/** Best-effort original file content for a diff. Never throws. */
async function loadDiffSource(filePath) {
  if (!filePath) return null;
  try {
    const r = await ccx.invoke('file:read', { path: filePath });
    if (r && r.ok && r.content) return r.content;
  } catch { /* unreadable */ }
  return null;
}

// Monaco side-by-side diff (#29). Built lazily on first card open so a long
// session does not keep hundreds of editors alive; falls back to the text
// diff when the vendor bundle is missing (fresh clone, before npm run vendor).
export function renderDiff(name, input, source) {
  const [orig, mod] = diffPair(name, input, source);
  const wrap = el('div', 'monaco-diff pending');
  wrap.__diffData = { name, input, source };
  wrap.appendChild(el('div', 'hint', 'click the card header to show the diff'));
  const init = () => {
    if (!wrap.__init) return;
    wrap.__init = null;
    wrap.classList.remove('pending');
    if (!window.monaco || !window.monaco.editor) {
      // Monaco loads on first use: say so, then build the editor, or fall
      // back to the text diff when the bundle is not there.
      wrap.innerHTML = '';
      wrap.appendChild(el('div', 'hint', 'loading diff…'));
      loadMonaco().then((m) => {
        wrap.innerHTML = '';
        if (!m || !m.editor) { renderTextDiff(wrap, name, input); return; }
        // Scrolled out of the window while loading: an editor built now
        // could never be disposed. Stay pending until it is opened again.
        if (!wrap.isConnected) {
          wrap.classList.add('pending');
          wrap.appendChild(el('div', 'hint', 'click the card header to show the diff'));
          wrap.__init = init;
          return;
        }
        build();
      });
      return;
    }
    build();
  };
  wrap.__init = init;
  const build = () => {
    wrap.innerHTML = '';
    const host = el('div', 'monaco-host');
    wrap.appendChild(host);
    if (typeof window.monaco.editor.setTheme === 'function') window.monaco.editor.setTheme(monacoThemeName());
    const ed = window.monaco.editor.createDiffEditor(host, {
      readOnly: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 12,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      folding: false,
      lineNumbers: 'off',
    });
    ed.setModel({
      original: window.monaco.editor.createModel(orig || ' '),
      modified: window.monaco.editor.createModel(mod || ' '),
    });
    wrap.__ed = ed;
  };
  return wrap;
}

function renderTextDiff(wrap, name, input) {
  const put = (cls, sign, text) => {
    const line = el('div', 'diff-line ' + cls);
    line.appendChild(el('span', 'diff-sign', sign));
    line.appendChild(el('span', 'diff-text mono', text));
    wrap.appendChild(line);
  };
  if (name === 'Write') {
    String(input.content || '').split('\n').slice(0, 400).forEach(l => put('add', '+', l));
  } else if (name === 'Edit') {
    String(input.old_string || '').split('\n').forEach(l => put('del', '−', l));
    String(input.new_string || '').split('\n').forEach(l => put('add', '+', l));
  } else if (name === 'MultiEdit') {
    for (const e of (input.edits || [])) {
      String(e.old_string || '').split('\n').forEach(l => put('del', '−', l));
      String(e.new_string || '').split('\n').forEach(l => put('add', '+', l));
    }
  } else if (name === 'NotebookEdit') {
    put('add', '+', (input.new_source || '').slice(0, 2000));
  }
}

/** Flatten a tool_result content payload to text. Shared by resolve + buffer. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => c.type === 'text' ? c.text : (c.type === 'image' ? '[image]' : '[' + c.type + ']')).join('\n');
  }
  return '';
}

export function resolveToolResult(chat, block) {
  const ctx = chat.tools.get(block.tool_use_id);
  // A tool that may have touched the working tree: refresh the Changes card (coalesced).
  if (ctx && /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/.test(ctx.name || '') && window.refreshOverview) window.refreshOverview(chat.id, 3000);
  // The main process compacts a big result for the model and sends the
  // original text separately: the card shows the original. #feat-output-filter
  const original = chat.toolOriginals && chat.toolOriginals.get(block.tool_use_id);
  const text = original !== undefined ? original : resultText(block.content);
  if (original !== undefined) chat.toolOriginals.delete(block.tool_use_id);
  if (!ctx) {
    // No card yet for this id: either the result beat its card (buffer it so
    // the output is not lost — #4) or the model emitted the call as prose
    // (small local models — count it so the picker can warn — #43).
    if (block.is_error && /tool|function|call/i.test(resultText(block.content).slice(0, 200))) {
      noteToolOutcome(chat.model, false);
    }
    chat.pendingResults = chat.pendingResults || new Map();
    chat.pendingResults.set(block.tool_use_id, { text, isError: !!block.is_error });
    // Don't hold stale entries: a card that never comes is a lost cause.
    if (chat.pendingResults.size > 50) {
      const oldest = chat.pendingResults.keys().next().value;
      chat.pendingResults.delete(oldest);
    }
    return;
  }
  noteToolOutcome(chat.model, !block.is_error);
  if (block.is_error && ctx.name === 'Bash' && isTestCommand(ctx.input && ctx.input.command)) chat.turnTestFail = true;
  // A streaming card is tracked per thread, not in chat.tools, so look there
  // too or the live card would never resolve.
  if (ctx.name === 'TodoWrite') renderTodos(chat, ctx.input);
  else if (!block.is_error && /^Task(Create|Update|List)$/.test(ctx.name)) applyTaskTool(chat, ctx.name, ctx.input || {}, resultText(block.content));
  ctx.output = text;
  ctx.isError = !!block.is_error;
  ctx.setStatus(block.is_error ? 'err' : 'done');
}

function renderOutput(chat, toolUseId, knownCtx) {
  const ctx = knownCtx || chat.tools.get(toolUseId);
  if (!ctx) return;
  let out = ctx.body.querySelector('.tool-output');
  if (!out) {
    out = el('pre', 'tool-output mono');
    ctx.body.insertBefore(out, ctx.body.firstChild);
  }
  // The live tail may have created the element first: keep the error
  // styling in step with the result that is on screen.
  out.classList.toggle('tool-err', !!ctx.isError);
  const text = ctx.output || (ctx.status === 'running' ? '…' : '(no output)');
  // The engine spills a big result to a file and leaves a short notice here.
  // Showing only the notice looks like the tool returned nothing, so offer the
  // path. #50
  const spill = /Full output saved to:\s*(\S+)/.exec(String(text));
  const full = stripAnsi(text);
  out.textContent = full.slice(0, 8000) + (full.length > 8000 ? '\n… (' + (full.length - 8000) + ' more characters not shown)' : '');
  if (spill) {
    const note = el('div', 'tool-spill');
    note.appendChild(el('span', 'hint', 'output spilled to file — '));
    const open = el('button', 'btn tiny', 'open');
    open.addEventListener('click', () => ccx.invoke('shell:reveal', { path: spill[1] }));
    note.appendChild(open);
    note.appendChild(el('span', 'hint mono', spill[1]));
    out.after(note);
  }
}
