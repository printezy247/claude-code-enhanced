// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { uiMode } from '../app/modes.js';
import { autosize } from './composer.js';
import { Chat } from './index.js';
import { collectMemoryProbe, maybeProbeMemory, showPendingChip } from './panels.js';
import { clearElicitation, clearPermission, dropElicCard, showElicitation, showPermission } from './permissions.js';
import { createSession, maybeNudge, pollContext, publishTabState } from './session.js';
import { setBusy, setStatusLine } from './status.js';
import { flushMarkdown, handleStream } from './stream.js';
import { applyLiveOutput, parseTodoChecklist, renderBlock, renderTodos, resolveToolResult, storeToolOriginal } from './tools.js';
import { appendCommandNote, appendError, appendSummary, appendUser, scrollDownSoft } from './transcript.js';
import { chats, el, esc } from './util.js';

/* ---------------- background tasks ---------------- */

function onTaskEvent(chat, msg) {
  // Bound the live task map so a long session cannot grow it forever.
  if (chat.bgTasks && chat.bgTasks.size > 50) {
    const oldest = chat.bgTasks.keys().next().value;
    chat.bgTasks.delete(oldest);
  }
  // background_tasks_changed is a LEVEL, not an edge: every payload is the
  // complete set of live tasks. Pairing task_started/task_notification edges
  // instead meant one dropped frame left a task card spinning forever — this
  // replaces the set wholesale, so the indicator cannot wedge. #48
  if (msg.subtype === 'background_tasks_changed') {
    const live = new Set();
    for (const t of (msg.tasks || [])) {
      live.add(t.task_id);
      let row = chat.bgTasks.get(t.task_id);
      if (!row) {
        row = bgTaskRow(chat, t.task_id, t);
        chat.bgTasks.set(t.task_id, row);
      }
      row.label = t.description || row.label;
      bgTaskPaint(row, t);
      if (t.subagent_type && !row.chipText) {
        const chip = row.node.querySelector('.chip');
        if (chip) { chip.textContent = t.subagent_type; row.chipText = t.subagent_type; }
      }
    }
    // Anything no longer in the level has ended.
    for (const [tid, row] of chat.bgTasks) {
      if (!live.has(tid)) {
        row.dot.className = 'tool-dot done';
        row.title.textContent = '✓ ' + row.label;
        row.stop?.remove();
        chat.bgTasks.delete(tid);
      }
    }
    return;
  }
  if (msg.subtype === 'task_notification') {
    const t = chat.bgTasks.get(msg.task_id);
    if (t) {
      const good = msg.status === 'completed';
      t.dot.className = 'tool-dot ' + (good ? 'done' : 'err');
      t.title.textContent = (good ? '✓ ' : '✗ ') + t.label;
      t.stop?.remove();
      if (msg.summary) t.title.title = String(msg.summary).slice(0, 600);
    } else {
      chat.msgs.appendChild(el('div', 'sys-note',
        (msg.status === 'completed' ? '✓ background task done' : '✗ background task ' + msg.status)
        + (msg.summary ? ' — ' + String(msg.summary).slice(0, 140) : '')));
      scrollDownSoft(chat);
    }
    chat.bgTasks.delete(msg.task_id);
    return;
  }
  let t = chat.bgTasks.get(msg.task_id);
  if (!t) {
    t = bgTaskRow(chat, msg.task_id, msg);
    scrollDownSoft(chat);
  }
  t.label = msg.description || t.label;
  bgTaskPaint(t, msg);
  if (msg.subtype === 'task_started' && !msg.is_backgrounded) t.stop.remove();  // foreground task: turn blocks on it anyway
}

/** One background-task card. Shared by the edge events and the level payload. */
function bgTaskRow(chat, taskId, info) {
  const node = el('div', 'tool-card kind-agent bg-task');
  const head = el('div', 'tool-head');
  const dot = el('span', 'tool-dot running');
  const ico = elIcon('span', 'tool-ico', CCEIcons.svg('bot', 15));
  const title = el('span', 'tool-title mono', '');
  const chip = el('span', 'chip', info.subagent_type || 'task');
  head.appendChild(dot); head.appendChild(ico); head.appendChild(title); head.appendChild(chip);
  const stop = elIcon('button', 'btn small', CCEIcons.svg('stop', 12) + ' stop');
  stop.title = 'Stop this background task';
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    const rr = await ccx.invoke('chat:stopTask', { id: chat.id, taskId });
    if (!rr.ok) { toast(rr.error, 'err'); stop.disabled = false; }
  });
  head.appendChild(stop);
  node.appendChild(head);
  chat.msgs.appendChild(node);
  const row = { node, dot, title, stop, label: info.description || 'background task', chipText: '' };
  chat.bgTasks.set(taskId, row);
  return row;
}

/** Paint a task card from either a task_* event or a background_tasks_changed entry. */
function bgTaskPaint(row, info) {
  const usage = info.usage ? ' · ' + Math.round((info.usage.total_tokens || 0) / 1000) + 'k tok' : '';
  row.title.innerHTML = CCEIcons.svg('clock', 13) + ' ' + esc(row.label
    + (info.last_tool_name ? ' — ' + info.last_tool_name : '')
    + (info.status ? ' · ' + info.status : '') + usage);
  if (info.summary) row.title.title = String(info.summary).slice(0, 600);
}

/* ---------------- hooks (live audit) ---------------- */

function onHookEvent(chat, msg) {
  if (msg.subtype === 'hook_started') {
    chat.hooks.push({
      id: msg.hook_id, at: Date.now(), event: msg.hook_event,
      name: msg.hook_name, outcome: 'running',
    });
    if (chat.hooks.length > 200) chat.hooks.shift();
  } else {
    const prev = chat.hooks.find(h => h.id === msg.hook_id);
    const done = {
      event: msg.hook_event, name: msg.hook_name, outcome: msg.outcome || '',
      exit: msg.exit_code, err: msg.stderr ? String(msg.stderr).slice(0, 200) : '',
      at: Date.now(),
    };
    if (prev) Object.assign(prev, done);
    else { chat.hooks.push({ id: msg.hook_id, ...done }); if (chat.hooks.length > 200) chat.hooks.shift(); }
  }
  renderHooks(chat);
}

export function renderHooks(chat) {
  const list = chat.hooksHost && chat.hooksHost.isConnected ? chat.hooksHost.__list : null;
  if (!list) return;
  list.innerHTML = '';
  if (!chat.hooks.length) { list.appendChild(el('div', 'hint', 'none yet')); return; }
  for (const h of [...chat.hooks].reverse().slice(0, 40)) {
    const row = el('div', 'skill-row');
    row.appendChild(el('code', '', h.event || '?'));
    row.appendChild(el('span', 'skill-desc', (h.name || '') + (h.exit != null ? ' → exit ' + h.exit : '')));
    const ok = h.outcome === 'running' ? '' : (h.outcome === 'success' ? 'mcp-ok' : 'mcp-err');
    row.appendChild(el('span', 'chip ' + ok, h.outcome || ''));
    if (h.err) row.appendChild(el('span', 'skill-desc', h.err));
    list.appendChild(row);
  }
}

/* ---------------- auth + interrupt feedback ---------------- */

function onAuth(chat, evt) {
  if (evt.authenticating) chat.statusRight.textContent = 'authenticating…';
  else if (evt.error) chat.statusRight.textContent = 'auth error — see terminal tab';
  else if (evt.output && evt.output.length) {
    const last = String(evt.output[evt.output.length - 1]).slice(0, 60);
    chat.statusRight.textContent = last || chat.statusRight.textContent;
  }
}

export function handleEvent(evt) {
  if (window.__CCE_SMOKE) console.log('[chat-event]', evt && evt.id, evt && evt.kind, evt && evt.msg && evt.msg.type);
  const { id, kind } = evt;
  const chat = chats.get(id);
  if (!chat) { if (window.__CCE_SMOKE) console.log('[chat-event] DROPPED — have ids:', [...chats.keys()].join(',')); return; }
  if (kind === 'message') handleMessage(chat, evt.msg);
  else if (kind === 'status') setBusy(chat, evt.busy);
  else if (kind === 'permission') showPermission(chat, evt);
  else if (kind === 'elicitation') showElicitation(chat, evt);   // #feat-elicitation
  else if (kind === 'elicitation-cleared') clearElicitation(chat, evt.requestId,
    evt.reason === 'timeout' ? 'Connector request timed out — declined' : null);
  else if (kind === 'permission-timeout') clearPermission(chat, evt.requestId, 'Permission request timed out — auto-denied');
  // Interrupt / tab close: drop the card instead of leaving it clickable. #11
  else if (kind === 'permission-cleared') {
    clearPermission(chat, evt.requestId, null);
    if (evt.reason === 'interrupted') toast('Pending permission cleared (interrupted)', '');
  }
  else if (kind === 'task') { onTaskEvent(chat, evt.msg); if (window.refreshTasksRail) window.refreshTasksRail(chat.id, 'background'); }
  // The live tail of a running background task's output. #feat-live-output
  else if (kind === 'tool-output') applyLiveOutput(chat, evt.toolUseId, evt.text, evt.done);
  // The unfiltered text behind a result the engine compacted. #feat-output-filter
  else if (kind === 'tool-original') storeToolOriginal(chat, evt.toolUseId, evt.text);
  else if (kind === 'hook') onHookEvent(chat, evt.msg);
  else if (kind === 'auth') onAuth(chat, evt);
  else if (kind === 'interrupted') {
    endTurnCleanup(chat);
    if (evt.stillQueued) {
      chat.msgs.appendChild(elIcon('div', 'sys-note', CCEIcons.svg('stop', 12) + ' interrupted — ' + evt.stillQueued + ' queued message(s) still run next'));
      scrollDownSoft(chat);
    }
  }
  else if (kind === 'loop-guard') {
    const why = String(evt.reason || 'same step again');
    if (evt.action === 'redirect') {
      // First trip: the call was not run and the agent was told to change course.
      chat.msgs.appendChild(elIcon('div', 'sys-note', CCEIcons.svg('stop', 12) + ' the agent was repeating itself (' + why + ') — that step was skipped and it was told to try something different.'));
    } else {
      chat.msgs.appendChild(elIcon('div', 'sys-note', CCEIcons.svg('stop', 12) + ' stopped — the agent was repeating itself (' + why + '). Send a new instruction to continue.'));
      toast('Stopped a repeating loop', 'err');
    }
    scrollDownSoft(chat);
  }
  else if (kind === 'error') appendError(chat, evt.error);
  else if (kind === 'exit') {
    chat.alive = false; chat.tabEl.classList.add('dead'); setBusy(chat, false);
    // The session is gone; no spinner may survive it in the tab bar.
    const m = window.__tabs && window.__tabs.get(chat.id);
    if (m) { m.busy = false; m.needsYou = false; }
    if (typeof window.updateNavState === 'function') window.updateNavState();
    const n = el('div', 'sys-note', '— chat session ended —');
    chat.msgs.appendChild(n); scrollDownSoft(chat);
  }
}

function handleMessage(chat, msg) {
  if (!msg || !msg.type) return;
  // Track the engine session id on the tab so the conversation list can mark
  // which rows are already open.
  if (msg.session_id && chat.tabEl) {
    const meta = window.__tabs && window.__tabs.get(chat.id);
    if (meta && meta.sessionId !== msg.session_id) {
      meta.sessionId = msg.session_id;
      window.onConvoSessionsChanged && window.onConvoSessionsChanged();
    }
  }
  // Track it on the chat too: fork / edit-and-resend pass chat.sessionId.
  if (msg.session_id) chat.sessionId = msg.session_id;
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') { chat.init = msg; onInit(chat); if (window.refreshOverview) window.refreshOverview(chat.id); }
      else if (msg.subtype === 'compact_boundary') {
        chat.msgs.querySelector('.chat-empty')?.remove();
        const manual = msg.compact_metadata && msg.compact_metadata.trigger === 'manual';
        const n = el('div', 'sys-note', manual
          ? '✂ conversation compacted — earlier turns summarized, same chat continues'
          : '✂ context auto-compacted by the engine — earlier history summarized');
        setTimeout(() => pollContext(chat), 300);
        chat.msgs.appendChild(n);
        scrollDownSoft(chat);
      } else handleSystemSubtype(chat, msg);
      break;
    case 'stream_event': handleStream(chat, msg.event, msg.parent_tool_use_id); break;
    case 'assistant': {
      // Replace any live blocks with the finalized rendering.
      clearLive(chat, msg.parent_tool_use_id);
      if (msg.error && msg.error !== 'unknown') {
        // The error code alone ("invalid_request") hid the provider's own
        // words ("model not found", "context too long"); show both.
        const detail = (msg.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        appendError(chat, detail ? msg.error + ': ' + detail.slice(0, 600) : msg.error);
        break;
      }
      for (const block of (msg.message?.content || [])) renderBlock(chat, block, msg.parent_tool_use_id);
      // Checklist fallback: only fresh messages count (a reconnect replays
      // the turn), and the stream is ordered so the last writer wins —
      // tool renders and parses simply overwrite each other.
      const text = (msg.message?.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
      const items = parseTodoChecklist(text);
      if (items) {
        const seen = chat.parsedTodoUuids || (chat.parsedTodoUuids = new Set());
        const fresh = !msg.uuid || !seen.has(msg.uuid);
        if (msg.uuid) {
          seen.add(msg.uuid);
          // Bound the dedup set so a long session cannot grow it forever.
          if (seen.size > 500) {
            const first = seen.values().next().value;
            seen.delete(first);
          }
        }
        if (fresh) renderTodos(chat, { todos: items });
      }
      scrollDownSoft(chat);
      break;
    }
    case 'user': {
      // A replayed user turn carries the uuid the engine checkpoints against,
      // which is what edit-and-resubmit and per-message rewind need.
      if (msg.uuid && msg.parent_tool_use_id == null) {
        const c2 = msg.message && msg.message.content;
        const isResult = Array.isArray(c2) && c2.some(b => b.type === 'tool_result');
        if (!isResult) {
          const t = typeof c2 === 'string'
            ? c2
            : (Array.isArray(c2) ? c2.filter(b => b.type === 'text').map(b => b.text).join(' ') : '');
          // Already drawn under this exact uuid (the engine replays a turn
          // after a reconnect). Drop it rather than draw the prompt twice —
          // matching by uuid, not by text, so two identical prompts are safe.
          const allNodes = chat._allNodes && chat._allNodes.length ? chat._allNodes : [...chat.msgs.children];
          const drawn = allNodes.some(n => n.dataset && n.dataset.uuid === msg.uuid);
          // Command output, the caveat note and the compaction summary are
          // recorded as user messages too; they are not prompts.
          const kind = window.CCEUserText ? CCEUserText.classifyUserText(t, msg) : { kind: 'prompt', text: t };
          if (kind.kind === 'skip') { /* nothing to show */ }
          else if (kind.kind === 'note') { if (!drawn) appendCommandNote(chat, kind.text, msg.uuid); }
          else if (kind.kind === 'summary') { if (!drawn) appendSummary(chat, kind.text, msg.uuid); }
          else if (!drawn && String(kind.text || '').trim()) {
            // The composer already showed this message when it was sent; the
            // engine's replay only adds the uuid. Swap it in place instead of
            // drawing the message twice.
            const sent = allNodes.find(n => n.classList && n.classList.contains('user-msg') && !n.dataset.uuid && (n.dataset.text === String(t).trim() || n.dataset.text === kind.text));
            const fresh = appendUser(chat, kind.text, msg.uuid);
            if (sent) {
              if (sent.parentNode === chat.msgs) sent.replaceWith(fresh);
              if (chat._allNodes) {
                const idx = chat._allNodes.indexOf(sent);
                if (idx !== -1) chat._allNodes[idx] = fresh;
                const freshIdx = chat._allNodes.lastIndexOf(fresh);
                if (freshIdx !== -1 && freshIdx !== idx) chat._allNodes.splice(freshIdx, 1);
              }
            }
          }
        }
      }
      for (const block of (msg.message?.content || [])) {
        if (block.type === 'tool_result') resolveToolResult(chat, block);
      }
      break;
    }
    // Frames the UI previously ignored. Several are user-visible states the
    // desktop app shows: retry notices, rate limits, denials, and the next
    // prompt suggestions. #26
    case 'tool_progress':
    case 'agent_progress':
    case 'agent_progress_summary': onToolProgress(chat, msg); break;
    case 'api_retry': onApiRetry(chat, msg); break;
    case 'rate_limit': onRateLimit(chat, msg); break;
    case 'prompt_suggestion':
    case 'prompt_suggestions': onPromptSuggestion(chat, msg); break;
    case 'permission_denied': onPermissionDenied(chat, msg); break;
    case 'session_state_changed': onSessionState(chat, msg); break;
    case 'commands_changed': onCommandsChanged(chat, msg); break;
    case 'engine_notification': onEngineNotification(chat, msg); break;
    case 'result': {
      chat.lastResult = msg;
      endTurnCleanup(chat);
      if (!msg.is_error && msg.subtype === 'success') chat.switchedFrom = null;   // the new provider works
      if (window.refreshOverview) window.refreshOverview(chat.id);
      // Local-only observability: token-per-turn log for later analysis. #obs
      try {
        const u = msg.usage || {};
        const entry = { t: Date.now(), chat: chat.id, in: u.input_tokens || 0, out: u.output_tokens || 0, cost: msg.total_cost_usd || 0 };
        const key = 'cce:tokenlog';
        const prev = JSON.parse(localStorage.getItem(key) || '[]');
        prev.push(entry);
        if (prev.length > 500) prev.splice(0, prev.length - 500);
        localStorage.setItem(key, JSON.stringify(prev));
      } catch { /* ignore */ }
      const metered = !chat.provider || !chat.provider.baseUrl;
      if (metered && typeof msg.total_cost_usd === 'number') chat.spent = (chat.spent || 0) + msg.total_cost_usd;
      setStatusLine(chat);
      const queued = Number(msg.queued_turn_count) || 0;
      setBusy(chat, queued > 0);   // more turns waiting: still working
      // A coalesced turn can answer several prompts at once; say which, so a
      // user who sent two messages knows both were taken.
      for (const u of (msg.user_message_uuids || (msg.user_message_uuid ? [msg.user_message_uuid] : []))) {
        if (u) (chat.answeredUuids || (chat.answeredUuids = new Set())).add(u);
      }
      showQueued(chat, queued);
      if (chat.memProbe) {
        chat.memProbe = false;
        collectMemoryProbe(chat, msg);
      } else if (chat.compacting) {
        chat.compacting = false;
        const brief = String(msg.result || '').trim();
        if (msg.subtype === 'success' && brief) {
          chat.msgs.appendChild(el('div', 'sys-note', '✂ handoff brief ready — opening a fresh session…'));
          createSession({
            cwd: chat.cwd,
            providerUid: chat.provider ? chat.provider.uid : null,
            model: chat.model || '',
            permissionMode: chat.mode,
            initText: 'Handoff brief from the previous session (compacted):\n\n' + brief + '\n\nConfirm you have the context by replying \"ready\", then wait for my next instruction.',
          });
          // The old engine is finished; a late status frame from it must
          // not resurrect this tab's busy spinner.
          chat.handedOff = true;
        } else {
          appendError(chat, 'Compaction failed (' + msg.subtype + '). The engine auto-compacts near the context limit regardless.');
        }
      } else if (msg.subtype === 'success' && !msg.is_error && (chat.results = (chat.results || 0) + 1) >= 3 && !chat.memProbed) {
        setTimeout(() => maybeProbeMemory(chat), 1500);   // auto-memory, opt-in, once per chat
      } else if (msg.subtype === 'success' && !msg.is_error && maybeNudge(chat, msg)) {
        // nudged: the next turn starts by itself
      } else if (msg.subtype !== 'success' || msg.is_error) {
        // A refused branch (edit-and-resubmit picked a message the engine
        // cannot fork at) carries this prefix per the SDK docs. Say what it
        // means instead of dumping the raw error. #5
        const text = String(msg.result || '');
        if (/Resume rejected by --resume-drops-turn:/.test(text)) {
          const m = el('div', 'msg error-msg');
          m.appendChild(el('div', '', '⚠ Could not branch from that message — the engine only allows forking at certain points.'));
          const row = el('div', 'perm-actions');
          const retry = el('button', 'btn small primary', 'Branch from the latest message instead');
          retry.addEventListener('click', () => {
            Chat.createSession({
              cwd: chat.cwd,
              providerUid: chat.provider ? chat.provider.uid : null,
              model: chat.model || '',
              permissionMode: chat.mode,
              resume: chat.sessionId, fork: true,
            });
          });
          row.appendChild(retry);
          m.appendChild(row);
          chat.msgs.appendChild(m);
          scrollDownSoft(chat);
        } else {
          appendError(chat, (explainTerminal(msg.terminal_reason) || 'Turn failed (' + msg.subtype + ')')
            + (text ? ': ' + text.slice(0, 300) : ''));
        }
      }
      break;
    }
    case 'local_command_output': case 'notification': case 'status': {
      const text = Array.isArray(msg.output) ? msg.output.join('\n') : (msg.output || msg.message || '');
      if (text) { const pre = el('div', 'sys-note mono', String(text).slice(0, 2000)); chat.msgs.appendChild(pre); scrollDownSoft(chat); }
      break;
    }
    default: break; // replay/auth_status/etc — ignored in v1
  }
}

/* ---------------- previously ignored engine frames (#26) ---------------- */

// tool_progress carries elapsed time for a long-running tool; surface it on
// the matching card instead of leaving the user staring at a spinner.
function onToolProgress(chat, msg) {
  const ctx = chat.tools.get(msg.tool_use_id);
  const secs = Math.round(Number(msg.elapsed_time_seconds) || 0);
  const summary = msg.summary || msg.agent_progress || msg.status || '';
  if (ctx) {
    if (!ctx.statusEl) ctx.statusEl = el('span', 'tool-elapsed', '');
    ctx.card.querySelector('.tool-head').appendChild(ctx.statusEl);
    const text = (summary ? summary + (secs >= 1 ? ' · ' : '') : '') + (secs >= 1 ? secs + 's' : '');
    ctx.statusEl.textContent = text;
  } else if (chat.msgs && !chat.busy && !secs) {
    // ignore heartbeats for tools we no longer track
  }
}

// api_retry: the provider rejected a request and the engine is backing off.
// Silence here looks like a hang.
function onApiRetry(chat, msg) {
  chat.msgs.querySelector('.chat-empty')?.remove();
  const attempt = msg.attempt != null ? ' (attempt ' + msg.attempt + ')' : '';
  const wait = msg.retry_delay_ms ? ' in ' + Math.round(msg.retry_delay_ms / 1000) + 's' : '';
  const note = el('div', 'sys-note warn', '↻ provider error, retrying' + wait + attempt
    + (msg.error ? ' — ' + String(msg.error).slice(0, 160) : ''));
  chat.msgs.appendChild(note);
  scrollDownSoft(chat);
}

// rate_limit: surface the reset instead of appearing to hang.
function onRateLimit(chat, msg) {
  const until = msg.resets_at ? new Date(msg.resets_at * 1000).toLocaleTimeString() : '';
  chat.msgs.appendChild(el('div', 'sys-note warn',
    '⏳ rate limited by the provider' + (until ? ' — resets at ' + until : '')
    + (msg.remaining_tokens ? ' · ' + msg.remaining_tokens + ' tokens left' : '')));
  scrollDownSoft(chat);
}

// permission_denied: the engine denied a tool without asking us (mode change,
// subagent rule, or an interrupt race). The user should see it.
function onPermissionDenied(chat, msg) {
  const reason = msg.reason || msg.message || 'no reason given';
  chat.msgs.appendChild(elIcon('div', 'sys-note warn',
    CCEIcons.svg('error', 13) + ' ' + esc(String(msg.tool_name || 'tool') + ' denied: ' + String(reason).slice(0, 200))));
  scrollDownSoft(chat);
}

// prompt_suggestion: predicted next prompts, as clickable chips. #37
function onPromptSuggestion(chat, msg) {
  const picks = Array.isArray(msg.suggestions) ? msg.suggestions
    : (Array.isArray(msg.prompt_suggestions) ? msg.prompt_suggestions
    : (msg.prompt ? [msg.prompt] : []));
  if (!picks.length) return;
  chat.suggestions?.remove();
  const row = el('div', 'chat-suggestions');
  row.appendChild(el('span', 'hint', 'next:'));
  for (const raw of picks.slice(0, 4)) {
    const text = typeof raw === 'string' ? raw : String(raw.prompt || raw.text || '');
    if (!text) continue;
    const chip = el('button', 'sugg-chip', text.slice(0, 90));
    chip.title = text;
    chip.addEventListener('click', () => {
      chat.composer.value = text;
      autosize(chat.composer);
      chat.composer.focus();
      row.remove();
    });
    row.appendChild(chip);
  }
  if (row.children.length > 1) {
    chat.msgs.appendChild(row);
    scrollDownSoft(chat);
  }
  chat.suggestions = row;
}

// session_state_changed: permission mode or model changed by the engine.
function onSessionState(chat, msg) {
  const s = msg.state || msg;
  const engineMode = s.permission_mode ? uiMode(s.permission_mode, chat.provider, chat.autoPolicy) : null;
  if (engineMode && engineMode !== chat.mode) {
    chat.mode = engineMode;
    chat.modeSel.value = engineMode;
    setStatusLine(chat);
  }
  if (s.model && s.model !== chat.model) {
    chat.model = s.model;
    // The menu kept showing the old pick while the engine used another.
    if (![...chat.modelSel.options].some(o => o.value === s.model)) {
      const o = el('option', '', s.model); o.value = s.model;
      chat.modelSel.insertBefore(o, chat.modelSel.querySelector('[value="__custom"]'));
    }
    chat.modelSel.value = s.model;
    setStatusLine(chat);
  }
}

// commands_changed: the slash-command list changed (a plugin installed, a file
// appeared). Refresh so the palette is not stale.
function onCommandsChanged(chat, msg) {
  chat.slashCatalog = null;   // re-read on the next "/"
  const list = msg.commands || msg.slash_commands;
  if (Array.isArray(list)) {
    chat.commands = list.map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean);
    chat.commandDetails = Array.isArray(list) && typeof list[0] === 'object' ? list : chat.commandDetails;
  }
}

function onEngineNotification(chat, msg) {
  const text = String(msg.message || msg.notification || '');
  if (text) {
    chat.msgs.appendChild(el('div', 'sys-note', text.slice(0, 400)));
    scrollDownSoft(chat);
  }
}

// System subtypes that are neither init nor compact_boundary.
// The engine now reports WHY a turn ended in `terminal_reason`, so a dead turn
// is classified from that instead of being guessed at from the subtype or by
// matching prose. Each reason maps to the one thing the user can actually do.
const TERMINAL_WHY = {
  prompt_too_long: 'This prompt is too long for the model — the context is full.',
  model_error: 'The model rejected the request.',
  api_error: 'The provider failed mid-turn.',
  image_error: 'An image in the conversation could not be read.',
  budget_exhausted: 'The budget cap stopped this turn.',
  max_turns: 'The turn limit stopped this turn.',
  blocking_limit: 'A limit on the conversation blocked this turn.',
  rapid_refill_breaker: 'Paused after too many rapid retries — the provider is struggling.',
  malformed_tool_use_exhausted: 'The model could not produce a valid tool call.',
  structured_output_retry_exhausted: 'The model could not produce valid structured output.',
  tool_deferred_unavailable: 'A tool this turn needed was unavailable.',
  tool_deferred: 'A tool was deferred to a later turn.',
  stop_hook_prevented: 'A Stop hook ended this turn before it was finished.',
  hook_stopped: 'A hook stopped this turn.',
  aborted_streaming: 'Interrupted while streaming.',
  aborted_tools: 'Interrupted while tools were running.',
  background_requested: 'This turn moved to a background task.',
  turn_setup_failed: 'The turn could not be started.',
};

function explainTerminal(reason) {
  return reason && reason !== 'completed' ? (TERMINAL_WHY[reason] || null) : null;
}

// Messages sent while a turn was running are queued, not dropped. The engine
// reports how many are left; without this the composer looks idle when work
// is still coming.
function showQueued(chat, n) {
  chat.queued = n;
  publishTabState(chat);
  chat.queuedNote?.remove();
  chat.queuedNote = null;
  if (n > 0) {
    chat.queuedNote = el('div', 'sys-note', '⏭ ' + n + ' message' + (n === 1 ? '' : 's') + ' queued — running next');
    chat.msgs.appendChild(chat.queuedNote);
    scrollDownSoft(chat);
  }
}

function handleSystemSubtype(chat, msg) {
  if (msg.subtype === 'permission_denied') return onPermissionDenied(chat, msg);
  if (msg.subtype === 'commands_changed') return onCommandsChanged(chat, msg);
  if (msg.subtype === 'session_state_changed') return onSessionState(chat, msg);
  if (msg.subtype === 'elicitation_complete') {   // connector finished its OAuth round-trip
    const card = chat.permSlot.querySelector('.elic[data-elid="' + (msg.elicitation_id || msg.elicitationId || '') + '"]');
    if (card) {
      ccx.invoke('chat:elicit-answer', { id: chat.id, requestId: card.dataset.rid, action: 'accept', content: {} });
      dropElicCard(chat, card);
      toast('Connector authorized', 'ok');
    }
    return;
  }
  if (msg.subtype === 'compact_boundary') return;   // already handled
}

function onInit(chat) {
  chat.msgs.querySelector('.chat-empty')?.remove();
  pollContext(chat).catch(() => {});   // the footer ring shows usage from the start
  // A plugin that failed to load is simply absent from the tool list, which
  // used to look like "that connector does not exist". Say which ones broke.
  for (const e of (chat.init.plugin_errors || [])) {
    const n = el('div', 'sys-note warn', '⚠ plugin ' + (e.plugin || '?') + ' failed to load: ' + String(e.message || e.type || '').slice(0, 200));
    chat.msgs.appendChild(n);
  }
  // show what CLAUDE.md memory the engine auto-loads (imported from claude config)
  if (!chat.memChipAdded) {
    chat.memChipAdded = true;
    ccx.invoke('memory:read', { cwd: chat.cwd }).then(r => {
      if (!r.ok) return;
      const g = (r.global.content || '').length;
      const pr = r.project && r.project.content ? r.project.content.length : 0;
      if (g || pr) {
        const chip = elIcon('span', 'proj-chip sandbox', CCEIcons.svg('brain', 13) + ' memory loaded');
        chip.title = 'Auto-imported from your claude config:\n'
          + '~/.claude/CLAUDE.md — ' + g.toLocaleString() + ' chars'
          + (pr ? '\n' + r.project.path + ' — ' + pr.toLocaleString() + ' chars' : '')
          + '\n\nThese are applied to every session automatically.';
        const old = chat.projEl.querySelector('.mem-chip');
        if (old) old.remove();
        chip.classList.add('mem-chip');
        chat.projEl.appendChild(chip);
      }
    }).catch(() => {});
  }
  if (!chat.pendingChipChecked) { chat.pendingChipChecked = true; showPendingChip(chat); }
  // model selector: reflect live model
  if (chat.init.model && ![...chat.modelSel.options].some(o => o.value === chat.init.model)) {
    const o = el('option', '', chat.init.model + ' (session)');
    o.value = chat.init.model;
    chat.modelSel.insertBefore(o, chat.modelSel.querySelector('[value="__custom"]'));
  }
  if (!chat.model) { chat.model = chat.init.model; }
  // Reflect the model actually in force (auto-picked, typo-corrected, or
  // engine-default) in the dropdown whenever a matching option exists.
  if (chat.model && [...chat.modelSel.options].some(o => o.value === chat.model)) chat.modelSel.value = chat.model;
  setStatusLine(chat);
  // commands for the slash palette
  chat.commands = (chat.init.slash_commands || []).filter(c => !(chat.init.terminal_slash_commands || []).includes(c));
  renderMcpChips(chat);
  healthCheck(chat);
}

// Startup health: MCP servers that did not connect + runtime tools skills need.
export const INSTALL_CMD = {
  git: 'sudo apt install -y git',
  bun: 'curl -fsSL https://bun.sh/install | bash',
  uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
  rg: 'sudo apt install -y ripgrep',
  fd: 'sudo apt install -y fd-find',
};

function healthCheck(chat) {
  if (chat.healthDone) return;
  chat.healthDone = true;
  const servers = (chat.init && chat.init.mcp_servers) || [];
  // Connectors the user switched off are not failures.
  const bad = servers.filter(s => s.status !== 'connected' && s.status !== 'disabled');
  if (bad.length) {
    chat.msgs.appendChild(el('div', 'sys-note',
      '⚠ MCP not ready: ' + bad.map(s => s.name + ' (' + s.status + ')').join(', ') + ' — run /mcp to reconnect'));
    scrollDownSoft(chat);
  }
  ccx.invoke('tools:check').then((r) => {
    if (!r.ok) return;
    const missing = (r.tools || []).filter(t => !t.found).map(t => t.name);
    if (missing.length) {
      chat.msgs.appendChild(el('div', 'sys-note',
        '⚠ missing tools some skills need: ' + missing.join(', ') + ' — install them from the skills panel'));
      scrollDownSoft(chat);
    }
  }).catch(() => {});
}

// The per-server chips were retired: the Connectors card in the side panel shows them.
function renderMcpChips(chat) {
  chat.headerEl.querySelector('.chat-mcp-chips')?.remove();
}

/* ---------------- streaming (per-thread: main + each subagent) ---------------- */

export function clearLive(chat, parentId) {
  const key = parentId || 'main';
  const live = chat.lives && chat.lives.get(key);
  if (!live) return;
  // Paint the last coalesced delta out fully before the finalized blocks
  // replace these — otherwise a short reply can lose its final sentence.
  for (const [, b] of live.blocks) if (b.type === 'text' && b.text) flushMarkdown(b);
  // Go through the patched removeChild so the virtualization list drops them
  // too; a bare remove() left stale entries that rebuildWindow re-appended.
  const drop = (n) => {
    if (!n) return;
    if (n.parentNode === chat.msgs) chat.msgs.removeChild(n); else n.remove();
  };
  for (const [, b] of live.blocks) { drop(b.node); drop(b.think); }
  chat.lives.delete(key);
}

/** A turn ended without message_stop (interrupt/error): sweep what it left. */
function endTurnCleanup(chat) {
  if (chat.lives) for (const key of [...chat.lives.keys()]) clearLive(chat, key === 'main' ? null : key);
  if (chat.tools) {
    for (const ctx of chat.tools.values()) {
      if (ctx.status === 'running' && ctx.setStatus) ctx.setStatus('err', 'cancelled');
    }
  }
}

/** JSON.parse that returns null instead of throwing on partial input. */
export function tryJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return null; }
}
