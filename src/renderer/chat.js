// Claude Code Enhanced — chat tabs powered by the Claude Agent SDK.
// Renders the same message stream the Claude Code desktop app shows:
// streaming text/thinking, tool cards, diffs, todos, permissions,
// plan approval, slash-command palette, model + mode selectors, skills.
'use strict';

const Chat = (() => {
  const chats = new Map(); // id -> chat view state

  // A reply that shows a fenced example inside a fenced block (a ```markdown
  // block holding ```pine) closes early at the first inner fence, so the rest of
  // the block renders as loose text. Lengthen the outer fence past the inner ones.
  function fixNestedFences(text) {
    if (!text || !text.includes('```')) return text;
    const open = /^ {0,3}(`{3,})[^`\s]/;      // a fence with an info string
    const bare = /^ {0,3}(`{3,})\s*$/;        // a bare fence: closes
    const plain = /^ {0,3}(`{3,})[^`]*$/;     // any opening fence
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(plain);
      if (!m) { i++; continue; }
      const start = i;
      let depth = 0, longest = m[1].length, end = -1, nested = false;
      for (let j = i + 1; j < lines.length; j++) {
        const o = lines[j].match(open);
        if (o && !bare.test(lines[j])) { depth++; nested = true; longest = Math.max(longest, o[1].length + 1); continue; }
        if (bare.test(lines[j])) { if (depth === 0) { end = j; break; } depth--; }
      }
      if (end < 0) break;                      // still streaming: leave it alone
      if (nested) {
        const ticks = '`'.repeat(longest);
        lines[start] = lines[start].replace(/`{3,}/, ticks);
        lines[end] = lines[end].replace(/`{3,}/, ticks);
      }
      i = end + 1;
    }
    return lines.join('\n');
  }

  const md = (text) => {
    try {
      let html = DOMPurify.sanitize(marked.parse(fixNestedFences(text || ''), { breaks: true, gfm: true }));
      // collapse runs of empty rules (some relays pad replies with '---' lines)
      html = html.replace(/(?:<hr\s*\/?>\s*(?:<p>\s*<\/p>\s*)*){3,}/g, '<hr>');
      return html;
    } catch {
      // Escaped text, not raw: the return value is assigned to innerHTML, so
      // returning the bare string was an injection path when marked/DOMPurify
      // were unavailable. #7
      return esc(text || '');
    }
  };

  // Reasoning the model wrote into its reply rather than the thinking channel.
  // Shared with the proxy (src/shared/think.js) — the two must agree on the cut.
  const { splitThink } = CCEThink;

  // Real HTML escaping. The old version was String(s), and it fed innerHTML with
// tool names — MCP tool names come from remote servers and are untrusted. #7
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

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
  const toolIcon = (name) => CCEIcons.svg(
    name && name.startsWith('mcp__') ? 'plug' : (TOOL_ICONS[name] || 'wrench'), 15);
  function toolTitle(name, input = {}) {
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

  /* ---------------- session lifecycle ---------------- */

  async function createSession(opts) {
    const res = await ccx.invoke('chat:create', opts);
    if (!res.ok) { toast('Failed to start chat: ' + res.error, 'err'); switchView('terminal'); return; }
    const id = res.id;

    const pane = el('div', 'term-pane chat-pane active');
    pane.innerHTML = `
      <div class="chat-header">
        <span class="chat-dot" title="ready"></span>
        <span class="chat-project"></span>
        <span class="chat-provider" title="provider"></span>
        <span class="chat-header-sep"></span>
        <button class="chat-btn chat-mgr-btn hidden" title="Model manager: load / unload, context size, keep-alive"><span data-icon="gear"></span> models</button>
        <button class="chat-btn chat-stop hidden" title="Interrupt (Esc)"><span data-icon="square"></span> stop</button>
        <button class="chat-btn chat-build-now hidden" title="Stop investigating and build now (Interrupt & steer to immediate implementation)"><span data-icon="bolt"></span> build now</button>
        <button class="chat-btn chat-cont-btn hidden" title="Continue from where the model stopped — completes remaining work"><span data-icon="play"></span> continue</button>
        <button class="chat-btn hdr-more" title="Chat actions" aria-label="Chat actions"><span data-icon="dots"></span></button>
      </div>
      <div class="chat-ctxbar hidden" title="Context window usage"><i></i></div>
      <div class="chat-body">
        <div class="chat-msgs">
          <div class="chat-empty">
            <div class="chat-empty-icon" data-icon="terminal"></div>
            <h3>Claude Code</h3>
            <p>Ask anything about this project. Claude can read & edit files, run commands, use skills and MCP tools — you approve each step.</p>
            <p class="chat-empty-hint">Type <b>/</b> for commands · <b>Enter</b> to send · <b>Shift+Enter</b> newline</p>
          </div>
        </div>
        <button class="chat-latest hidden" title="Jump to the latest response (End)" aria-label="Jump to the latest response">
          <span data-icon="chevron"></span><span class="chat-latest-label">latest</span>
        </button>
      </div>
      <div class="chat-perm-slot"></div>
      <div class="chat-composer">
        <div class="chat-imgs hidden"></div>
        <div class="chat-queued hidden"></div>
        <div class="chat-slash hidden"></div>
        <div class="chat-input-row">
          <button class="chat-attach" title="Attach an image or a file" aria-label="Attach a file"><span data-icon="clip2"></span></button>
          <textarea class="chat-input" rows="1" placeholder="Ask Claude to work on this project…  (@ files · / commands · paste images)"></textarea>
          <button class="chat-busy-mode hidden" title="Toggle Queue vs Steer mode when busy"><span class="busy-mode-badge queue">⏭ Queue</span></button>
          <button class="chat-send" title="Send (Enter)" aria-label="Send"><span data-icon="send"></span></button>
        </div>
        <div class="chat-footbar">
          <button class="foot-pick chat-wf-btn" title="Workflows — multi-step task flows" aria-haspopup="menu"><span data-icon="flow"></span><span>workflows</span><span class="caret" data-icon="chevron"></span></button>
          <select class="foot-pick chat-model-foot" title="Model"></select>
          <select class="foot-pick chat-mode-foot" title="Permission mode"></select>
          <button class="foot-pick chat-effort" title="Reasoning effort (click to cycle)">effort: auto</button>
          <select class="foot-pick chat-style-foot hidden" title="Output style"></select>
          <span class="foot-spacer"></span>
          <button class="foot-pick chat-compact-btn" title="Compact this conversation in place — earlier turns are summarized, the chat keeps going"><span class="ctx-ring" style="--p:0"></span><span class="ctx-pct">ctx</span><span>compact</span></button>
        </div>
        <div class="chat-statusline"><span class="sl-left">ready — the session starts with your first message</span><span class="sl-right"></span></div>
      </div>`;

    $('#terminals').appendChild(pane);
    // The shell template declares icons by name; fill them with the shared SVG
    // set. Defined in app.js, which loads after this file but before any chat
    // is created. #54
    if (typeof paintDeclaredIcons === 'function') paintDeclaredIcons(pane);

    const chat = {
      follow: true,   // keep the view pinned to new output until the user scrolls up
      id, cwd: res.cwd, provider: res.provider, model: res.model || '', mode: uiMode(res.permissionMode, res.provider),
      pane, msgs: pane.querySelector('.chat-msgs'), composer: pane.querySelector('.chat-input'),
      sendBtn: pane.querySelector('.chat-send'), stopBtn: pane.querySelector('.chat-stop'),
      buildNowBtn: pane.querySelector('.chat-build-now'),
      statusLine: pane.querySelector('.chat-statusline .sl-left'),
      statusRight: pane.querySelector('.chat-statusline .sl-right'),
      dot: pane.querySelector('.chat-dot'), providerEl: pane.querySelector('.chat-provider'),
      projEl: pane.querySelector('.chat-project'),
      headerEl: pane.querySelector('.chat-header'),
      modelSel: pane.querySelector('.chat-model-foot'), modeSel: pane.querySelector('.chat-mode-foot'),
      effortBtn: pane.querySelector('.chat-effort'), attachBtn: pane.querySelector('.chat-attach'),
      styleSel: pane.querySelector('.chat-style-foot'),
      // Element ref and queue *counter* must not share a name: showQueued used
      // to overwrite the element with a number and the next send threw.
      queuedEl: pane.querySelector('.chat-queued'),
      permSlot: pane.querySelector('.chat-perm-slot'), slash: pane.querySelector('.chat-slash'),
      latestBtn: pane.querySelector('.chat-latest'),
      todos: [],
      moreBtn: pane.querySelector('.hdr-more'),
      ctxBar: pane.querySelector('.chat-ctxbar'),
      ctxFill: pane.querySelector('.chat-ctxbar i'),
      imgs: pane.querySelector('.chat-imgs'),
      contBtn: pane.querySelector('.chat-cont-btn'),
      busyModeBtn: pane.querySelector('.chat-busy-mode'),
      busyMode: 'queue',
      wfBtn: pane.querySelector('.chat-wf-btn'),
      compactBtn: pane.querySelector('.chat-compact-btn'),
      init: null, lives: null, tools: new Map(), busy: false, alive: true, dead: false,
      skillsDetail: [], slashIdx: -1, slashItems: [], sandbox: !!res.sandbox,
      pendingImages: [], promptHistory: [], histIdx: -1, filesCache: null,
      titled: false, atMode: false, compacting: false, unread: false,
      permCount: 0, ctxTimer: null, spent: 0, hooks: [], bgTasks: new Map(),
      pendingMsgs: [], effort: '', suggested: false,
      pendingResults: new Map(),
      // Live output of a running task that beat its card. #feat-live-output
      pendingLive: new Map(),
      // The live tail per tool call. Kept on the chat, not on the card, so a
      // card that is re-rendered (a streamed call is redrawn when the final
      // assistant message lands) still shows the running output.
      liveTasks: new Map(),
      // The unfiltered text of a result the engine compacted for the model.
      // #feat-output-filter
      toolOriginals: new Map(),
    };
    chats.set(id, chat);
    installVirtualization(chat);
    chat.msgs.addEventListener('scroll', () => {
      chat.follow = nearBottom(chat);
      updateLatestBtn(chat);
    }, { passive: true });
    // The button appears as soon as the view leaves the live end, and clicking
    // it returns to the newest response (and re-arms auto-follow).
    if (chat.latestBtn) {
      chat.latestBtn.addEventListener('click', () => {
        chat.follow = true;
        scrollDown(chat);
        updateLatestBtn(chat);
        chat.msgs.focus({ preventScroll: true });
      });
    }
    if (window.__CCE_SMOKE) console.log('[chat-created]', id, 'map size', chats.size);

    // tab
    const tab = el('div', 'tab active');
    tab.appendChild(el('span', '', '⌘ ' + basename(res.cwd)));
    const closeBtn = el('button', 'close', '✕');
    closeBtn.title = 'Close chat';
    closeBtn.setAttribute('aria-label', 'Close chat');
    tab.appendChild(closeBtn);
    // Read chat.id at click time: a provider switch re-keys the chat onto a
    // new engine id (the listeners' creation-time `id` would go dead and the
    // tab could neither be viewed nor closed).
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeChat(chat.id); });
    tab.addEventListener('click', () => activateChat(chat.id));
    $('#tabs').appendChild(tab);
    chat.tabEl = tab;

    registerTab(id, { kind: 'chat', pane, tabEl: tab, sessionId: null, cwd: chat.cwd, focus: () => { if (chat.alive) chat.composer.focus(); } });
    // Restore any draft left by a crash/refresh. #crash-recovery
    try {
      const d = localStorage.getItem('cce:draft:' + (chat.cwd || ''));
      if (d) { chat.composer.value = d; autosize(chat.composer); }
    } catch { /* ignore */ }
    try {
      const p = JSON.parse(localStorage.getItem('cce:pending:' + (chat.cwd || '')) || '[]');
      if (Array.isArray(p) && p.length) { chat.pendingMsgs = p; renderQueued(chat); }
    } catch { /* ignore */ }
    // The nav badge counts every open tab, chat tabs included.
    if (typeof window.updateTabCount === 'function') window.updateTabCount();

    // project folder + linked GitHub repo, like the desktop header
    renderProjectInfo(chat);
    if (res.worktree) {   // isolated git worktree for this chat #feat-worktree
      const chip = el('span', 'proj-chip sandbox', '⌥ ' + res.worktree.branch);
      chip.title = 'This chat edits git worktree ' + res.worktree.path;
      chat.projEl.appendChild(chip);
    }
    if (chat.provider && chat.provider.baseUrl) {
      const mgr = pane.querySelector('.chat-mgr-btn');
      if (mgr) mgr.classList.remove('hidden');
    }
    discoverModels(chat);
    if (chat.sandbox) {
      const chip = el('span', 'proj-chip sandbox', '⛨ sandboxed');
      chip.title = 'Bash commands run in a Bubblewrap sandbox (filesystem/network restricted). Configure in Settings.';
      chat.projEl.appendChild(chip);
    }

    // composer controls (model + mode moved out of the header into the footer,
    // as in the desktop app). #32 #33
    fillModelSelector(chat);
    fillModeSelect(chat.modeSel, chat.provider);
    chat.modeSel.value = chat.mode;
    // Output style picker (desktop parity). The list comes from the engine, so
    // it fills at init; hidden when the machine defines no styles. #feat-output-styles
    chat.styleSel.addEventListener('change', async () => {
      const v = chat.styleSel.value;
      const r = await ccx.invoke('chat:flags', { id, patch: { outputStyle: v || null } });
      toast(r && r.ok ? ('style: ' + (v || 'auto')) : 'style change failed', r && r.ok ? 'ok' : 'err');
    });
    chat.modelSel.addEventListener('change', async () => {
      const v = chat.modelSel.value;
      if (v.startsWith('__prov:')) { await switchProvider(chat, v.slice(7)); return; }
      if (v === '__custom') { openCustomModel(chat); return; }
      await switchModel(chat, v);
    });
    chat.modeSel.addEventListener('change', async () => {
      const want = chat.modeSel.value;
      const r = await ccx.invoke('chat:set-mode', { id, mode: want });
      if (r.ok) {
        // The main process is the authority: it may fall back (auto → accept edits on a third-party provider).
        chat.mode = uiMode(r.permissionMode || want, chat.provider);
        chat.modeSel.value = chat.mode;
        if (chat.mode !== want) toast('auto needs Anthropic’s own API — using ' + modeLabel(chat.mode) + ' instead', 'err');
        else toast('Mode → ' + modeLabel(chat.mode), 'ok');
        setStatusLine(chat);
      } else { toast(r.error, 'err'); chat.modeSel.value = chat.mode; }
    });
    chat.effortBtn.addEventListener('click', () => cycleEffort(chat));
    chat.stopBtn.addEventListener('click', () => ccx.invoke('chat:interrupt', { id }));
    if (chat.buildNowBtn) {
      chat.buildNowBtn.addEventListener('click', async () => {
        await ccx.invoke('chat:interrupt', { id });
        chat.composer.value = 'Stop investigating. Apply the requested changes directly based on what you already know.';
        chat.send();
      });
    }

    // Header overflow menu. 13 buttons wrapped onto three rows; everything that
    // is not model/mode/stop now lives behind one "⋯". #33
    const forkConversation = async () => {
      try {
        const p = await ccx.invoke('chat:fork', { id });
        if (!p.ok) throw new Error(p.error || 'fork failed');
        toast('Forking conversation…');
        await Chat.createSession({
          cwd: p.cwd, providerUid: p.providerUid, model: p.model,
          permissionMode: p.permissionMode, resume: p.sessionId, fork: true,
        });
      } catch (e) { toast(String(e.message || e), 'err'); }
    };
    chat.forkBtn = { click: forkConversation };   // palette entry points at this
    wireHeaderMenu(chat, forkConversation);
    wireRunMenu(chat);
    // Ctrl+K / Ctrl+E live in app.js's global shortcuts: a listener on the pane
    // only fired while the composer had focus, so a click on the transcript
    // silently disabled them.

    // composer
    const send = (action) => {
      const text = chat.composer.value.trim();
      const blocks = chat.pendingImages.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }));
      if ((!text && !blocks.length) || !chat.alive) return;
      if (text.startsWith('/') && !blocks.length && handleBuiltin(chat, text)) {
        chat.composer.value = '';
        autosize(chat.composer);
        hideSlash(chat);
        return;
      }
      chat.follow = true;   // sending jumps back to the live end
      updateLatestBtn(chat);
      if (text !== NUDGE_TEXT) chat.nudges = 0;   // a real prompt re-arms the one automatic nudge
      try { localStorage.removeItem('cce:draft:' + (chat.cwd || '')); } catch { /* ignore */ }

      if (chat.busy) {
        const mode = action || chat.busyMode || 'queue';
        if (mode === 'queue') {
          appendUser(chat, text || '(image)');
          chat.pendingMsgs.push(blocks.length ? { text, blocks } : text);
          renderQueued(chat);
          try { localStorage.setItem('cce:pending:' + (chat.cwd || ''), JSON.stringify(chat.pendingMsgs)); } catch { /* ignore */ }
          chat.msgs.appendChild(el('div', 'sys-note', '⏭ queued — will run after current turn finishes'));
          scrollDownSoft(chat);
          chat.composer.value = '';
          autosize(chat.composer);
          hideSlash(chat);
          clearImages(chat);
          updateBusyUi(chat);
          return;
        }

        // Steer mode: interrupt immediately and redirect
        appendUser(chat, text || '(image)');
        chat.msgs.appendChild(el('div', 'sys-note', '↯ steered — interrupted and redirected Claude'));
        scrollDownSoft(chat);
        if (text && (!chat.promptHistory.length || chat.promptHistory[0] !== text)) {
          chat.promptHistory.unshift(text);
          if (chat.promptHistory.length > 100) chat.promptHistory.pop();
        }
        chat.histIdx = -1;
        chat.composer.value = '';
        autosize(chat.composer);
        hideSlash(chat);
        clearImages(chat);
        updateBusyUi(chat);
        ccx.invoke('chat:steer', { id, text, blocks: blocks.length ? blocks : null }).then((r) => {
          if (!r || !r.ok) {
            appendError(chat, 'Not sent — ' + ((r && r.error) || 'the session is no longer running; open a new chat (Ctrl+Shift+T)'));
            setBusy(chat, false);
          }
        }).catch((e) => {
          appendError(chat, 'Not sent — ' + ((e && e.message) || e));
          setBusy(chat, false);
        });
        return;
      }

      // Warn before sending into a nearly-full context window. #token-budget
      if (chat.ctxUsage && Number(chat.ctxUsage.percentage) >= 80) {
        toast('Context is ' + Number(chat.ctxUsage.percentage).toFixed(0) + '% full — consider /compact', 'warn');
      }
      // A finished list retires on a new prompt (no note — the next turn
      // brings its own); unfinished work stays visible through the steer.
      if (chat.todos.length && chat.todos.every(t => t.status === 'completed')) clearTodos(chat);
      // Seed a list from the prompt's own steps when the model has not produced
      // one yet (and the current list is empty/finished). #todos-every-model
      if (!chat.todos.length) {
        const seeded = seedTodosFromPrompt(text);
        if (seeded) renderTodoItems(chat, seeded);
      }
      appendUser(chat, text || '(image)');
      if (text && (!chat.promptHistory.length || chat.promptHistory[0] !== text)) {
        chat.promptHistory.unshift(text);
        if (chat.promptHistory.length > 100) chat.promptHistory.pop();
      }
      chat.histIdx = -1;
      autoTitle(chat, text);
      chat.composer.value = '';
      autosize(chat.composer);
      hideSlash(chat);
      clearImages(chat);
      updateBusyUi(chat);
      ccx.invoke('chat:send', { id, text, blocks: blocks.length ? blocks : null }).then((r) => {
        if (!r || !r.ok) {
          appendError(chat, 'Not sent — ' + ((r && r.error) || 'the session is no longer running; open a new chat (Ctrl+Shift+T)'));
          setBusy(chat, false);
        }
      }).catch((e) => {
        appendError(chat, 'Not sent — ' + ((e && e.message) || e));
        setBusy(chat, false);
      });
    };
    chat.send = send;

    // ▶ continue: resume a turn the model ended early (long audits, relays)
    chat.contBtn.addEventListener('click', () => {
      if (!chat.alive) return;
      chat.composer.value = 'Continue from exactly where you stopped. Complete all remaining work before finishing — do not summarize, work.';
      autosize(chat.composer);
      send();
    });

    // prompt history: ↑ / ↓ when the composer is empty
    chat.composer.addEventListener('keydown', (e) => {
      if (chat.composer.value === '' && !chat.slash.classList.contains('hidden')) return;
      if (e.key === 'ArrowUp' && chat.composer.value === '' && chat.promptHistory.length) {
        e.preventDefault();
        chat.histIdx = Math.min(chat.histIdx + 1, chat.promptHistory.length - 1);
        chat.composer.value = chat.promptHistory[chat.histIdx];
        chat.composer.setSelectionRange(chat.composer.value.length, chat.composer.value.length);
        return;
      }
      if (e.key === 'ArrowDown' && chat.histIdx >= 0) {
        e.preventDefault();
        chat.histIdx--;
        chat.composer.value = chat.histIdx < 0 ? '' : chat.promptHistory[chat.histIdx];
        return;
      }
      // End: back to the newest response. The composer keeps focus so the
      // next message can be typed without a click.
      if (e.key === 'End' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        chat.follow = true;
        scrollDown(chat);
        updateLatestBtn(chat);
      }
    });

    // paste images straight into the chat
    chat.composer.addEventListener('paste', (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const imgItem = items.find(i => i.type.startsWith('image/'));
      if (!imgItem) return;
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        chat.pendingImages.push({ media_type: file.type || 'image/png', data: String(reader.result).split(',')[1] });
        renderImageChips(chat);
      };
      reader.readAsDataURL(file);
    });

    // @-mentions of project files
    chat.composer.addEventListener('input', async () => {
      autosize(chat.composer);
      updateBusyUi(chat);
      try { localStorage.setItem('cce:draft:' + (chat.cwd || ''), chat.composer.value); } catch { /* ignore */ }
      // maybeAt is async: un-awaited, its Promise was always truthy and the "/"
      // menu never opened.
      if (!(await maybeAt(chat))) maybeSlash(chat);
    });

    if (chat.busyModeBtn) {
      chat.busyModeBtn.addEventListener('click', () => {
        chat.busyMode = (chat.busyMode || 'steer') === 'steer' ? 'queue' : 'steer';
        updateBusyUi(chat);
      });
    }

    chat.sendBtn.addEventListener('click', () => {
      if (chat.busy) {
        const text = chat.composer.value.trim();
        if (!text && !chat.pendingImages.length) {
          ccx.invoke('chat:interrupt', { id });
          return;
        }
        send(chat.busyMode || 'queue');
      } else {
        send();
      }
    });

    // Compact in place: the engine summarizes earlier turns and the same chat
    // keeps going (no new tab, no lost context).
    if (chat.compactBtn) chat.compactBtn.addEventListener('click', () => doCompact(chat));
    wireWorkflowPicker(chat, send);
    // Attach + drag-and-drop. The native dialog reads the file in main, so the
    // renderer never has to synthesise a File-like object. #32
    chat.attachBtn.addEventListener('click', async () => {
      const r = await ccx.invoke('dialog:pickFiles');
      if (r.ok && (r.files || []).length) applyAttachedFiles(chat, r.files);
    });
    ['dragover', 'drop'].forEach(ev => chat.composer.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragover') return;
      if (e.dataTransfer && e.dataTransfer.files.length) attachFiles(chat, e.dataTransfer.files);
    }));
    chat.composer.addEventListener('keydown', (e) => {
      // IME composition: Enter/arrows belong to the composition, not the app.
      if (e.isComposing || e.keyCode === 229) return;
      if (!chat.slash.classList.contains('hidden')) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(chat, 1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(chat, -1); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && chat.slashItems.length)) {
          e.preventDefault(); (chat.atMode ? applyAt(chat) : applySlash(chat)); return;
        }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideSlash(chat); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (chat.busy) {
          const isCtrl = e.ctrlKey || e.metaKey;
          const currentMode = chat.busyMode || 'queue';
          const modeToUse = isCtrl ? (currentMode === 'queue' ? 'steer' : 'queue') : currentMode;
          send(modeToUse);
        } else {
          send();
        }
      }
    });
    chat.msgs.addEventListener('scroll', () => {}, { passive: true });

    activateChat(id);
    switchView('terminal');
    chat.composer.focus();
    if (opts.initText) {
      setTimeout(() => {
        if (!chat.alive) return;
        appendUser(chat, opts.initText);
        ccx.invoke('chat:send', { id, text: opts.initText })
          .then((r) => { if (!r || !r.ok) appendError(chat, 'Not sent — ' + ((r && r.error) || 'session not running')); })
          .catch((e) => appendError(chat, 'Not sent — ' + ((e && e.message) || e)));
      }, 1500);
    }
    // Resumed sessions: replay the stored transcript so the past conversation shows.
    const rid = res.resumedFrom || opts.resume || null;
    if (rid && rid !== 'last') loadTranscript(chat, rid);
    else if (rid === 'last') {
      ccx.invoke('chat:last', { cwd: chat.cwd }).then(lr => {
        if (lr.ok && lr.sessionId) loadTranscript(chat, lr.sessionId);
      });
    }
    return id;
  }

  async function loadTranscript(chat, sessionId) {
    const r = await ccx.invoke('chat:transcript', { cwd: chat.cwd, sessionId });
    if (!r.ok || !r.items || !r.items.length) return;
    chat.msgs.querySelector('.chat-empty')?.remove();
    const top = el('div', 'sys-note', 'previous conversation restored — ' + r.items.length + ' entries');
    chat.msgs.insertBefore(top, chat.msgs.firstChild);
    const items = r.items.slice(-150);
    for (const it of items) {
      if (it.t === 'user') appendUser(chat, it.text);
      else if (it.t === 'note') appendCommandNote(chat, it.text);
      else if (it.t === 'summary') appendSummary(chat, it.text);
      else if (it.t === 'assistant') {
        const cut = splitThink(it.text);
        if (cut.thinking) chat.msgs.appendChild(thoughtNode(cut.thinking));
        if (!cut.text) continue;
        const w = el('div', 'msg assistant-msg');
        const body = el('div', 'md');
        body.innerHTML = md(cut.text);
        w.appendChild(body);
        enhanceMarkdown(body, cut.text);
        chat.msgs.appendChild(w);
      } else if (it.t === 'thinking') {
        chat.msgs.appendChild(thoughtNode(it.text));
      } else if (it.t === 'tool') {
        const card = makeToolCard(chat, 'x' + Math.random().toString(36).slice(2), it.name, it.input || {});
        card.output = it.output || '';
        card.isError = !!it.isError;
        card.setStatus(card.isError ? 'err' : 'done');
        chat.msgs.appendChild(card.card);
      }
    }
    scrollDown(chat);
  }

  const basename = (p) => String(p || '~').replace(/\/+$/, '').split('/').pop() || p;
  const modeLabel = (m) => ({ default: 'accept edits', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto', bypassPermissions: 'yolo' }[m] || m);

  // Some models (mostly smaller ones behind a translating proxy) end a turn on
  // "Let me do X:" without ever calling the tool. The engine takes that as a
  // finished answer, so the chat just goes quiet. Spot it and nudge once.
  const NUDGE_TEXT = 'You said what you would do next but stopped without doing it. Do that step now: make the tool call, and keep going until the task is finished.';
  function announcedNextStep(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 1500 || /[?？]\s*$/.test(t) || /[?？]/.test(t.slice(-200))) return false;
    const paragraph = t.split(/\n{2,}/).pop().trim();
    if (/\b(would you like|do you want|should I|please confirm|feel free to|let me know|what do you think)\b/i.test(paragraph)) return false;
    const sentences = paragraph.split(/(?<=[.!:])\s+/);
    const last = sentences[sentences.length - 1] || paragraph;
    if (/\b(done|completed?|finished|that'?s all|hope this helps|let me know|thanks|thank you)\b/i.test(last)) return false;
    // Only a sentence that hands off to an action counts: it ends in ":" / "…",
    // or it OPENS with the intent ("Let me…", "Now I'll…"). A closing remark
    // like "I'll leave the tests as they are." used to trigger a redo.
    const intent = /\b(let me|i'll|i will|i'm going to|i am going to|now i(?:'ll| will)?|next,? i(?:'ll| will)?|going to)\b/i;
    if (/(?::|…|\.\.\.)\s*$/.test(last)) return intent.test(last);
    return /^(?:(?:ok(?:ay)?|now|next|so|alright|first|then)[,.]?\s+)*(?:let me|let's|i'll now|i will now|now i(?:'ll| will)|next,? i(?:'ll| will))\b/i.test(last);
  }
  // The agent stopped to wait for CI/merge, not because it stalled — nudging
  // would only burn a whole turn pressuring a process that cannot go faster.
  function waitingOnExternal(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const paragraph = t.split(/\n{2,}/).pop();
    return /\b(waiting|wait for|once (it|the|this)( is| goes)? green|when (it|the)( passes| is green| goes green)|poll|checking the ci|ci (status|checks?)|merge (once|when)|will merge|pipeline)\b/i.test(paragraph);
  }
  function maybeNudge(chat, msg) {
    const on = !state.settings || state.settings.autoNudge !== false;
    if (!on || !chat.alive || (chat.nudges || 0) >= 1) return false;
    // More turns already queued: the engine carries on by itself.
    if (Number(msg.queued_turn_count) > 0 || chat.pendingImages.length) return false;
    // Waiting is not stalling: live background tasks, an open approval, or a
    // result that says it will come back when CI/merge lands.
    if (chat.bgTasks.size > 0) return false;
    if ((chat.permCount || 0) > 0 || (chat.elicCount || 0) > 0) return false;
    if (waitingOnExternal(msg.result)) return false;
    if (!announcedNextStep(msg.result)) return false;
    // Never overwrite a draft the user is already typing.
    if (chat.composer.value.trim()) return false;
    chat.nudges = (chat.nudges || 0) + 1;
    console.log('[cce] auto-nudge triggered for chat:', chat.id);
    chat.msgs.appendChild(el('div', 'sys-note warn', '↻ [Auto-nudge] the model announced a next step but stopped — nudging it to continue (automatic, once)'));
    scrollDownSoft(chat);
    chat.composer.value = NUDGE_TEXT;
    autosize(chat.composer);
    chat.send();
    return true;
  }
  const fmtAge = (ms) => {
    const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  };

  function registerTab(id, meta) { if (window.__tabs) window.__tabs.set(id, meta); }

  /**
   * Publish what this tab needs from the user, so the sidebar can say "waiting
   * on you" instead of just counting tabs. A permission prompt is the case that
   * matters: the turn is blocked and only this user can unblock it.
   */
  function publishTabState(chat) {
    const meta = window.__tabs && window.__tabs.get(chat.id);
    if (!meta) return;
    const busy = !!chat.busy;
    const needsYou = !!(chat.permCount > 0) || !!(chat.elicCount > 0) || (!!chat.queued && chat.queued > 0);
    if (meta.busy === busy && meta.needsYou === needsYou) return;
    meta.busy = busy;
    meta.needsYou = needsYou;
    if (typeof window.updateNavState === 'function') window.updateNavState();
  }
  function activateChat(id) {
    const chat = chats.get(id);
    if (!chat) return;
    window.__activeChatId = id;
    if (window.__activate) window.__activate(id);
    else {
      for (const [, c] of chats) {
        c.pane.classList.toggle('active', c.id === id);
        c.tabEl.classList.toggle('active', c.id === id);
      }
    }
    if (chat.alive) chat.composer.focus();
  }

  async function closeChat(id) {
    const chat = chats.get(id);
    if (!chat) return;
    // Its header may be parked in the top bar: put it back so it goes with the pane.
    if (chat.headerEl && chat.headerEl.parentElement && chat.headerEl.parentElement.id === 'qa-chat-slot') chat.pane.prepend(chat.headerEl);
    // Stop every pending countdown, not just one shared interval. #2
    for (const card of chat.permSlot.querySelectorAll('.perm-card')) endPermCountdown(card);
    clearInterval(chat.ctxTimer);
    // Release every Monaco diff editor: each holds a full editor instance, and
    // removing the pane without disposing leaks them all. #3
    for (const d of chat.pane.querySelectorAll('.monaco-diff')) {
      try { if (d.__ed) d.__ed.dispose(); } catch { /* already disposed */ }
      d.__ed = null;
      d.__init = null;
    }
    if (chat.alive) await ccx.invoke('chat:close', { id });
    chat.pane.remove(); chat.tabEl.remove(); chats.delete(id);
    if (window.__tabs) {
      // Clear before deleting: a stale busy flag would outlive the entry in
      // any state the nav computed from it.
      const m = window.__tabs.get(id);
      if (m) { m.busy = false; m.needsYou = false; }
      window.__tabs.delete(id);
    }
    if (typeof window.updateTabCount === 'function') window.updateTabCount();
    if (window.__activateNext) window.__activateNext(id);
  }

  /* ---------------- composer extras (#32) ---------------- */

  const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
  async function cycleEffort(chat) {
    const cur = chat.effort || '';
    const next = EFFORTS[(EFFORTS.indexOf(cur) + 1) % EFFORTS.length];
    chat.effort = next;
    chat.effortBtn.textContent = 'effort: ' + (next || 'auto');
    const r = await ccx.invoke('chat:effort', { id: chat.id, effort: next });
    if (!r.ok) toast(r.error || 'effort not supported here', 'err');
    else if (next) toast('effort → ' + next, 'ok');
  }

  /** Attach a local file: images become content blocks, others become text. */
  async function attachFiles(chat, fileList) {
    for (const file of [...fileList]) {
      const type = file.type || '';
      if (type.startsWith('image/') && file.size < 4 * 1024 * 1024) {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        chat.pendingImages.push({ media_type: type || 'image/png', data });
      } else if (file.size > 400 * 1024) {
        toast(file.name + ' is too large to attach inline (' + Math.round(file.size / 1024) + ' kB)', 'err');
        continue;
      } else {
        const text = await file.text();
        chat.composer.value += (chat.composer.value ? '\n' : '') + '@' + file.name + '\n' + text.slice(0, 4000);
        autosize(chat.composer);
        continue;
      }
    }
    renderImageChips(chat);
  }

  /** Files already read by the main process: images become blocks, text inlines. */
  function applyAttachedFiles(chat, files) {
    for (const f of files) {
      if (f.base64 && f.mediaType) {
        chat.pendingImages.push({ media_type: f.mediaType, data: f.base64 });
      } else if (f.text != null) {
        chat.composer.value += (chat.composer.value ? '\n' : '') + '@' + f.name + '\n' + f.text;
      } else if (f.error) {
        toast(f.name + ': ' + f.error, 'err');
      }
    }
    renderImageChips(chat);
    autosize(chat.composer);
  }

/** Messages sent while a turn is running, shown as pending chips. #32 */
  function renderQueued(chat) {
    if (!chat.queuedEl) return;
    chat.queuedEl.innerHTML = '';
    chat.queuedEl.classList.toggle('hidden', !chat.pendingMsgs.length);
    for (let i = 0; i < chat.pendingMsgs.length; i++) {
      const item = chat.pendingMsgs[i];
      const t = typeof item === 'string' ? item : (item && item.text) || '';
      const chip = el('span', 'queued-chip');
      const label = el('span', 'queued-chip-text', t.length > 70 ? t.slice(0, 70) + '…' : t);
      const del = el('span', 'queued-chip-del', ' ×');
      del.title = 'Remove queued message';
      del.onclick = (e) => {
        e.stopPropagation();
        chat.pendingMsgs.splice(i, 1);
        try { localStorage.setItem('cce:pending:' + (chat.cwd || ''), JSON.stringify(chat.pendingMsgs)); } catch { /* ignore */ }
        renderQueued(chat);
      };
      chip.appendChild(label);
      chip.appendChild(del);
      chat.queuedEl.appendChild(chip);
    }
  }

/* ---------------- side panels (one frame for all of them) ---------------- */

  // Every ⋯ panel used to be a bare box: no title bar, no close button, and
  // two could stack on top of each other. They now share one frame — title,
  // close (✕ / Esc), and only one open at a time.
  function makePanel(chat, cls, icon, title, hint) {
    chat.pane.querySelectorAll('.chat-skills-panel').forEach(p => p.remove());
    const panel = el('div', 'chat-skills-panel ' + cls);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', title);
    const head = el('div', 'panel-head-row');
    head.appendChild(elIcon('h4', '', (CCEIcons.svg(icon, 15) || '') + ' ' + esc(title)));
    const x = elIcon('button', 'panel-close', CCEIcons.svg('close', 14));
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close ' + title);
    x.addEventListener('click', () => panel.remove());
    head.appendChild(x);
    panel.appendChild(head);
    if (hint) panel.appendChild(el('p', 'hint', hint));
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); panel.remove(); chat.composer.focus(); }
    });
    return panel;
  }
  const panelOpen = (chat, cls) => {
    const p = chat.pane.querySelector('.' + cls);
    if (p) { p.remove(); return true; }
    return false;
  };

/* ---------------- header overflow menu (#33) ---------------- */

  function wireHeaderMenu(chat, forkConversation) {
    let menu = null;
    const away = (e) => { if (menu && !menu.contains(e.target) && !chat.moreBtn.contains(e.target)) close(); };
    const close = () => {
      if (!menu) return;
      menu.remove(); menu = null;
      chat.moreBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', away, true);
    };
    // `icon` is a name from the shared SVG set, not a glyph: it inherits
    // currentColor and is hidden from assistive tech. #54
    const item = (icon, label, run, { kbd, on } = {}) => {
      const b = el('button', 'chat-menu-item');
      b.setAttribute('role', 'menuitem');
      b.appendChild(elIcon('span', 'chat-menu-ico', CCEIcons.svg(icon, 15)));
      b.appendChild(el('span', 'cmi-label', label));
      if (on) b.appendChild(el('span', 'cmi-on', 'on'));
      if (kbd) b.appendChild(el('kbd', 'cmi-kbd', kbd));
      b.addEventListener('click', () => { close(); run(); });
      return b;
    };
    const section = (name) => menu.appendChild(el('div', 'chat-menu-sec', name));
    chat.moreBtn.setAttribute('aria-haspopup', 'menu');
    chat.moreBtn.addEventListener('click', () => {
      if (menu) return close();
      menu = el('div', 'chat-menu');
      menu.setAttribute('role', 'menu');
      const head = el('div', 'chat-menu-head');
      head.appendChild(el('span', '', 'Chat actions'));
      const x = elIcon('button', 'panel-close', CCEIcons.svg('close', 13));
      x.setAttribute('aria-label', 'Close menu');
      x.title = 'Close (Esc)';
      x.addEventListener('click', close);
      head.appendChild(x);
      menu.appendChild(head);

      section('This conversation');
      menu.appendChild(item('compress', 'Compact in place', () => doCompact(chat), { kbd: '/compact' }));
      menu.appendChild(item('search', 'Find in conversation', () => showFind(chat), { kbd: 'Ctrl+F' }));
      menu.appendChild(item('fork', 'Fork this conversation', forkConversation));
      menu.appendChild(item('undo', 'Rewind files', () => toggleRewindPanel(chat)));
      menu.appendChild(item('download', 'Export as markdown', async () => {
        if (!chat.sessionId) { toast('Nothing to export yet', 'err'); return; }
        const r = await ccx.invoke('chat:export', { cwd: chat.cwd, sessionId: chat.sessionId });
        if (r && r.ok && r.saved) toast('Saved ' + r.path, 'ok'); else if (r && !r.ok) toast(r.error, 'err');
      }));
      menu.appendChild(item('clock', 'Past conversations', () => toggleHistoryPanel(chat)));

      section('Tools & context');
      menu.appendChild(item('bolt', 'Skills, commands, agents, hooks', () => toggleSkillsPanel(chat)));
      menu.appendChild(item('plug2', 'MCP servers (live)', () => toggleMcpPanel(chat)));
      menu.appendChild(item('brain', 'Memory & rules', () => toggleMemoryPanel(chat)));
      menu.appendChild(item('list', 'Command palette', () => openPalette(chat), { kbd: 'Ctrl+K' }));

      section('Workspace');
      const splitOn = !!document.querySelector('#main.split');
      menu.appendChild(item('split', 'Side panel (overview, files, terminal)', () => window.toggleSplit && window.toggleSplit(), { kbd: 'Alt+V', on: splitOn }));
      menu.appendChild(item('keyboard', 'Terminal tab in this folder', () => window.createSession({ cwd: chat.cwd, type: 'shell' })));
      menu.appendChild(item('play', 'Run build / test scripts', () => chat.runBtn.click()));
      if (chat.provider && chat.provider.baseUrl) {
        menu.appendChild(item('gear', 'Model manager (load / unload)',
          () => (window.ProvidersUI ? ProvidersUI.openLocalManager(chat.provider.baseUrl) : (window.openOllamaManager && window.openOllamaManager(chat.provider)))));
      }
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('.chat-menu-item')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); chat.moreBtn.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      });
      const rect = chat.moreBtn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = (rect.bottom + 6) + 'px';
      menu.style.right = Math.max(8, (window.innerWidth || 1200) - rect.right) + 'px';
      document.body.appendChild(menu);
      chat.moreBtn.setAttribute('aria-expanded', 'true');
      setTimeout(() => document.addEventListener('mousedown', away, true), 0);
      const first = menu.querySelector('.chat-menu-item');
      if (first) first.focus();
    });
  }

  /* ---------------- model selector ---------------- */

  function fillModelSelector(chat) {
    const sel = chat.modelSel;
    sel.innerHTML = '';
    const add = (value, label) => { const o = el('option', '', label); o.value = value; sel.appendChild(o); };
    const p = chat.provider;
    // Provider switcher: every saved provider is a choice in the same dropdown;
    // picking one recreates the session on that provider. #feat-provider-toggle
    const provs = (state && state.providers && state.providers.instances) || [];
    if (provs.length > 1) {
      const pg = document.createElement('optgroup');
      pg.label = 'switch provider';
      for (const pr of provs) {
        const cur = p && pr.uid === p.uid;
        const o = el('option', '', (cur ? '✓ ' : '') + (pr.name || pr.uid));
        o.value = '__prov:' + pr.uid;
        pg.appendChild(o);
      }
      sel.appendChild(pg);
    }
    // A third-party provider does not serve Claude model names. Offering
    // Opus/Sonnet/Haiku there sent a name it lacks; the proxy then substituted
    // another model, so the pick looked ignored. List the provider's own models.
    const thirdParty = !!(p && p.baseUrl && !/(^|\.)anthropic\.com/i.test(String(p.baseUrl)));
    if (thirdParty) {
      const own = [...new Set([p.model, ...(p.whitelist && p.whitelist.length ? p.whitelist : (p.models || [])), chat.model]
        .filter(Boolean))];
      add('', p.model ? 'provider default · ' + p.model : 'provider default (none set)');
      own.forEach(m => add(m, m));
      add('__custom', 'Custom…');
      if (chat.model && own.includes(chat.model)) sel.value = chat.model;
      return;
    }
    add('', 'provider default');
    if (p && p.model) add(p.model, p.model + ' (' + basename(p.name) + ')');
    add('opus', 'Opus');
    add('sonnet', 'Sonnet');
    add('haiku', 'Haiku');
    add('__custom', 'Custom…');
    // Ask the engine what it actually supports; append anything we missed. The
    // hard-coded aliases above stay as a fallback before the first turn. #39
    ccx.invoke('chat:supported-models', { id: chat.id }).then((r) => {
      if (!r || !r.ok || !r.models || !r.models.length) return;
      const have = new Set([...sel.options].map(o => o.value));
      const group = document.createElement('optgroup');
      group.label = 'from the claude engine';
      let n = 0;
      for (const m of r.models) {
        const id2 = m.value || m.id || m.name;
        if (!id2 || have.has(id2)) continue;
        const o = el('option', '', m.displayName || m.label || id2 + (m.contextWindow ? ' · ' + (m.contextWindow >= 1000000 ? Math.round(m.contextWindow / 1000000) + 'M' : Math.round(m.contextWindow / 1000) + 'K') : ''));
        o.value = id2;
        group.appendChild(o);
        n++;
      }
      if (n) sel.insertBefore(group, sel.querySelector('[value="__custom"]'));
    }).catch(() => {});
  }

  // Switch model: pre-warm it on the provider first (a local Ollama model must
  // load into memory, which otherwise exceeds the CLI's confirm timeout).
  async function switchModel(chat, model) {
    model = String(model || '').split(',')[0].trim();
    const prev = chat.model;
    try {
      if (model && chat.provider && chat.provider.baseUrl) {
        toast('loading ' + model + ' into memory…');
      }
      const r = await ccx.invoke('chat:set-model', { id: chat.id, model });
      if (r.ok) {
        chat.model = r.model || model;
        if (r.model && r.model !== model) toast('model name corrected → ' + r.model);
        setStatusLine(chat);
        toast('Model → ' + (chat.model || 'provider default'), 'ok');
      } else {
        const e = String(r.error || '');
        if (r.blocked) toast(e, 'err');
        else if (/Free usage limit|not in the Free plan/i.test(e)) toast('Ollama Cloud quota/plan limit — wait for the window to reset or upgrade at ollama.com/upgrade', 'err');
        else toast(e, 'err');
        chat.modelSel.value = prev || '';
      }
    } catch (e) {
      toast(String(e.message || e), 'err');
      chat.modelSel.value = prev || '';
    }
  }

  // Switch this chat to another saved provider. The main process recreates the
  // engine session on the target provider and resumes the conversation, which
  // means a NEW chat id — this tab re-keys itself onto it so nothing else in
  // the app (tab registry, statusbar, event routing) notices. #feat-provider-toggle
  async function switchProvider(chat, uid) {
    if (chat.provider && chat.provider.uid === uid) { fillModelSelector(chat); return; }
    const name = ((state.providers.instances || []).find(p => p.uid === uid) || {}).name || uid;
    toast('switching provider → ' + name + '…');
    let r = null;
    try { r = await ccx.invoke('chat:set-provider', { id: chat.id, uid }); }
    catch (e) { r = { ok: false, error: String(e.message || e) }; }
    if (!r || !r.ok) {
      toast((r && r.error) || 'provider switch failed', 'err');
      fillModelSelector(chat);
      return;
    }
    // Re-key: the old engine session is gone; this pane now IS the new chat.
    const oldId = chat.id;
    chats.delete(oldId);
    chat.id = r.id;
    chats.set(r.id, chat);
    if (window.rekeyTab) window.rekeyTab(oldId, r.id);
    chat.provider = r.provider;
    chat.model = r.model || '';
    chat.stylesFilled = false;   // new engine, new style list
    chat.mode = uiMode(r.permissionMode || chat.mode, chat.provider);
    // The old session's exit event can land during the swap and mark the tab
    // dead — the chat is alive again on the new engine.
    chat.alive = true;
    chat.tabEl.classList.remove('dead');
    chat.providerEl.textContent = basename(chat.provider.name);
    const mgr = chat.headerEl.querySelector('.chat-mgr-btn');
    if (mgr) mgr.classList.toggle('hidden', !(chat.provider && chat.provider.baseUrl));
    fillModelSelector(chat);
    fillModeSelect(chat.modeSel, chat.provider);
    chat.modeSel.value = chat.mode;
    chat.modelSel.value = [...chat.modelSel.options].some(o => o.value === chat.model) ? chat.model : '';
    setStatusLine(chat);
    discoverModels(chat);
    toast('Provider → ' + chat.provider.name, 'ok');
  }

  // Ask the provider what models it actually serves (OpenCode-style discovery)
  // and add them as a group — covers Ollama, LM Studio, llama.cpp, LiteLLM…
  const TOOL_TIER = {
    'gpt-oss:120b-cloud': '★★★ top free tool-caller · 131K ctx ✓',
    'kimi-k3:cloud': '★★★ best overall (Pro) · 1M ctx',
    'nemotron-3-ultra:cloud': '★★☆ deep (slow) · 128K ✓',
    'nemotron-3-super:cloud': '★★☆ daily driver · 128K ✓',
    'YuriiFominYoung/opus-4.8:latest': '★★☆ (= nemotron super)',
    'glm-5.3:cloud': '★★★ (Pro) · 1M',
    'kimi-k2.7-code:cloud': '★★★ coding (Pro)',
    'gemma4:31b-cloud': '★☆☆ fast general · 128K ✓',
    'gpt-oss:20b-cloud': '★☆☆ light tasks · 131K ✓',
    'nemotron-3-nano:30b-cloud': '★☆☆ background · 64K ⚠',
    'FableForge-AI/mythos-v2-8b:q4_k_m': '★★★ local tool-caller · ⚠ ctx too small for claude chat',
    'qwen3-4b-64k:latest': '★☆☆ · ⚠ 64K ctx < claude prompt',
    'granite4.1:8b': '★☆☆ · load 131K ctx via ⚙ for claude chat',
    'granite4.1:3b': '★☆☆ · ⚠ small ctx',
  };
  const CCE_CTX_FLOOR = 70000; // claude engine base prompt — smaller ctx cannot serve chats
  // Model reliability: how often a model produced a usable tool call on this
  // machine. Surfaced in the picker so a weak model is visible, not a mystery. #43
  function toolReliability(model) {
    const s = readStats();
    const n = s.models && s.models[model];
    if (!n || !n.calls) return null;
    return Math.round((n.ok / n.calls) * 100);
  }
  function readStats() {
    try { return JSON.parse(localStorage.getItem('cce.toolstats') || '{}'); }
    catch { return {}; }
  }
  function noteToolOutcome(model, ok) {
    if (!model) return;
    try {
      const s = readStats();
      s.models = s.models || {};
      const e = s.models[model] || { calls: 0, ok: 0 };
      e.calls++;
      if (ok) e.ok++;
      s.models[model] = e;
      localStorage.setItem('cce.toolstats', JSON.stringify(s));
    } catch { /* private mode */ }
  }
  async function discoverModels(chat) {
    if (!chat.provider || !chat.provider.baseUrl) return;
    const r = await ccx.invoke('provider:listModels', { uid: chat.provider.uid });
    if (!r.ok || !r.models || !r.models.length) return;
    let list = r.models.map(m => typeof m === 'string' ? { id: m, ctx: null } : m);
    // Enrich with models.dev metadata so cloud models without a context_length
    // (OpenAI, Anthropic-protocol relays) get a ctx for the floor filter and a
    // cost/tool-calling hint. #43
    const mdId = chat.provider.modelsDevId || chat.provider.presetId;
    if (mdId && list.some(m => m.ctx == null)) {
      try {
        const cm = await ccx.invoke('catalog:models', { providerId: mdId });
        const byId = new Map((cm.models || []).map(m => [m.id, m]));
        list = list.map((m) => {
          const meta = byId.get(m.id);
          if (!meta) return m;
          return { ...m, ctx: m.ctx != null ? m.ctx : ((meta.limit && meta.limit.context) || null), cost: meta.cost, tool_call: meta.tool_call };
        });
      } catch { /* metadata is optional */ }
    }
    const curated = (r.curated && r.curated.length) ? new Set(r.curated) : null;
    if (curated) list = list.filter(m => curated.has(m.id));   // user-curated selection wins
    // hide models that cannot host the claude prompt (context below the floor)
    const viable = list.filter(m => m.ctx === null || m.ctx >= CCE_CTX_FLOOR);
    const hidden = list.length - viable.length;
    // dedupe against existing options
    const existing = new Set([...chat.modelSel.options].map(o => o.value));
    const fresh = viable.filter(m => !existing.has(m.id));
    if (!fresh.length && !hidden) return;
    const group = document.createElement('optgroup');
    group.label = (curated ? 'your selected models (' + fresh.length + ')' : 'models for claude chat (' + fresh.length + ')')
      + (hidden ? ' — ' + hidden + ' hidden: context too small' : '');
    for (const m of fresh) {
      const o = el('option', '', m.id + (TOOL_TIER[m.id] ? '  ·  ' + TOOL_TIER[m.id] : ''));
      o.value = m.id;
      const rel = toolReliability(m.id);
      if (rel !== null) o.textContent += (TOOL_TIER[m.id] ? ' · ' : '  ·  ') + 'tools ' + rel + '%';
      group.appendChild(o);
    }
    if (fresh.length) chat.modelSel.insertBefore(group, chat.modelSel.querySelector('[value="__custom"]'));
    if (window.__CCE_SMOKE) console.log('[models-discovered]', fresh.length, 'hidden:', hidden);
  }

  function openCustomModel(chat) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', '', 'Custom model id'));
    const label = el('label', 'fld');
    label.appendChild(el('span', '', 'Model id sent to the provider (e.g. glm-4.6, kimi-for-coding, qwen3-coder:30b)'));
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'leave empty for provider default';
    label.appendChild(inp);
    modal.appendChild(label);
    const actions = el('div', 'actions');
    const cancel = el('button', 'btn', 'Cancel');
    cancel.addEventListener('click', () => { overlay.remove(); chat.modelSel.value = chat.model || ''; });
    const ok = el('button', 'btn primary', 'Use model');
    ok.addEventListener('click', async () => {
      const model = inp.value.trim();
      overlay.remove();
      await switchModel(chat, model);
      if (model && ![...chat.modelSel.options].some(o => o.value === model)) {
        const o = el('option', '', model);
        o.value = model;
        chat.modelSel.insertBefore(o, chat.modelSel.querySelector('[value="__custom"]'));
      }
      chat.modelSel.value = model;
    });
    actions.appendChild(cancel); actions.appendChild(ok);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    $('#modal-root').appendChild(overlay);
    inp.focus();
  }

  /* ---------------- project / github chips ---------------- */

  async function renderProjectInfo(chat) {
    try {
      const r = await ccx.invoke('git:info', { cwd: chat.cwd });
      if (!r.ok || !chat.projEl) return;
      chat.projEl.innerHTML = '';
      const folder = elIcon('span', 'proj-chip', CCEIcons.svg('folder', 13) + ' ' + esc(basename(chat.cwd)));
      folder.title = chat.cwd + (r.remote ? '\nremote: ' + r.remote : '') + (r.branch ? '\nbranch: ' + r.branch : '');
      chat.projEl.appendChild(folder);
      if (r.repo) {
        const repo = el('span', 'proj-chip repo', '⎇ ' + r.repo);
        repo.title = 'Open github.com/' + r.repo;
        repo.addEventListener('click', () => ccx.invoke('shell:openExternal', { url: 'https://github.com/' + r.repo }));
        chat.projEl.appendChild(repo);
      }
      if (r.branch) chat.projEl.appendChild(el('span', 'proj-chip branch', r.branch));
      if (r.dirty) {
        const d = el('span', 'proj-chip dirty', '● ' + r.dirty + ' changed');
        d.title = r.dirty + ' uncommitted file(s) in this working tree';
        chat.projEl.appendChild(d);
      }
    } catch { /* git absent or not a repo — chips stay minimal */ }
  }

  /* ---------------- memory & rules editor ---------------- */

  /* ---------------- auto-memory proposals (opt-in) ---------------- */

  // Once per chat, after a few finished turns: ask the same model for lasting
  // facts. They only wait for review; nothing reaches MEMORY.md unapproved.
  async function maybeProbeMemory(chat) {
    if (!chat.alive || chat.busy || chat.memProbed || chat.compacting || chat.memProbe) return;
    const s = await ccx.invoke('settings:get');
    if (!s || !s.ok || !s.settings || !s.settings.autoMemory) return;
    const p = await ccx.invoke('memory:probe-prompt');
    if (!p || !p.ok) return;
    chat.memProbed = true;
    chat.memProbe = true;
    console.log('[cce] auto-memory probe started for chat:', chat.id);
    chat.msgs.appendChild(el('div', 'sys-note', '[Auto-memory probe] checking this chat for lasting notes (auto memory is on)…'));
    scrollDownSoft(chat);
    const r = await ccx.invoke('chat:send', { id: chat.id, text: p.prompt });
    if (!r || !r.ok) chat.memProbe = false;
  }

  async function collectMemoryProbe(chat, msg) {
    const text = msg.subtype === 'success' ? String(msg.result || '') : '';
    const r = text ? await ccx.invoke('memory:propose', { cwd: chat.cwd, text }) : null;
    const n = r && r.ok ? r.queued : 0;
    chat.msgs.appendChild(el('div', 'sys-note', n
      ? 'memory: ' + n + ' note' + (n > 1 ? 's' : '') + ' to review: open memory & rules, then accept or reject each'
      : 'memory: nothing new worth remembering'));
    scrollDownSoft(chat);
    showPendingChip(chat);
  }

  /** A chip on the project bar while notes wait for review; click opens the Memory panel. */
  async function showPendingChip(chat) {
    const r = await ccx.invoke('memory:pending', { cwd: chat.cwd });
    chat.projEl.querySelector('.mem-pending-chip')?.remove();
    const n = r && r.ok ? (r.pending || []).length : 0;
    if (!n) return;
    const chip = elIcon('button', 'proj-chip mem-pending-chip', CCEIcons.svg('brain', 13) + ' ' + n + ' memory note' + (n > 1 ? 's' : '') + ' to review');
    chip.addEventListener('click', () => toggleMemoryPanel(chat));
    chat.projEl.appendChild(chip);
  }

  async function toggleMemoryPanel(chat) {
    if (panelOpen(chat, 'chat-memory-panel')) return;
    const panel = makePanel(chat, 'chat-memory-panel', 'brain', 'Memory & rules',
      'What the engine loads at session start: CLAUDE.md memory, .claude/rules/*.md, and settings.json hooks. Hooks apply to sessions started after saving.');
    const pick = el('select', 'skills-search');
    const editor = el('textarea', 'mem-editor');
    editor.spellcheck = false;
    const status = el('div', 'hint', '');
    const r = await ccx.invoke('memory:files', { cwd: chat.cwd });
    const files = (r.ok && r.files) || [];
    if (!files.length) status.textContent = 'No memory or rule files yet for this project.';
    files.forEach((f, i) => {
      const o = el('option', '', f.label + ' — ' + basename(pathDirname(f.path)));
      o.value = String(i);
      pick.appendChild(o);
    });
    const show = () => {
      const f = files[Number(pick.value) || 0];
      editor.value = f ? f.content : '';
      status.textContent = f ? f.path : '';
    };
    pick.addEventListener('change', show);
    const row = el('div', 'perm-actions');
    const save = el('button', 'btn small primary', 'Save');
    save.addEventListener('click', async () => {
      const f = files[Number(pick.value) || 0];
      if (!f) return;
      const rr = await ccx.invoke('memory:save', { path: f.path, content: editor.value });
      if (!rr.ok) { status.textContent = 'save failed: ' + rr.error; return; }
      f.content = editor.value;
      status.textContent = 'saved ' + rr.bytes + ' bytes — ' + f.path;
      toast('Saved ' + f.label, 'ok');
    });
    row.appendChild(save);
    // Auto memory: opt-in switch, and the notes the model proposed, awaiting a yes or no.
    const toggle = el('label', 'mem-auto');
    const cb = el('input');
    cb.type = 'checkbox';
    ccx.invoke('settings:get').then((st) => { cb.checked = !!(st && st.settings && st.settings.autoMemory); });
    cb.addEventListener('change', () => ccx.invoke('settings:set', { settings: { autoMemory: cb.checked } }));
    toggle.appendChild(cb);
    toggle.appendChild(el('span', '', ' Propose lasting notes from my chats (same model; I approve each one)'));
    panel.appendChild(toggle);
    const proposals = el('div', 'mem-proposals');
    panel.appendChild(proposals);
    const loadProposals = async () => {
      const pr = await ccx.invoke('memory:pending', { cwd: chat.cwd });
      proposals.innerHTML = '';
      for (const p of ((pr && pr.pending) || [])) {
        const card = el('div', 'mem-proposal');
        card.appendChild(el('div', 'mem-proposal-head', p.type + ' · ' + p.slug));
        card.appendChild(el('div', 'hint', p.description));
        card.appendChild(el('pre', 'mem-proposal-body', p.body));
        const act = el('div', 'perm-actions');
        for (const [label, accept, cls] of [['Accept', true, 'btn small primary'], ['Reject', false, 'btn small']]) {
          const b = el('button', cls, label);
          b.addEventListener('click', async () => {
            b.disabled = true;
            const rr = await ccx.invoke('memory:resolve', { cwd: chat.cwd, slug: p.slug, accept });
            if (rr && rr.ok && rr.saved) toast('Saved to memory: ' + p.slug, 'ok');
            await loadProposals();
            showPendingChip(chat);
          });
          act.appendChild(b);
        }
        card.appendChild(act);
        proposals.appendChild(card);
      }
    };
    loadProposals();
    panel.appendChild(pick);
    panel.appendChild(editor);
    panel.appendChild(row);
    panel.appendChild(status);
    chat.pane.appendChild(panel);
    if (files.length) show();
    editor.focus();
  }

  const pathDirname = (p) => String(p).replace(/\/[^/]+$/, '');

  /* ---------------- command palette (Ctrl/Cmd+K) ---------------- */

  function openPalette(chat) {
    const old = document.querySelector('.palette-back');
    if (old) { old.remove(); return; }
    const back = el('div', 'palette-back');
    const box = el('div', 'palette');
    const input = el('input');
    input.placeholder = 'Jump to a session, model, command, or panel…';
    const list = el('div', 'palette-list');
    box.appendChild(input);
    box.appendChild(list);
    back.appendChild(box);

    const items = [];
    const add = (kind, label, sub, run) => items.push({ kind, label, sub: sub || '', run });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };

    for (const [label, view] of [['Sessions', 'terminal'], ['History', 'chats'], ['Providers', 'providers'],
      ['Connectors', 'connectors'], ['Settings', 'settings']]) {
      add('view', label, '', () => { close(); switchView(view); });
    }
    add('panel', 'Skills, agents, hooks, tools', '', () => { close(); toggleSkillsPanel(chat); });
    add('panel', 'MCP servers (live)', '', () => { close(); toggleMcpPanel(chat); });
    add('panel', 'past conversations', '', () => { close(); toggleHistoryPanel(chat); });
    add('panel', '⏪ rewind files', '', () => { close(); toggleRewindPanel(chat); });
    add('panel', 'memory & rules', '', () => { close(); toggleMemoryPanel(chat); });
    add('chat', '⑂ fork this conversation', '', () => { close(); chat.forkBtn.click(); });
    add('chat', '⌨ terminal tab in this folder', '', () => { close(); window.createSession({ cwd: chat.cwd, type: 'shell' }); });
    add('chat', 'summarize session into a handoff brief', '', () => { close(); prefilledSummary(chat); });
    add('chat', '■ stop / interrupt', '', () => { close(); chat.stopBtn.click(); });

    for (const o of chat.modelSel.options) {
      if (!o.value || o.value === '__custom') continue;
      add('model', o.textContent, '', () => {
        close();
        chat.modelSel.value = o.value;
        chat.modelSel.dispatchEvent(new Event('change'));
      });
    }
    for (const c of (chat.commandDetails || chat.commands || []).slice(0, 120)) {
      const name = typeof c === 'string' ? c : c.name;
      const desc = typeof c === 'string' ? '' : (c.description || '');
      add('command', '/' + name, desc, () => {
        close();
        chat.composer.value = '/' + name + ' ';
        chat.composer.focus();
      });
    }

    let sel = 0;
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const shown = items.filter(i => !q || i.label.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q)).slice(0, 60);
      list.innerHTML = '';
      if (sel >= shown.length) sel = 0;
      shown.forEach((i, idx) => {
        const row = el('div', 'palette-item' + (idx === sel ? ' sel' : ''));
        row.appendChild(el('span', 'pi-kind', i.kind));
        row.appendChild(el('span', '', i.label));
        if (i.sub) row.appendChild(el('span', 'pi-sub', String(i.sub).slice(0, 60)));
        row.addEventListener('mouseenter', () => { sel = idx; [...list.children].forEach((c, j) => c.classList.toggle('sel', j === sel)); });
        row.addEventListener('click', i.run);
        list.appendChild(row);
      });
      if (!shown.length) list.appendChild(el('div', 'palette-item', 'no match'));
      return shown;
    };
    const shownNow = () => items.filter(i => {
      const q = input.value.trim().toLowerCase();
      return !q || i.label.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q);
    }).slice(0, 60);

    function onKey(e) {
      if (!back.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shownNow().length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const i = shownNow()[sel];
        if (i) i.run();
      }
    }
    input.addEventListener('input', () => { sel = 0; render(); });
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
    render();
    document.body.appendChild(back);
    input.focus();

    // async: all stored sessions, searchable by preview text
    ccx.invoke('chats:index').then((r) => {
      if (!r.ok) return;
      for (const s of (r.sessions || []).slice(0, 120)) {
        add('session', s.preview || '(empty session)', basename(s.cwd || s.folder) + ' · ' + fmtAge(s.mtime), () => {
          close();
          createSession({ cwd: s.cwd || s.folder, resume: s.sessionId });
        });
      }
      render();
    }).catch(() => {});
  }

  function prefilledSummary(chat) {
    chat.composer.value = 'Summarize what we did in this session into a compact handoff brief: goals, decisions made, files touched (with paths), open TODOs, and the exact next step. Keep it under 30 lines.';
    chat.composer.focus();
    autosize(chat.composer);
  }

  /* ---------------- skills panel ---------------- */

  async function toggleSkillsPanel(chat) {
    if (panelOpen(chat, 'chat-skills-main')) return;
    const panel = makePanel(chat, 'chat-skills-main', 'bolt', 'Skills, commands, agents & hooks',
      'Type / in the composer to run a command; skills auto-trigger when a task matches. Click a row to use it.');
    // Jump links: the panel is long, so each section is one click away.
    const jump = el('div', 'panel-tabs');
    panel.appendChild(jump);

    const search = el('input', 'skills-search');
    search.type = 'text';
    search.placeholder = 'Filter by name or description…';
    panel.appendChild(search);

    const body = el('div', 'skills-body');
    panel.appendChild(body);

    // Live command list from the session (includes plugin + project commands).
    if (!chat.commandDetails) {
      const r = await ccx.invoke('chat:commands', { id: chat.id });
      chat.commandDetails = r.ok ? (r.commands || []) : [];
    }
    const detail = chat.skillsDetail.length ? chat.skillsDetail : await (async () => {
      const r = await ccx.invoke('chat:skills', { cwd: chat.cwd });
      chat.skillsDetail = r.ok ? r.skills : [];
      return chat.skillsDetail;
    })();
    if (!chat.agentsList) {
      const ar = await ccx.invoke('chat:agents', { id: chat.id });
      chat.agentsList = ar.ok ? (ar.agents || []) : [];
    }
    if (!chat.toolsList) {
      const tr = await ccx.invoke('tools:check');
      chat.toolsList = tr.ok ? (tr.tools || []) : [];
    }

    const render = () => {
      const q = search.value.trim().toLowerCase();
      const match = (s) => !q || (s.name || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
      body.innerHTML = '';

      const cmds = chat.commandDetails.filter(match);
      const sec1 = el('div', 'skills-section');
      sec1.appendChild(el('h5', '', `Commands (${cmds.length})`));
      const clist = el('div', 'skills-list');
      for (const c of cmds.slice(0, 80)) {
        const row = el('div', 'skill-row');
        const code = el('code', '', '/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : ''));
        row.appendChild(code);
        if (c.description) row.appendChild(el('span', 'skill-desc', c.description));
        if (c.builtin) row.appendChild(el('span', 'chip', 'built-in'));
        row.addEventListener('click', () => {
          chat.composer.value = '/' + c.name + ' ';
          chat.composer.focus();
          panel.remove();
        });
        clist.appendChild(row);
      }
      if (cmds.length > 80) clist.appendChild(el('div', 'hint', `…and ${cmds.length - 80} more — type to filter`));
      sec1.appendChild(clist);
      body.appendChild(sec1);

      const skills = detail.filter(match).concat(
        (chat.init ? (chat.init.skills || []) : [])
          .filter(n => match({ name: n }))
          .map(n => ({ name: n, description: '', source: 'session' }))
      );
      const seen = new Set();
      const uniq = skills.filter(s => !seen.has(s.name) && seen.add(s.name));
      const sec2 = el('div', 'skills-section');
      sec2.appendChild(el('h5', '', `Skills (${uniq.length})`));
      const slist = el('div', 'skills-list');
      for (const s of uniq.slice(0, 80)) {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', s.name));
        if (s.description) row.appendChild(el('span', 'skill-desc', s.description));
        if (s.source) row.appendChild(el('span', 'chip', s.source));
        const use = el('button', 'btn small', 'use');
        use.title = 'Ask Claude to use this skill';
        use.addEventListener('click', (e) => {
          e.stopPropagation();
          chat.composer.value = 'Use the ' + s.name + ' skill: ';
          chat.composer.focus();
          panel.remove();
        });
        row.appendChild(use);
        const on = s.enabled !== false;
        const tog = el('button', 'switch' + (on ? ' on' : ''));
        tog.setAttribute('role', 'switch');
        tog.setAttribute('aria-checked', on ? 'true' : 'false');
        tog.title = (on ? 'Disable' : 'Enable') + ' ' + s.name;
        tog.textContent = on ? 'disable' : 'enable';
        tog.addEventListener('click', async (e) => {
          e.stopPropagation();
          tog.disabled = true;
          const next = tog.textContent === 'enable';
          await ccx.invoke('skills:toggle', { name: s.name, enabled: next });
          s.enabled = next;
          tog.classList.toggle('on', next);
          tog.textContent = next ? 'disable' : 'enable';
          tog.setAttribute('aria-checked', next ? 'true' : 'false');
          tog.disabled = false;
        });
        row.appendChild(tog);
        slist.appendChild(row);
      }
      if (uniq.length > 80) slist.appendChild(el('div', 'hint', `…and ${uniq.length - 80} more — type to filter`));
      sec2.appendChild(slist);
      body.appendChild(sec2);

      // Subagents registered for this session (`.claude/agents` + built-ins).
      const agents = (chat.agentsList || []).filter(a => match({ name: a.name, description: a.description }));
      if (agents.length) {
        const sec3 = el('div', 'skills-section');
        sec3.appendChild(el('h5', '', `Agents (${agents.length})`));
        const alist = el('div', 'skills-list');
        for (const a of agents) {
          const row = el('div', 'skill-row');
          row.appendChild(el('code', '', a.name));
          if (a.description) row.appendChild(el('span', 'skill-desc', a.description));
          if (a.model) row.appendChild(el('span', 'chip', a.model));
          const use = el('button', 'btn small', 'use');
          use.title = 'Ask Claude to delegate to this agent';
          use.addEventListener('click', (e) => {
            e.stopPropagation();
            chat.composer.value = 'Use the ' + a.name + ' agent to: ';
            chat.composer.focus();
            panel.remove();
          });
          row.appendChild(use);
          const on = a.enabled !== false;
          const tog = el('button', 'switch' + (on ? ' on' : ''));
          tog.setAttribute('role', 'switch');
          tog.setAttribute('aria-checked', on ? 'true' : 'false');
          tog.title = (on ? 'Disable' : 'Enable') + ' ' + a.name;
          tog.textContent = on ? 'disable' : 'enable';
          tog.addEventListener('click', async (e) => {
            e.stopPropagation();
            tog.disabled = true;
            const next = tog.textContent === 'enable';
            await ccx.invoke('agents:toggle', { name: a.name, enabled: next });
            a.enabled = next;
            tog.classList.toggle('on', next);
            tog.textContent = next ? 'disable' : 'enable';
            tog.setAttribute('aria-checked', next ? 'true' : 'false');
            tog.disabled = false;
          });
          row.appendChild(tog);
          alist.appendChild(row);
        }
        sec3.appendChild(alist);
        body.appendChild(sec3);
      }

      // Live hook audit trail (PreToolUse / PostToolUse / … fired this session).
      const sec4 = el('div', 'skills-section');
      sec4.appendChild(el('h5', '', 'Hooks'));
      const hlist = el('div', 'skills-list');
      hlist.appendChild(el('div', 'hint', 'none yet'));
      sec4.appendChild(hlist);
      body.appendChild(sec4);
      chat.hooksHost = sec4;
      chat.hooksHost.__list = hlist;
      renderHooks(chat);

      // Runtime tools some skills shell out to (bun, uv, rg…)
      const sec5 = el('div', 'skills-section');
      sec5.appendChild(el('h5', '', 'Runtime tools'));
      const tlist = el('div', 'skills-list');
      for (const t of (chat.toolsList || [])) {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', t.name));
        row.appendChild(el('span', 'skill-desc', t.found ? t.path : 'not installed'));
        if (!t.found && INSTALL_CMD[t.name]) {
          const b = el('button', 'btn small', 'install');
          b.title = 'Opens a terminal tab running: ' + INSTALL_CMD[t.name];
          b.addEventListener('click', () => {
            panel.remove();
            window.createSession({ cwd: chat.cwd, type: 'shell', initText: INSTALL_CMD[t.name] + '\r' });
          });
          row.appendChild(b);
        }
        tlist.appendChild(row);
      }
      sec5.appendChild(tlist);
      body.appendChild(sec5);

      jump.innerHTML = '';
      for (const h of body.querySelectorAll('.skills-section h5')) {
        const b = el('button', 'panel-tab', h.textContent);
        b.addEventListener('click', () => h.scrollIntoView({ block: 'start', behavior: 'smooth' }));
        jump.appendChild(b);
      }
    };
    search.addEventListener('input', render);
    render();

    // Memory & rules editor (CLAUDE.md, .claude/rules, settings hooks)
    const memBtn = elIcon('button', 'btn small', CCEIcons.svg('brain', 14) + ' edit memory & rules');
    memBtn.addEventListener('click', () => { panel.remove(); toggleMemoryPanel(chat); });
    panel.appendChild(memBtn);

    // Import a skill from GitHub / GitLab / Bitbucket (#37)
    const imp = el('div', 'skills-import');
    const impIn = el('input');
    impIn.type = 'text';
    impIn.placeholder = 'github.com/user/repo — import a skill from a repository';
    const impBtn = el('button', 'btn small', '⬇ import');
    const impHint = el('div', 'hint', '');
    const doImport = async () => {
      const url = impIn.value.trim();
      if (!url) return;
      impBtn.disabled = true;
      impHint.textContent = 'cloning…';
      const r = await ccx.invoke('skill:import', { url: /^https?:/.test(url) ? url : 'https://' + url });
      impBtn.disabled = false;
      if (!r.ok) { impHint.textContent = r.error; return; }
      impHint.textContent = 'imported: ' + r.imported.join(', ')
        + ((r.skipped && r.skipped.length) ? ' · already installed (skipped): ' + r.skipped.join(', ') : '');
      chat.skillsDetail = [];   // refetch on next open
      toast('Skill imported: ' + r.imported.join(', '), 'ok');
    };
    impBtn.addEventListener('click', doImport);
    impIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });
    imp.appendChild(impIn); imp.appendChild(impBtn);
    panel.appendChild(imp);
    panel.appendChild(impHint);

    // MCP status chips
    if (chat.init && (chat.init.mcp_servers || []).length) {
      panel.appendChild(elIcon('h4', '', CCEIcons.svg('plug2', 15) + ' MCP servers'));
      const mrow = el('div', 'mcp-chip-row');
      for (const s of chat.init.mcp_servers) {
        mrow.appendChild(el('span', 'chip mcp-chip ' + (s.status === 'connected' ? 'mcp-ok' : ''), `${s.name} · ${s.status}`));
      }
      panel.appendChild(mrow);
    }
    chat.pane.appendChild(panel);
    search.focus();
  }

  /* ---------------- mcp panel (live) ---------------- */

  const MCP_CLS = { connected: 'mcp-ok', failed: 'mcp-err', 'needs-auth': 'mcp-warn', pending: '', disabled: 'mcp-off' };

  async function toggleMcpPanel(chat) {
    if (panelOpen(chat, 'chat-mcp-panel')) return;
    const panel = makePanel(chat, 'chat-mcp-panel', 'plug2', 'MCP servers (live)',
      'Live session status. Disable/enable applies to this session only; reconnect retries a failed server. Click a server to see its tools.');
    const filter = el('input', 'skills-search');
    filter.placeholder = 'Filter servers or tools…';
    panel.appendChild(filter);
    const summary = el('div', 'mcp-summary');
    panel.appendChild(summary);
    const body = el('div', 'skills-list');
    body.appendChild(el('div', 'hint', 'loading…'));
    panel.appendChild(body);
    const refresh = elIcon('button', 'btn small', CCEIcons.svg('refresh', 14) + ' refresh');
    refresh.addEventListener('click', () => load());
    const link = elIcon('button', 'btn small', CCEIcons.svg('gear', 14) + ' open connectors');
    link.addEventListener('click', () => { panel.remove(); switchView('connectors'); });
    const actions = el('div', 'perm-actions');
    actions.appendChild(refresh);
    actions.appendChild(link);
    panel.appendChild(actions);
    chat.pane.appendChild(panel);

    let cached = null;
    const load = async (fromCache) => {
      const r = (fromCache && cached) || await ccx.invoke('chat:mcp', { id: chat.id, op: 'status' });
      cached = r;
      if (!panel.isConnected) return;
      body.innerHTML = '';
      const all = (r.ok && r.servers) || [];
      const count = (st) => all.filter(s => s.status === st).length;
      summary.innerHTML = '';
      for (const [label, n, cls] of [['connected', count('connected'), 'mcp-ok'], ['failed', count('failed'), 'mcp-err'],
        ['needs auth', count('needs-auth'), 'mcp-warn'], ['disabled', count('disabled'), 'mcp-off']]) {
        if (n) summary.appendChild(el('span', 'chip ' + cls, n + ' ' + label));
      }
      const q = filter.value.trim().toLowerCase();
      const servers = all.filter(s => !q || s.name.toLowerCase().includes(q)
        || (s.tools || []).some(t => String(t.name).toLowerCase().includes(q)));
      if (!servers.length) { body.appendChild(el('div', 'hint', all.length ? 'Nothing matches.' : 'No MCP servers in this session.')); return; }
      for (const s of servers) {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', s.name));
        row.appendChild(el('span', 'chip ' + (MCP_CLS[s.status] || ''), s.status));
        // The tool list is what proves the connector has tool-calling access.
        const tools = s.tools || [];
        if (tools.length) {
          const tchip = el('button', 'chip mcp-ok chip-btn', tools.length + ' tools ▾');
          tchip.title = 'Show the tools';
          let open = false;
          const tl = el('div', 'mcp-tools wide-hint hidden');
          for (const t of tools) {
            const tr = el('div', 'mcp-tool');
            tr.appendChild(el('code', '', t.name));
            if (t.description) tr.appendChild(el('span', 'skill-desc', String(t.description).slice(0, 140)));
            tl.appendChild(tr);
          }
          tchip.addEventListener('click', (e) => {
            e.stopPropagation();
            open = !open;
            tl.classList.toggle('hidden', !open);
            tchip.textContent = tools.length + ' tools ' + (open ? '▴' : '▾');
          });
          row.appendChild(tchip);
          row.__tools = tl;
        }
        if (s.error) row.appendChild(el('span', 'skill-desc', String(s.error).slice(0, 120)));
        const tog = el('button', 'btn small', s.status === 'disabled' ? 'enable' : 'disable');
        tog.addEventListener('click', async () => {
          tog.disabled = true;
          const nr = await ccx.invoke('chat:mcp', { id: chat.id, op: 'toggle', name: s.name, enabled: s.status === 'disabled' });
          if (!nr.ok) { toast(nr.error, 'err'); tog.disabled = false; } else load();
        });
        row.appendChild(tog);
        if (s.status === 'failed' || s.status === 'needs-auth') {
          const rc = elIcon('button', 'btn small', CCEIcons.svg('refresh', 14) + ' reconnect');
          rc.addEventListener('click', async () => {
            rc.disabled = true;
            const nr = await ccx.invoke('chat:mcp', { id: chat.id, op: 'reconnect', name: s.name });
            if (!nr.ok) { toast(nr.error, 'err'); rc.disabled = false; } else load();
          });
          row.appendChild(rc);
        }
        // Per-connector "ask every time" — the desktop app's tool policy.
        // The SDK carries the policy on the server definition, so it can only
        // be applied to a server this session registered itself; re-registering
        // a config-loaded server would replace a working one with a broken
        // copy (stale auth header). Refuse rather than break the connector.
        if (tools.length) {
          const ask = el('button', 'btn small', 'ask every time');
          ask.title = 'Require an approval for every call to this connector';
          ask.addEventListener('click', async () => {
            ask.disabled = true;
            const nr = await ccx.invoke('chat:mcp', {
              id: chat.id, op: 'policy', name: s.name, policy: 'always_ask',
              tools: tools.map((t) => t.name),
            });
            ask.disabled = false;
            if (!nr.ok) toast(nr.error || 'Could not set the policy', 'err');
            else toast('Always ask enabled for ' + s.name, 'ok');
          });
          row.appendChild(ask);
        }
        body.appendChild(row);
        if (row.__tools) body.appendChild(row.__tools);
      }
    };
    filter.addEventListener('input', () => load(true));
    load();
    filter.focus();
  }

  /* ---------------- rewind (file checkpoints) ---------------- */

  async function toggleRewindPanel(chat) {
    if (panelOpen(chat, 'chat-rewind-panel')) return;
    const r = await ccx.invoke('chat:checkpoints', { id: chat.id });
    const list = (r.ok && r.checkpoints) || [];
    const panel = makePanel(chat, 'chat-rewind-panel', 'undo', 'Rewind files',
      'Restore files written/edited by this session to an earlier checkpoint. The conversation is NOT undone. Changes made by Bash are not tracked. First click previews, second click applies.');
    const body = el('div', 'skills-list');
    if (!list.length) body.appendChild(el('div', 'hint', 'No checkpoints yet — they start with your first prompt in this session.'));
    for (const c of [...list].reverse()) {
      const row = el('div', 'skill-row');
      const main = el('div', 'hist-main');
      main.appendChild(el('div', 'hist-preview', c.text));
      main.appendChild(el('div', 'hist-meta', new Date(c.at).toLocaleString()));
      row.appendChild(main);
      const b = el('button', 'btn small danger', 'rewind');
      let armed = false;
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        // First click previews the change set; the second one applies it. #31
        if (!armed) {
          armed = true;
          b.textContent = 'checking…';
          const prev = await ccx.invoke('chat:rewind', { id: chat.id, uuid: c.uuid, dryRun: true });
          armed = false;
          if (!prev.ok) { toast(prev.error, 'err'); b.textContent = 'rewind'; return; }
          const files = (prev.filesChanged || []).length;
          const detail = prev.canRewind === false
            ? 'cannot rewind: ' + (prev.error || 'unknown')
            : (files ? files + ' file(s) would change  +' + (prev.insertions || 0) + ' −' + (prev.deletions || 0)
              : 'no tracked file changes');
          b.textContent = 'sure?';
          b.title = detail;
          row.appendChild(el('div', 'hint wide-hint', detail));
          armed = true;
          setTimeout(() => {
            if (!armed) return;
            armed = false; b.textContent = 'rewind'; b.title = '';
          }, 6000);
          return;
        }
        b.disabled = true;
        const rw = await ccx.invoke('chat:rewind', { id: chat.id, uuid: c.uuid });
        if (!rw.ok) { toast(rw.error, 'err'); b.disabled = false; b.textContent = 'rewind'; return; }
        panel.remove();
        chat.msgs.appendChild(el('div', 'sys-note',
          '⏪ files rewound to: ' + c.text.slice(0, 90) + (rw.skipped ? ' (' + rw.skipped + ' path(s) skipped)' : '')));
        scrollDownSoft(chat);
        toast('Files rewound', 'ok');
      });
      row.appendChild(b);
      body.appendChild(row);
    }
    panel.appendChild(body);
    chat.pane.appendChild(panel);
  }

  /* ---------------- context meter ---------------- */

  async function pollContext(chat) {
    // Only the newest poll may paint: overlapping calls can answer out of
    // order, and the older answer then overwrote the newer one (the meter flickered).
    const n = chat.ctxSeq = (chat.ctxSeq || 0) + 1;
    const r = await ccx.invoke('chat:context', { id: chat.id });
    if (n !== chat.ctxSeq || !r || !r.ok || !r.usage) return;
    const u = r.usage;
    const pct = Math.max(0, Math.min(100, Number(u.percentage) || 0));
    chat.ctxBar.classList.remove('hidden');
    chat.ctxFill.style.width = pct.toFixed(1) + '%';
    chat.ctxFill.style.background = pct > 85 ? 'var(--danger)' : pct > 65 ? 'var(--warn)' : 'var(--accent)';
    chat.ctxBar.title = 'context: ' + (u.totalTokens || 0).toLocaleString() + ' / '
      + (u.maxTokens || 0).toLocaleString() + ' tokens (' + pct.toFixed(0) + '%)';
    chat.ctxUsage = u;
    if (chat.compactBtn) {
      const ring = chat.compactBtn.querySelector('.ctx-ring');
      if (ring) ring.style.setProperty('--p', pct.toFixed(1));
      chat.compactBtn.classList.toggle('warn', pct > 65);
      const lbl = chat.compactBtn.querySelector('.ctx-pct');
      if (lbl) lbl.textContent = pct.toFixed(0) + '%';
      chat.compactBtn.title = 'Context ' + pct.toFixed(0) + '% used (' + (u.totalTokens || 0).toLocaleString()
        + ' / ' + (u.maxTokens || 0).toLocaleString() + ' tokens). Click to compact in place.';
    }
  }

  function startContextPolling(chat) {
    if (chat.ctxTimer) return;
    pollContext(chat);
    chat.ctxTimer = setInterval(() => {
      if (!chat.alive) { stopContextPolling(chat); return; }
      if (document.visibilityState !== 'visible') return;
      // Only poll the active tab. #perf-context
      if (window.__activeChatId && window.__activeChatId !== chat.id) return;
      pollContext(chat);
    }, 5000);
  }
  function stopContextPolling(chat) {
    clearInterval(chat.ctxTimer);
    chat.ctxTimer = null;
  }

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
    row.title.textContent = CCEIcons.svg('clock', 13) + ' ' + row.label
      + (info.last_tool_name ? ' — ' + info.last_tool_name : '')
      + (info.status ? ' · ' + info.status : '') + usage;
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

  function renderHooks(chat) {
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

  /* ---------------- workflows (deer-flow / ruflo / open-code-review patterns) ---------------- */

  const WORKFLOWS = {
    research: {
      mode: 'acceptEdits', fill: true,
      prompt: () => `Deep-research this project.\n\n1. Explore the repository (docs, source, config) to understand what exists.\n2. Pick the 3–5 most important open questions about it and investigate each: read the code, and use web search for current best practices and prior art.\n3. Produce a report: what the project is, how it works, what is missing or risky, and a recommended next step — with file paths and URLs as evidence.\n\nThe question I care about most: `,
    },
    review: {
      mode: 'acceptEdits', fill: false,
      prompt: () => `Code-review the current work in this repository.\n\n1. Run git status and git diff (including --staged). If the working tree is clean, diff against the default branch (origin/main or origin/master).\n2. For every finding report: severity (blocker / major / minor / nit), file:line, what is wrong, why it matters, and a concrete fix as a diff snippet.\n3. Cover correctness, security, error handling, tests, and naming. Focus directly on modified code. End with a one-screen summary table sorted by severity.`,
    },
    fastbuild: {
      mode: 'acceptEdits', fill: true,
      prompt: () => `Implement this directly and efficiently. Skip speculative brainstorming or excessive investigation. Read only the directly relevant files, make the code changes, and verify with tests.\n\nThe task: `,
    },
    explain: {
      mode: 'acceptEdits', fill: false,
      prompt: () => `Explore this repository and explain it to a new engineer:\n\n- Purpose and current state\n- Architecture: main components and how they connect (with file paths)\n- Entry points, build/run/test commands\n- Non-obvious gotchas and conventions\n\nUse short headings and, where it helps, a small diagram in a fenced code block.`,
    },
    plan: {
      mode: 'plan', fill: true,
      prompt: () => `I want to build: `,
    },
    testfix: {
      mode: 'acceptEdits', fill: false,
      prompt: () => `Make the test suite green.\n\n1. Work out how this repo runs its tests (package.json scripts, Makefile, CI config) and run them.\n2. For each failure: diagnose the root cause (do not just make the assertion pass), apply the minimal correct fix, and re-run that test.\n3. When everything passes, run the full suite once more and summarize what you changed and why, file by file.`,
    },
  };

  // Task flows in the spirit of multi-agent harnesses (map context → plan →
  // build → verify → ship): each is one staged prompt. `fill` ones put the
  // prompt in the composer and wait for your words; the rest run at once.
  Object.assign(WORKFLOWS, {
    map: {
      mode: 'acceptEdits', fill: true,
      prompt: () => `Map the code that matters for this task before touching anything.\n\n1. Find the files, functions and tests involved using focused search.\n2. List each with path:line and one line on its role, plus how data flows between them.\n3. Stop there: no edits. End with the 3 riskiest places to change.\n\nThe task: `,
    },
    brainstorm: {
      mode: 'plan', fill: true,
      prompt: () => `Brainstorm with me before any code. Ask me the questions you need (one batch), then propose 2–3 approaches with trade-offs and a recommendation.\n\nThe idea: `,
    },
    build: {
      mode: 'acceptEdits', fill: true,
      prompt: () => `Implement this directly:\n\n1. Locate and read the relevant target files.\n2. Apply the necessary modifications in small verified steps.\n3. Run build/tests to confirm functionality.\n4. Summarize the changes made.\n\nThe feature: `,
    },
    bugfix: {
      mode: 'acceptEdits', fill: true,
      prompt: () => `Debug this systematically: reproduce it first, form hypotheses, test each with evidence (logs, a failing test), fix the root cause, add a regression test, and show the passing run.\n\nThe bug / error: `,
    },
    refactor: {
      mode: 'acceptEdits', fill: true,
      prompt: () => `Refactor without changing behaviour. Run the tests first to get a baseline, make the change in small verified steps, keep public APIs stable, and run the full suite at the end.\n\nWhat to refactor: `,
    },
    tests: {
      mode: 'acceptEdits', fill: false,
      prompt: () => `Find the most important untested behaviour in this repo (read the code and the existing tests), add focused tests for it in the project's existing test style, run them, and report the coverage you added.`,
    },
    security: {
      mode: 'acceptEdits', fill: false,
      prompt: () => `Security-review this repository: secrets in code or config, injection (shell, SQL, HTML), unsafe deserialization, path traversal, auth gaps, and risky dependencies. Report each finding with severity, file:line, an exploit sketch and a fix. Do not change code.`,
    },
    browser: {
      mode: 'acceptEdits', fill: true,
      prompt: () => `Test the running app like a user: start the dev server if needed, open it in a browser tool, walk the main flows, and report what breaks (console errors, failed requests, layout issues) with steps to reproduce.\n\nThe URL or flow to test: `,
    },
    commit: {
      mode: 'acceptEdits', fill: false,
      prompt: () => `Prepare this work for review: run the tests, read git status and git diff, group the changes into sensible commits with clear messages (do not push), and draft a pull-request description with a summary and a test plan.`,
    },
    docs: {
      mode: 'acceptEdits', fill: false,
      prompt: () => `Bring the docs up to date with the code: compare README and docs/ against the actual commands, options and behaviour, fix what is stale or missing, and list what you changed.`,
    },
  });

  // Grouped and colour-coded for the picker (the colour is the stage).
  const WORKFLOW_MENU = [
    ['Understand', 'wf-c-understand', [
      ['explain', 'notebook', 'Explain repo', 'architecture, entry points, gotchas'],
      ['map', 'search', 'Map context', 'find the files a task touches'],
      ['research', 'globe', 'Deep research', 'code + web, with evidence'],
    ]],
    ['Plan', 'wf-c-plan', [
      ['brainstorm', 'thought', 'Brainstorm', 'questions, options, a recommendation'],
      ['plan', 'map', 'Plan feature', 'plan mode — no edits'],
    ]],
    ['Build', 'wf-c-build', [
      ['build', 'bolt', 'Build feature', 'context → plan → build → review'],
      ['bugfix', 'bug', 'Fix a bug', 'reproduce, root cause, regression test'],
      ['refactor', 'wrench', 'Refactor', 'behaviour stays the same'],
    ]],
    ['Verify', 'wf-c-verify', [
      ['testfix', 'check', 'Test & fix', 'make the suite green'],
      ['tests', 'list', 'Add tests', 'cover what is untested'],
      ['review', 'eye', 'Code review', 'severity-ranked findings'],
      ['security', 'shield', 'Security review', 'report only, no edits'],
      ['browser', 'globe', 'Test in browser', 'walk the app like a user'],
    ]],
    ['Ship', 'wf-c-ship', [
      ['commit', 'branch', 'Commit & PR draft', 'tests, commits, PR text'],
      ['docs', 'file', 'Update docs', 'README and docs vs. code'],
    ]],
  ];

  async function runWorkflow(chat, send, key) {
    const wf = WORKFLOWS[key];
    if (!wf || !chat.alive) return;
    // Only switch for plan (explicitly read-only) or to leave plan; never quietly
    // downgrade the user's auto / accept edits / yolo choice.
    if (wf.mode && wf.mode !== chat.mode && (wf.mode === 'plan' || chat.mode === 'plan')) {
      const r = await ccx.invoke('chat:set-mode', { id: chat.id, mode: wf.mode });
      if (r.ok) { chat.mode = wf.mode; chat.modeSel.value = wf.mode; toast('Mode → ' + modeLabel(chat.mode)); }
      else toast(r.error, 'err');
    }
    chat.composer.value = wf.prompt(chat.cwd);
    autosize(chat.composer);
    chat.composer.focus();
    chat.composer.setSelectionRange(chat.composer.value.length, chat.composer.value.length);
    if (!wf.fill) send();   // self-contained workflows run immediately; fill-in ones wait for the user
  }

  function wireWorkflowPicker(chat, send) {
    if (!chat.wfBtn) return;
    let menu = null;
    const close = () => {
      if (!menu) return;
      menu.remove(); menu = null;
      chat.wfBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', away, true);
    };
    const away = (e) => { if (menu && !menu.contains(e.target) && !chat.wfBtn.contains(e.target)) close(); };
    chat.wfBtn.addEventListener('click', () => {
      if (menu) return close();
      menu = el('div', 'wf-menu');
      menu.setAttribute('role', 'menu');
      for (const [group, cls, rows] of WORKFLOW_MENU) {
        const sec = el('div', 'wf-group ' + cls);
        sec.appendChild(el('div', 'wf-group-name', group));
        for (const [key, icon, label, hint] of rows) {
          const b = el('button', 'wf-item');
          b.setAttribute('role', 'menuitem');
          b.dataset.wf = key;
          b.appendChild(elIcon('span', 'wf-ico', CCEIcons.svg(icon, 14)));
          const txt = el('span', 'wf-txt');
          txt.appendChild(el('b', '', label));
          txt.appendChild(el('span', '', hint + (WORKFLOWS[key].fill ? ' · you add the details' : ' · runs now')));
          b.appendChild(txt);
          b.addEventListener('click', () => { close(); runWorkflow(chat, send, key); });
          sec.appendChild(b);
        }
        menu.appendChild(sec);
      }
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('.wf-item')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); chat.wfBtn.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      });
      chat.pane.querySelector('.chat-composer').appendChild(menu);
      chat.wfBtn.setAttribute('aria-expanded', 'true');
      setTimeout(() => document.addEventListener('mousedown', away, true), 0);
      const first = menu.querySelector('.wf-item');
      if (first) first.focus();
    });
  }

  /* ---------------- nested subagent timelines ---------------- */

  // Frames produced inside a Task/Agent subagent carry parent_tool_use_id —
  // render them nested inside their parent card (orchestration view).
  function nestedTarget(chat, parentId) {
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

  /* ---------------- composer helpers (titles, images, @files, copy, run) ---------------- */

  function autoTitle(chat, text) {
    if (chat.titled || !text) return;
    chat.titled = true;
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 26) || basename(chat.cwd);
    if (chat.tabEl && chat.tabEl.firstChild) chat.tabEl.firstChild.textContent = '⌘ ' + t;
  }

  function renderImageChips(chat) {
    chat.imgs.innerHTML = '';
    chat.imgs.classList.toggle('hidden', !chat.pendingImages.length);
    chat.pendingImages.forEach((img, i) => {
      const chip = elIcon('span', 'img-chip', CCEIcons.svg('file', 13) + ' image ' + (i + 1));
      const x = elIcon('button', 'close', CCEIcons.svg('close', 13));
      x.title = 'Remove';
      x.setAttribute('aria-label', 'Remove image');
      x.addEventListener('click', () => { chat.pendingImages.splice(i, 1); renderImageChips(chat); });
      chip.appendChild(x);
      chat.imgs.appendChild(chip);
    });
  }
  function clearImages(chat) { chat.pendingImages = []; renderImageChips(chat); }

  async function maybeAt(chat) {
    const v = chat.composer.value;
    const pos = chat.composer.selectionStart ?? v.length;
    const m = v.slice(0, pos).match(/(^|\s)@([^\s@]*)$/);
    if (!m) {
      if (chat.atMode) { chat.atMode = false; hideSlash(chat); }
      return false;
    }
    chat.atMode = true;
    const q = m[2].toLowerCase();
    if (!chat.filesCache) {
      const r = await ccx.invoke('project:files', { cwd: chat.cwd });
      chat.filesCache = r.ok ? r.files : [];
    }
    const files = chat.filesCache.filter(f => f.toLowerCase().includes(q)).slice(0, 10);
    if (!files.length) { hideSlash(chat); return true; }
    chat.atItems = files;
    chat.slashIdx = 0;
    chat.slash.innerHTML = '';
    files.forEach((f, i) => {
      const item = elIcon('div', 'slash-item' + (i === chat.slashIdx ? ' sel' : ''), CCEIcons.svg('file', 14) + ' ' + esc(f));
      item.addEventListener('mousedown', (e) => { e.preventDefault(); chat.slashIdx = i; applyAt(chat); });
      chat.slash.appendChild(item);
    });
    chat.slash.classList.remove('hidden');
    return true;
  }

  function applyAt(chat) {
    const f = chat.atItems[chat.slashIdx >= 0 ? chat.slashIdx : 0];
    if (f) {
      const v = chat.composer.value;
      const pos = chat.composer.selectionStart ?? v.length;
      const before = v.slice(0, pos).replace(/@([^\s@]*)$/, '@' + f + ' ');
      chat.composer.value = before + v.slice(pos);
      chat.composer.setSelectionRange(before.length, before.length);
      chat.composer.focus();
    }
    chat.atMode = false;
    hideSlash(chat);
  }

  /** navigator.clipboard is refused in some Electron states (focus, permissions); fall back to the main process. */
  async function copyText(text) {
    const t = String(text == null ? '' : text);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; }
    } catch { /* fall through */ }
    try { const r = await ccx.invoke('clipboard:write', { text: t }); return !!(r && r.ok); } catch { return false; }
  }

  function addCopyBtn(host, getText, cls) {
    const b = elIcon('button', 'copy-btn ' + (cls || ''), CCEIcons.svg('copy', 14));
    b.title = 'Copy';
    b.setAttribute('aria-label', 'Copy to clipboard');
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyText(getText());
      b.innerHTML = CCEIcons.svg(ok ? 'check' : 'close', 14);
      b.title = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { b.innerHTML = CCEIcons.svg('copy', 14); b.title = 'Copy'; }, 1200);
    });
    host.appendChild(b);
  }

  function enhanceMarkdown(container, rawText) {
    addCopyBtn(container, () => rawText, 'msg-copy');
    container.querySelectorAll('pre').forEach(pre => {
      // Take the text BEFORE the copy button is added and before highlighting:
      // Monaco's colorized HTML uses &nbsp; for spaces and <br> for line breaks,
      // so reading textContent afterwards pasted odd spaces and no newlines.
      let code = pre.querySelector('code');
      const plain = code ? code.textContent : pre.textContent;
      // Highlighting replaces innerHTML, so it must never target the <pre>
      // itself — that would also destroy the copy button living inside it. A
      // bare <pre> gets a <code> wrapper first. #54
      if (!code) {
        code = document.createElement('code');
        code.textContent = plain;
        pre.textContent = '';
        pre.appendChild(code);
      }
      colorizeCode(pre, code, plain);
      addCopyBtn(pre, () => plain, 'pre-copy');
    });
  }

  // Monaco paints with whichever theme is current, and its default is the light one:
  // black text on cce's dark code blocks. Follow the app theme instead.
  const monacoThemeName = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark');

  // Monaco is already vendored for the diff editor, so syntax highlighting
  // costs no extra dependency. Falls back to plain text when unavailable. #35
  function colorizeCode(pre, code, plain) {
    if (!window.monaco || !window.monaco.editor || typeof window.monaco.editor.colorize !== 'function') return;
    const text = plain != null ? plain : (code.textContent || '');
    if (!text.trim() || text.length > 20000) return;
    try {
      if (typeof window.monaco.editor.setTheme === 'function') window.monaco.editor.setTheme(monacoThemeName());
      const lang = detectLang(code);
      Promise.resolve(window.monaco.editor.colorize(text, lang, { tabSize: 2 }))
        .then((html) => { if (html && code.textContent === text) code.innerHTML = html; })
        .catch(() => { /* leave plain */ });
    } catch { /* leave plain */ }
  }

  const LANG_BY_CLASS = {
    'language-js': 'javascript', 'language-javascript': 'javascript',
    'language-ts': 'typescript', 'language-typescript': 'typescript',
    'language-py': 'python', 'language-python': 'python',
    'language-bash': 'shell', 'language-sh': 'shell', 'language-shell': 'shell',
    'language-json': 'json', 'language-yaml': 'yaml', 'language-yml': 'yaml',
    'language-html': 'html', 'language-css': 'css', 'language-sql': 'sql',
    'language-rust': 'rust', 'language-rs': 'rust', 'language-go': 'go',
  };
  function detectLang(code) {
    const cls = (code.className || '') + ' ' + [...(code.parentElement?.classList || [])].join(' ');
    for (const [needle, lang] of Object.entries(LANG_BY_CLASS)) {
      if (cls.includes(needle)) return lang;
    }
    const first = (code.textContent || '').trim().split('\n')[0] || '';
    if (/^#!.*\b(bash|sh)\b/.test(first)) return 'shell';
    if (/^\s*[{[]/.test(first)) return 'json';
    return 'plaintext';
  }

  function wireRunMenu(chat) {
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; } };
    // The button lives in the overflow menu now; keep a stable handle so both
    // the menu item and the Ctrl+K palette can trigger it.
    const btn = el('button', 'chat-btn', '▶');
    btn.title = 'Run build / test scripts in a terminal tab';
    btn.setAttribute('aria-label', 'Run build or test scripts in a terminal tab');
    btn.style.display = 'none';
    chat.pane.appendChild(btn);
    chat.runBtn = btn;
    btn.addEventListener('click', async () => {
      if (menu && menu.isConnected) return close();
      menu = makePanel(chat, 'chat-run-menu', 'play', 'Run in a terminal tab',
        'Opens a terminal tab in this folder and runs the command there.');
      const list = el('div', 'skills-list');
      menu.appendChild(list);
      const add = (label, cmd) => {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', cmd));
        row.appendChild(el('span', 'skill-desc', label));
        const b = el('button', 'btn small', 'run');
        b.addEventListener('click', () => {
          window.createSession({ cwd: chat.cwd, type: 'shell', initText: cmd === '$SHELL' ? '' : cmd + '\r' });
          switchView('terminal');
          close();
        });
        list.appendChild(row);
      };
      const r = await ccx.invoke('project:scripts', { cwd: chat.cwd });
      add('interactive shell', '$SHELL');
      for (const s of (r.ok ? r.scripts : [])) add('package.json script', 'npm run ' + s);
      if (r.ok && r.hasMakefile) { add('makefile default target', 'make'); add('makefile test target', 'make test'); }
      menu.appendChild(list);
      chat.pane.appendChild(menu);
    });
  }

  /* ---------------- history panel (per-folder, inside a chat) ---------------- */
  // The flat, all-projects conversation list now lives in app.js next to the
  // workspace; this panel stays for the per-folder variant.


  async function toggleHistoryPanel(chat) {
    if (panelOpen(chat, 'chat-history-panel')) return;
    const panel = makePanel(chat, 'chat-history-panel', 'clock', 'Past conversations · ' + basename(chat.cwd),
      'From the engine’s transcript store, terminal sessions included. Open resumes; Fork branches without touching the original.');
    const filter = el('input', 'skills-search');
    filter.placeholder = 'Search this folder’s conversations…';
    panel.appendChild(filter);
    const list = el('div', 'skills-list');
    panel.appendChild(list);
    const allBtn = el('button', 'btn small', 'All conversations (every folder)');
    allBtn.addEventListener('click', () => { panel.remove(); if (window.toggleConversations) window.toggleConversations(true); });
    panel.appendChild(allBtn);
    chat.pane.appendChild(panel);
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const row of list.querySelectorAll('.hist-row')) row.classList.toggle('hidden', !!q && !row.textContent.toLowerCase().includes(q));
    });
    filter.focus();

    const r = await ccx.invoke('chat:history', { cwd: chat.cwd });
    const sessions = (r.ok && r.sessions) || [];
    if (!sessions.length) list.appendChild(el('div', 'hint', 'No past sessions found for this folder yet.'));
    for (const s of sessions) {
      const row = el('div', 'skill-row hist-row');
      row.appendChild(el('span', 'hist-preview', s.preview));
      row.appendChild(el('span', 'chip', fmtAge(s.mtime)));
      const open = el('button', 'btn small', 'open');
      open.title = 'Resume this conversation';
      open.addEventListener('click', async () => {
        if (s.sessionId === chat.sessionId) await closeChat(chat.id);
        createSession({ cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode, resume: s.sessionId });
      });
      const fork = el('button', 'btn small', '⑂ fork');
      fork.title = 'Branch from this point — original stays untouched';
      fork.addEventListener('click', () => createSession({ cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode, resume: s.sessionId, fork: true }));
      const del = elIcon('button', 'btn small danger', CCEIcons.svg('trash', 14));
      del.setAttribute('aria-label', 'Delete this session from disk');
      del.title = 'Delete this session from disk';
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'sure?'; setTimeout(() => { armed = false; del.innerHTML = CCEIcons.svg('trash', 14); }, 2500); return; }
        const rd = await ccx.invoke('chat:delete', { cwd: chat.cwd, sessionId: s.sessionId });
        if (rd.ok) { row.remove(); toast('Session deleted', 'ok'); } else toast(rd.error, 'err');
      });
      row.appendChild(open); row.appendChild(fork); row.appendChild(del);
      list.appendChild(row);
    }
  }

  /* ---------------- built-in slash commands ---------------- */

  const COMPACT_PROMPT = 'Summarize this conversation so far as a handoff brief for a fresh session: project state, key decisions, files changed, open tasks, and next steps. Be dense and concrete. Reply with ONLY the brief.';

  // In-place compaction: the engine's own /compact summarizes the earlier
  // turns into the SAME session, so the chat, its tab and its tools carry on.
  async function doCompact(chat, focus) {
    if (!chat.alive) return;
    if (chat.busy) { toast('Wait for the current turn to finish, then compact', 'err'); return; }
    chat.msgs.querySelector('.chat-empty')?.remove();
    chat.msgs.appendChild(el('div', 'sys-note', '✂ compacting this conversation in place…'));
    scrollDownSoft(chat);
    if (chat.compactBtn) chat.compactBtn.disabled = true;
    try {
      const r = await ccx.invoke('chat:send', { id: chat.id, text: '/compact' + (focus ? ' ' + focus : '') });
      if (!r || !r.ok) appendError(chat, 'Could not compact: ' + ((r && r.error) || 'session not running'));
    } catch (e) {
      appendError(chat, 'Could not compact: ' + ((e && e.message) || e));
    } finally {
      if (chat.compactBtn) chat.compactBtn.disabled = false;   // a rejected invoke used to strand it disabled
    }
  }

  // The old behaviour, kept as /handoff: a brief, then a fresh session.
  async function doHandoff(chat) {
    if (!chat.alive) return;
    chat.compacting = true;
    chat.msgs.querySelector('.chat-empty')?.remove();
    chat.msgs.appendChild(el('div', 'sys-note', '✂ handoff — asking for a brief, then continuing in a fresh session…'));
    scrollDownSoft(chat);
    try {
      const r = await ccx.invoke('chat:send', { id: chat.id, text: COMPACT_PROMPT });
      if (!r || !r.ok) {
        // Drop compacting or the NEXT ordinary result is misread as the brief
        // and spawns a session nobody asked for.
        chat.compacting = false;
        appendError(chat, 'Could not hand off: ' + ((r && r.error) || 'session not running'));
      }
    } catch (e) {
      chat.compacting = false;
      appendError(chat, 'Could not hand off: ' + ((e && e.message) || e));
    }
  }

  function handleBuiltin(chat, text) {
    const cmd = text.split(/\s/)[0];
    if (cmd === '/compact') { doCompact(chat, text.slice(cmd.length).trim()); return true; }
    if (cmd === '/handoff') { doHandoff(chat); return true; }
    if (cmd === '/clear') {
      createSession({ cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode });
      toast('Fresh session opened (old one stays in History)');
      return true;
    }
    if (cmd === '/cost') {
      const r = chat.lastResult;
      toast(r && typeof r.total_cost_usd === 'number'
        ? `Cost so far: $${r.total_cost_usd.toFixed(4)} · ${r.num_turns} turns · ${fmtTok((r.usage || {}).input_tokens || 0)} in / ${fmtTok((r.usage || {}).output_tokens || 0)} out`
        : 'No usage yet this session.', 'ok');
      return true;
    }
    if (cmd === '/model') { openCustomModel(chat); return true; }
    if (cmd === '/review') {
      const focus = text.slice(cmd.length).trim();
      chat.composer.value = 'Review the current changes' + (focus ? ' focusing on ' + focus : '') + ': run git diff, identify bugs, risks, missing tests, and style issues; report findings as a numbered list with file:line references.';
      setTimeout(() => send(), 0);
      return true;
    }
    if (cmd === '/help') {
      toast('Built-ins: /compact · /handoff · /clear · /cost · /model · /review · /help — every other /command runs in the engine', '');
      return true;
    }
    return false; // engine-side command (skills, plugins, custom)
  }

  /* ---------------- plan viewer (claude-desktop style) ---------------- */

  function openPlanViewer(chat) {
    if (chat.planViewer) return chat.planViewer.body;
    const wrap = el('div', 'chat-plan-viewer');
    const head = el('div', 'plan-head');
    head.appendChild(elIcon('h4', '', CCEIcons.svg('map', 14) + ' Plan'));
    const close = el('button', 'close', '✕');
    close.title = 'Hide plan panel';
    close.setAttribute('aria-label', 'Hide plan panel');
    close.addEventListener('click', () => { wrap.remove(); chat.planViewer = null; });
    head.appendChild(close);
    const body = el('div', 'plan-body md');
    body.innerHTML = '<p class="hint">waiting for the plan…</p>';
    wrap.appendChild(head);
    wrap.appendChild(body);
    chat.planViewer = { wrap, body };
    chat.pane.querySelector('.chat-body').appendChild(wrap);
    return body;
  }

  function updatePlanViewer(chat, jsonStr) {
    const body = chat.planViewer ? chat.planViewer.body : null;
    if (!body || !jsonStr) return;
    try {
      const j = JSON.parse(jsonStr);
      if (j && j.plan) body.innerHTML = md(j.plan);
    } catch { /* partial JSON — wait for more */ }
  }

  /* ---------------- message rendering ---------------- */

  /** Output of a command the user ran (e.g. /model), shown as a quiet note. */
  function appendCommandNote(chat, text, uuid) {
    chat.msgs.querySelector('.chat-empty')?.remove();
    const n = el('div', 'sys-note cmd-note', '↳ ' + text);
    if (uuid) n.dataset.uuid = uuid;
    chat.msgs.appendChild(n);
    scrollDownSoft(chat);
  }

  /** The engine's compaction summary: folded, since it can run to pages. */
  function appendSummary(chat, text, uuid) {
    chat.msgs.querySelector('.chat-empty')?.remove();
    const d = el('details', 'compact-summary');
    if (uuid) d.dataset.uuid = uuid;
    d.appendChild(el('summary', '', 'Summary of the earlier conversation — what the model now remembers. Click to read.'));
    const body = el('div', 'md');
    body.innerHTML = md(String(text || '').replace(/^This session is being continued[^\n]*\n+/, ''));
    d.appendChild(body);
    chat.msgs.appendChild(d);
    scrollDownSoft(chat);
  }

  function appendUser(chat, text, uuid) {
    chat.msgs.querySelector('.chat-empty')?.remove();
    const wrap = el('div', 'msg user-msg');
    wrap.dataset.uuid = uuid || '';
    wrap.dataset.text = String(text || '').trim();
    const bubble = el('div', 'user-bubble', text);
    addCopyBtn(bubble, () => text);
    // Hover actions: re-ask from here, and rewind the files to this point. #30
    const acts = el('div', 'msg-actions');
    const edit = el('button', 'btn tiny', 'edit & resend');
    edit.title = 'Branch a new conversation from this message with an edited prompt';
    edit.addEventListener('click', () => resendFrom(chat, uuid, text));
    acts.appendChild(edit);
    const back = el('button', 'btn tiny', 'rewind here');
    back.title = 'Restore files to the state at this message (conversation keeps going)';
    back.addEventListener('click', async () => {
      const r = await ccx.invoke('chat:rewind', { id: chat.id, uuid, dryRun: true });
      if (!r.ok) return toast(r.error, 'err');
      const files = (r.filesChanged || []).length;
      if (!files) return toast('no tracked file changes at this point', '');
      const go = window.confirm(`Rewind ${files} file(s)? +${r.insertions || 0} −${r.deletions || 0}`);
      if (!go) return;
      const rw = await ccx.invoke('chat:rewind', { id: chat.id, uuid });
      toast(rw.ok ? 'files rewound' : rw.error, rw.ok ? 'ok' : 'err');
    });
    if (uuid) acts.appendChild(back);
    wrap.appendChild(bubble);
    wrap.appendChild(acts);
    chat.msgs.appendChild(wrap);
    scrollDownSoft(chat);
    return wrap;
  }

  /** Branch the conversation from a message with an edited prompt. #30 */
  async function resendFrom(chat, uuid, originalText) {
    const edited = await window.askText('Re-ask from this message (the conversation branches)', originalText, { multiline: true, okLabel: 'Re-ask' });
    if (edited === null || !edited.trim() || edited === originalText) return;
    Chat.createSession({
      cwd: chat.cwd,
      providerUid: chat.provider ? chat.provider.uid : null,
      model: chat.model || '',
      permissionMode: chat.mode,
      resume: chat.sessionId,
      fork: true,
      resumeAt: uuid,
      initText: edited,
    });
  }

  /* ---------------- transcript virtualization (#C1) ---------------- */
  // Keep only a bounded window of messages in the DOM so a 10k-message
  // conversation does not create 10k nodes. Older nodes stay in chat._allNodes
  // and come back when the user scrolls toward the top. #C1
  const VIRT_WINDOW = 100;
  const VIRT_PAGE = 100;
  const VIRT_EST_HEIGHT = 60;
  function installVirtualization(chat) {
    chat._allNodes = [];
    chat._winStart = 0;
    chat._winEnd = 0;
    chat._renderedStart = 0;   // alias kept for older code / tests
    chat._renderedEnd = 0;
    chat._virtLoading = false;
    const msgs = chat.msgs;
    const spacer = document.createElement('div');
    spacer.className = 'virt-spacer';
    spacer.style.height = '0px';
    chat._topSpacer = spacer;
    const origAppend = msgs.appendChild.bind(msgs);
    const origRemove = msgs.removeChild.bind(msgs);
    chat._origAppend = origAppend;
    chat._origRemove = origRemove;

    function removeEmpty() {
      const empty = msgs.querySelector('.chat-empty');
      if (empty && empty.parentNode === msgs) try { origRemove(empty); } catch { /* ignore */ }
    }

    function rebuildWindow(start) {
      const total = chat._allNodes.length;
      if (total === 0) {
        for (const c of [...msgs.children]) if (c !== spacer) try { origRemove(c); } catch { /* ignore */ }
        if (spacer.parentNode === msgs) try { origRemove(spacer); } catch { /* ignore */ }
        spacer.style.height = '0px';
        try { origAppend(spacer); } catch { /* ignore */ }
        chat._winStart = 0; chat._winEnd = 0;
        chat._renderedStart = 0; chat._renderedEnd = 0;
        return;
      }
      let s = Math.max(0, Math.min(start, total - 1));
      let e = Math.min(total, s + VIRT_WINDOW);
      if (e - s < VIRT_WINDOW) s = Math.max(0, e - VIRT_WINDOW);
      e = Math.min(total, s + VIRT_WINDOW);
      if (total <= VIRT_WINDOW) { s = 0; e = total; }

      const keepScroll = msgs.scrollTop;
      for (const c of [...msgs.children]) if (c !== spacer) try { origRemove(c); } catch { /* ignore */ }
      if (spacer.parentNode === msgs) try { origRemove(spacer); } catch { /* ignore */ }
      spacer.style.height = (s * VIRT_EST_HEIGHT) + 'px';
      try { origAppend(spacer); } catch { /* ignore */ }
      for (let i = s; i < e; i++) {
        const n = chat._allNodes[i];
        if (n) try { origAppend(n); } catch { /* ignore */ }
      }
      chat._winStart = s;
      chat._winEnd = e;
      chat._renderedStart = s;
      chat._renderedEnd = e;
      try { msgs.scrollTop = keepScroll; } catch { /* read-only */ }
    }

    function evictTop() {
      while (chat._winEnd - chat._winStart > VIRT_WINDOW) {
        const node = chat._allNodes[chat._winStart];
        if (node && node.parentNode === msgs) try { origRemove(node); } catch { /* ignore */ }
        chat._winStart++;
      }
      chat._renderedStart = chat._winStart;
      chat._renderedEnd = chat._winEnd;
      spacer.style.height = (chat._winStart * VIRT_EST_HEIGHT) + 'px';
      if (spacer.parentNode !== msgs) try { origAppend(spacer); } catch { /* ignore */ }
      try { msgs.insertBefore(spacer, msgs.firstChild); } catch { /* ignore */ }
    }

    msgs.appendChild = function(node) {
      if (node === spacer) return origAppend(node);
      removeEmpty();
      chat._allNodes.push(node);
      const total = chat._allNodes.length;
      const idx = total - 1;
      if (chat.follow !== false) {
        // Anchored at the bottom: paint the node and keep the tail window.
        if (chat._winEnd === total - 1 || chat._winEnd === 0) {
          if (spacer.parentNode !== msgs) try { origAppend(spacer); } catch { /* ignore */ }
          try { msgs.insertBefore(spacer, msgs.firstChild); } catch { /* ignore */ }
          origAppend(node);
          chat._winEnd = total;
          evictTop();
        } else {
          rebuildWindow(Math.max(0, total - VIRT_WINDOW));
        }
        try { msgs.scrollTop = msgs.scrollHeight; } catch { /* read-only */ }
      } else {
        // User is reading older messages: record the node, paint only if it
        // falls inside the current window (it normally does not, since it is
        // newer than the view).
        if (idx >= chat._winStart && idx < chat._winEnd) {
          rebuildWindow(chat._winStart);
        }
      }
      chat._renderedStart = chat._winStart;
      chat._renderedEnd = chat._winEnd;
      return node;
    };

    msgs.removeChild = function(node) {
      const idx = chat._allNodes.indexOf(node);
      if (idx !== -1) {
        chat._allNodes.splice(idx, 1);
        if (chat._winEnd > chat._allNodes.length) chat._winEnd = chat._allNodes.length;
        chat._renderedStart = chat._winStart;
        chat._renderedEnd = chat._winEnd;
      }
      return origRemove(node);
    };

    msgs.addEventListener('scroll', () => {
      if (chat._allNodes.length === 0 || chat._virtLoading) return;
      const total = chat._allNodes.length;
      const s = chat._winStart;
      const e = chat._winEnd;
      if (msgs.scrollTop < 120 && s > 0) {
        chat._virtLoading = true;
        const newS = Math.max(0, s - VIRT_PAGE);
        const beforeH = msgs.scrollHeight;
        const beforeT = msgs.scrollTop;
        rebuildWindow(newS);
        try { msgs.scrollTop = beforeT + (msgs.scrollHeight - beforeH); } catch { /* read-only */ }
        chat._virtLoading = false;
        return;
      }
      if (e < total && (msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 120)) {
        chat._virtLoading = true;
        const newS = Math.max(0, total - VIRT_WINDOW);
        rebuildWindow(newS);
        if (msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 40) {
          try { msgs.scrollTop = msgs.scrollHeight; } catch { /* read-only */ }
        }
        chat._virtLoading = false;
      }
    }, { passive: true });
  }
  function nearBottom(chat) {
    return chat.msgs.scrollHeight - chat.msgs.scrollTop - chat.msgs.clientHeight < 40;
  }
  function scrollDown(chat) { chat.msgs.scrollTop = chat.msgs.scrollHeight; }
  // New output only pulls the view down while the user is at the bottom; once
  // they scroll up to read, it stays put until they come back (or send).
  function scrollDownSoft(chat) {
    if (chat.follow !== false) scrollDown(chat);
    else updateLatestBtn(chat);
  }

  /**
   * Show the "jump to latest" button while the view is away from the live
   * end. Without it, scrolling up to read an earlier answer left no way back
   * to the newest response short of dragging the scrollbar.
   */
  function updateLatestBtn(chat) {
    const btn = chat.latestBtn;
    if (!btn) return;
    const away = !nearBottom(chat);
    btn.classList.toggle('hidden', !away);
  }

  function handleEvent(evt) {
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
      if (evt.stillQueued) {
        chat.msgs.appendChild(elIcon('div', 'sys-note', CCEIcons.svg('stop', 12) + ' interrupted — ' + evt.stillQueued + ' queued message(s) still run next'));
        scrollDownSoft(chat);
      }
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

  function updateBusyUi(chat) {
    if (!chat.sendBtn) return;
    const isBusy = !!chat.busy;
    if (chat.busyModeBtn) {
      chat.busyModeBtn.classList.toggle('hidden', !isBusy);
      const mode = chat.busyMode || 'queue';
      chat.busyModeBtn.innerHTML = mode === 'steer'
        ? '<span class="busy-mode-badge steer">↯ Steer</span>'
        : '<span class="busy-mode-badge queue">⏭ Queue</span>';
      chat.busyModeBtn.title = mode === 'steer'
        ? 'Steer mode: Interrupts immediately (Enter). Click to switch to Queue.'
        : 'Queue mode: Runs after turn completes (Enter). Click to switch to Steer.';
    }
    const mode = chat.busyMode || 'queue';
    if (isBusy) {
      const hasText = Boolean((chat.composer && chat.composer.value.trim()) || chat.pendingImages.length);
      if (hasText) {
        chat.sendBtn.innerHTML = CCEIcons.svg(mode === 'steer' ? 'bolt' : 'play', 15);
        chat.sendBtn.title = mode === 'steer'
          ? 'Steer (Enter) · Ctrl+Enter to queue'
          : 'Queue (Enter) · Ctrl+Enter to steer';
        chat.sendBtn.classList.remove('busy');
        chat.sendBtn.classList.toggle('mode-steer', mode === 'steer');
        chat.sendBtn.classList.toggle('mode-queue', mode === 'queue');
      } else {
        chat.sendBtn.innerHTML = CCEIcons.svg('square', 15);
        chat.sendBtn.title = 'Stop (Esc)';
        chat.sendBtn.classList.add('busy');
        chat.sendBtn.classList.remove('mode-steer', 'mode-queue');
      }
    } else {
      chat.sendBtn.innerHTML = CCEIcons.svg('send', 15);
      chat.sendBtn.title = 'Send (Enter)';
      chat.sendBtn.classList.remove('busy', 'mode-steer', 'mode-queue');
    }
  }

  function setBusy(chat, busy) {
    // Late status frames from the dead engine must not resurrect a handed-off tab.
    if (chat.handedOff && busy) return;
    chat.busy = busy;
    publishTabState(chat);
    chat.dot.classList.toggle('busy', busy);
    chat.stopBtn.classList.toggle('hidden', !busy);
    if (chat.buildNowBtn) chat.buildNowBtn.classList.toggle('hidden', !busy);
    chat.contBtn.classList.toggle('hidden', busy || !chat.lastResult || !chat.alive);
    updateBusyUi(chat);
    if (busy) { chat.statusLine.textContent = 'working…'; startContextPolling(chat); }
    else {
      if (chat.ctxTimer) { stopContextPolling(chat); pollContext(chat); }
      setStatusLine(chat);
      // Auto-dispatch next queued message if any
      if (chat.pendingMsgs && chat.pendingMsgs.length > 0) {
        const next = chat.pendingMsgs.shift();
        try { localStorage.setItem('cce:pending:' + (chat.cwd || ''), JSON.stringify(chat.pendingMsgs)); } catch { /* ignore */ }
        renderQueued(chat);
        const nextText = typeof next === 'string' ? next : (next && next.text) || '';
        const nextBlocks = typeof next === 'object' && next ? next.blocks : null;
        setTimeout(() => {
          if (!chat.alive) return;
          ccx.invoke('chat:send', { id: chat.id, text: nextText, blocks: nextBlocks })
            .then((r) => { if (!r || !r.ok) setBusy(chat, false); })
            .catch(() => setBusy(chat, false));
        }, 50);
      }
    }
  }

  function setStatusLine(chat) {
    // A local or relayed provider reports Anthropic-derived cost for work it
    // never billed, so "$0.0204" against Ollama was actively misleading. #15
    const metered = !chat.provider || !chat.provider.baseUrl;
    const parts = [chat.model ? 'model: ' + chat.model : 'model: provider default', 'mode: ' + modeLabel(chat.mode)];
    if (metered && chat.spent > 0.0001) parts.push('session $' + chat.spent.toFixed(4));
    if (chat.lastResult) {
      const r = chat.lastResult;
      if (metered && typeof r.total_cost_usd === 'number' && r.total_cost_usd > 0) parts.push('$' + r.total_cost_usd.toFixed(4));
      parts.push((r.num_turns != null ? r.num_turns : 0) + ' turns', Math.round((r.duration_ms || 0) / 1000) + 's');
      const u = r.usage || {};
      if (u.input_tokens != null) parts.push('↑' + (metered ? '' : '~') + fmtTok(u.input_tokens) + ' ↓' + (metered ? '' : '~') + fmtTok(u.output_tokens));
    }
    chat.statusLine.textContent = parts.join('  ·  ');
    if (chat.init) {
      const auth = chat.init.apiKeySource;
      // The key lives in cce's own store now (authType/authHint), so the old
      // flags were false and a working provider read "no auth — /login".
      const keyProvider = !!(chat.provider && (chat.provider.hasApiKey || chat.provider.hasAuthToken
        || chat.provider.authType || chat.provider.authHint || chat.provider.baseUrl));
      const mAuth = auth === 'none'
        ? (keyProvider ? 'provider key' : 'no auth — /login in a terminal tab')
        : auth;
      chat.statusRight.textContent = (chat.init.model || '') + ' · ' + mAuth;
      chat.providerEl.textContent = chat.provider ? basename(chat.provider.name) : 'default env';
    }
  }
  const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

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
        if (msg.subtype === 'init') { chat.init = msg; onInit(chat); }
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
    chat.msgs.appendChild(el('div', 'sys-note warn',
      CCEIcons.svg('error', 13) + ' ' + String(msg.tool_name || 'tool') + ' denied: ' + String(reason).slice(0, 200)));
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
    const engineMode = s.permission_mode ? uiMode(s.permission_mode, chat.provider) : null;
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

  /* ---------------- output styles (#feat-output-styles) ---------------- */

  async function fillStyles(chat) {
    if (chat.stylesFilled || !chat.alive) return;
    chat.stylesFilled = true;
    let r = null;
    try { r = await ccx.invoke('chat:styles', { id: chat.id }); } catch { r = null; }
    const list = (r && r.ok && r.styles) || [];
    if (!list.length) {
      // Right after init the engine may not answer yet: one retry, not a
      // picker that stays hidden for the whole session.
      if (!chat.stylesRetried) {
        chat.stylesRetried = true;
        chat.stylesFilled = false;
        setTimeout(() => fillStyles(chat), 3000);
      }
      return;
    }
    chat.styleSel.innerHTML = '';
    const auto = el('option', '', 'style: auto'); auto.value = '';
    chat.styleSel.appendChild(auto);
    for (const s of list) { const o = el('option', '', 'style: ' + s); o.value = s; chat.styleSel.appendChild(o); }
    chat.styleSel.classList.remove('hidden');
  }

  function onInit(chat) {
    chat.msgs.querySelector('.chat-empty')?.remove();
    fillStyles(chat);
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
  const INSTALL_CMD = {
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
    const bad = servers.filter(s => s.status !== 'connected');
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

  function clearLive(chat, parentId) {
    const key = parentId || 'main';
    const live = chat.lives && chat.lives.get(key);
    if (!live) return;
    // Paint the last coalesced delta out fully before the finalized blocks
    // replace these — otherwise a short reply can lose its final sentence.
    for (const [, b] of live.blocks) if (b.type === 'text' && b.text) flushMarkdown(b);
    for (const [, b] of live.blocks) { b.node && b.node.remove(); b.think && b.think.remove(); }
    chat.lives.delete(key);
  }

  /** JSON.parse that returns null instead of throwing on partial input. */
  function tryJson(s) {
    try { return JSON.parse(s || '{}'); } catch { return null; }
  }

  // Re-parsing markdown on every streamed token is O(n^2) and visibly stutters
  // on long answers. Coalesce to one render per frame. #21
  // Tokens can arrive far faster than the screen refreshes. Re-parsing the whole
  // growing markdown on every rAF is the transcript's hot path — measured at
  // 124ms mean / 290ms p95 per delta at ~150 rows before coalescing commits.
  // Commit at most every STREAM_COMMIT_MS, and always flush at message_stop so
  // the last delta is never dropped. #51
  const STREAM_COMMIT_MS = 50;

  function scheduleMarkdown(blk) {
    if (blk._raf) return;
    const paint = (final) => {
      blk._raf = null; blk._timer = null;
      const cut = splitThink(blk.text);
      blk.body.innerHTML = md(cut.text);
      // Copy buttons and syntax colours are only worth the work once the block
      // stops growing — a user cannot copy a half-written reply.
      if (final) enhanceMarkdown(blk.body, cut.text);
      if (cut.thinking) {
        // The reply opened with reasoning: fold it away above the answer.
        if (!blk.think) { blk.think = thoughtNode(''); blk.node.before(blk.think); }
        blk.think.querySelector('.think-body').textContent = cut.thinking;
      }
    };
    // First delta paints immediately so the reply appears at once; after that,
    // coalesce. rAF alone still allows ~60 commits/second.
    if (!blk._painted) { blk._painted = true; blk._raf = requestAnimationFrame(() => paint(false)); return; }
    blk._timer = setTimeout(() => { blk._raf = requestAnimationFrame(() => paint(false)); }, STREAM_COMMIT_MS);
  }

  /** Force the pending streaming paint out now, fully enhanced. */
  function flushMarkdown(blk) {
    if (!blk) return;
    if (blk._timer) { clearTimeout(blk._timer); blk._timer = null; }
    if (blk._raf) { cancelAnimationFrame(blk._raf); blk._raf = null; }
    const cut = splitThink(blk.text);
    blk.body.innerHTML = md(cut.text);
    enhanceMarkdown(blk.body, cut.text);
    if (cut.thinking) {
      if (!blk.think) { blk.think = thoughtNode(''); blk.node.before(blk.think); }
      blk.think.querySelector('.think-body').textContent = cut.thinking;
    }
  }

  function ensureLive(chat, parentId) {
    chat.lives ??= new Map();
    const key = parentId || 'main';
    if (!chat.lives.get(key)) chat.lives.set(key, { blocks: new Map(), tools: new Map() });
    return chat.lives.get(key);
  }

  function handleStream(chat, event, parentId) {
    if (!event) return;
    const live = ensureLive(chat, parentId);
    const host = nestedTarget(chat, parentId) || chat.msgs;
    chat.msgs.querySelector('.chat-empty')?.remove();
    switch (event.type) {
      case 'content_block_start': {
        const b = event.content_block || {};
        let entry;
        if (b.type === 'text') {
          const node = el('div', 'msg assistant-msg live' + (parentId ? ' nested' : ''));
          const body = el('div', 'md');
          node.appendChild(body);
          entry = { type: b.type, node, body, text: '' };
        } else if (b.type === 'thinking') {
          const node = buildThinking('Thinking…');
          entry = { type: b.type, node, body: node.querySelector('.think-body'), text: '', t0: Date.now() };
        } else if (b.type === 'tool_use') {
          const card = makeToolCard(chat, b.id, b.name, {}, parentId);
          if (card.earlyResolved) card.setStatus(card.isError ? 'err' : 'done');
          else card.setStatus('running', 'preparing…');
          entry = { type: b.type, node: card.card, toolId: b.id, text: '', json: '', card };
          // Track the live card so content_block_delta can fill in its input as
          // it streams. It was never stored, so a streaming tool call showed
          // "preparing…" forever and the live plan viewer never filled. #4
          live.tools.set(b.id, card);
          if (b.name === 'ExitPlanMode') openPlanViewer(chat);
        } else return;
        live.blocks.set(event.index, entry);
        host.appendChild(entry.node);
        if (!parentId) scrollDownSoft(chat);
        break;
      }
      case 'content_block_delta': {
        const blk = live.blocks.get(event.index);
        if (!blk) return;
        const d = event.delta || {};
        if (d.type === 'text_delta') { blk.text += d.text; scheduleMarkdown(blk); }
        else if (d.type === 'thinking_delta') {
          blk.text += d.thinking || '';
          blk.body.textContent = blk.text;
          const pill = blk.node.querySelector('.think-pill');
          if (pill) setPill(pill, 'Thinking… ' + ((Date.now() - blk.t0) / 1000).toFixed(0) + 's');
        } else if (d.type === 'input_json_delta') {
          blk.json += d.partial_json || '';
          const card = live.tools.get(blk.toolId);
          // Feed the card progressively so a long Bash command appears while it
          // streams instead of only at the end.
          if (card) {
            const partial = tryJson(blk.json);
            if (partial) {
              card.input = partial;
              if (card.name !== 'ExitPlanMode') card.title.textContent = toolTitle(card.name, partial);
              if (card.name === 'ExitPlanMode') updatePlanViewer(chat, blk.json);
            } else card.setStatus('running', 'preparing…');
          }
        }
        scrollDownSoft(chat);
        break;
      }
      case 'content_block_stop': {
        const blk = live.blocks.get(event.index);
        if (!blk) return;
        if (blk.type === 'tool_use') {
          const card = live.tools.get(blk.toolId);
          if (card) {
            card.setInput(tryJson(blk.json) || {});
            card.setStatus('running');
          }
        } else if (blk.type === 'thinking') {
          const secs = ((Date.now() - (blk.t0 || Date.now())) / 1000).toFixed(0);
          const pill = blk.node.querySelector('.think-pill');
          if (pill) setPill(pill, 'Thought for ' + secs + 's');
          blk.node.open = false;   // collapse into the desktop-style summary pill
        }
        break;
      }
      case 'message_stop': clearLive(chat, parentId); break;
      default: break;
    }
  }

  /** A collapsed, finished thought, labelled with its opening line so a run of
   *  them says something instead of repeating "click to view". */
  function thoughtNode(text) {
    const gist = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 110);
    const d = buildThinking(gist ? 'Thought · ' + gist + (String(text).length > 110 ? '…' : '') : 'Thought');
    d.querySelector('.think-body').textContent = text;
    d.open = false;
    return d;
  }

  // Icon markup, then the label as text: the label can carry model output, and
  // assigning the SVG through textContent showed raw <svg …> in the pill.
  function setPill(pill, label) {
    pill.innerHTML = CCEIcons.svg('thought', 13);
    pill.appendChild(document.createTextNode(' ' + label));
  }

  function buildThinking(label) {
    const d = el('details', 'thinking-block');
    d.open = true;
    const s = el('summary');
    const pill = el('span', 'think-pill');
    setPill(pill, label);
    s.appendChild(pill);
    d.appendChild(s);
    d.appendChild(el('div', 'think-body'));
    return d;
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

  function renderBlock(chat, block, parentId) {
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
    } else if (block.type === 'thinking') {
      if (!block.thinking) return;
      host.appendChild(thoughtNode(block.thinking));
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

  function makeToolCard(chat, toolUseId, name, input, parentId) {
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
        if (note) title.textContent = note + ' — ' + toolTitle(name, ctx.input);
        else title.textContent = toolTitle(name, ctx.input);
        if (status === 'done' || status === 'err') renderOutput(chat, toolUseId);
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
    head.addEventListener('click', () => {
      const opening = body.classList.contains('hidden');
      body.classList.toggle('hidden');
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
      const oldest = chat.tools.keys().next().value;
      chat.tools.delete(oldest);
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
  function applyLiveOutput(chat, toolUseId, text, done) {
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
    out.textContent = ctx.liveText.slice(0, 8000);
  }

  /**
   * The unfiltered text of a result the main process compacted for the model.
   * The card shows this one — the model saw the short version. #feat-output-filter
   */
  function storeToolOriginal(chat, toolUseId, text) {
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
  function renderTodos(chat, input) {
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
  function seedTodosFromPrompt(text) {
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

  function parseTodoChecklist(text) {
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
  const clearTodos = (chat) => setTodos(chat, []);

  function renderTodoItems(chat, items) {
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
  function renderDiff(name, input, source) {
    const [orig, mod] = diffPair(name, input, source);
    const wrap = el('div', 'monaco-diff pending');
    wrap.__diffData = { name, input, source };
    wrap.appendChild(el('div', 'hint', 'click the card header to show the diff'));
    wrap.__init = () => {
      if (!wrap.__init) return;
      wrap.__init = null;
      wrap.classList.remove('pending');
      if (!window.monaco || !window.monaco.editor) { renderTextDiff(wrap, name, input); return; }
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

  function resolveToolResult(chat, block) {
    const ctx = chat.tools.get(block.tool_use_id);
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
    out.textContent = String(text).slice(0, 8000);
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

  /* ---------------- permissions ---------------- */

  const fmtDur = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  // Live countdown per card. An unanswered request auto-denies, so say so
  // instead of letting the card sit until the engine gives up. One interval per
  // card: a shared timer cancelled whichever card was answered. #2
  function startPermCountdown(chat, card, head, evt) {
    if (!evt.expiresAt) return;
    const cd = el('span', 'perm-countdown', '');
    head.appendChild(cd);
    const timer = setInterval(() => {
      const left = evt.expiresAt - Date.now();
      if (left <= 0) {
        clearInterval(timer);
        card.remove();
        chat.permCount = Math.max(0, (chat.permCount || 1) - 1);
        updatePermBadge(chat);
        toast('Permission request timed out — auto-denied', 'err');
        return;
      }
      cd.textContent = '⏳ auto-deny in ' + fmtDur(left);
    }, 1000);
    timer.unref && timer.unref();
    card.dataset.timer = '1';
    card._permTimer = timer;
    cd.textContent = '⏳ auto-deny in ' + fmtDur(Math.max(0, evt.expiresAt - Date.now()));
  }

  /** Stop a card's countdown. Takes the card, not the chat. */
  function endPermCountdown(card) {
    if (card && card._permTimer) {
      clearInterval(card._permTimer);
      card._permTimer = null;
    }
  }

  function clearPermission(chat, requestId, note) {
    // Remove every card whose id matches (or all, when no id is given).
    const cards = [...chat.permSlot.querySelectorAll('.perm-card')];
    let removed = 0;
    for (const card of cards) {
      if (requestId && card.dataset.rid !== requestId) continue;
      endPermCountdown(card);
      card.remove();
      removed++;
      chat.permCount = Math.max(0, (chat.permCount || 0) - 1);
    }
    if (removed) updatePermBadge(chat);
    if (note && removed) toast(note, 'err');
  }

  function showPermission(chat, evt) {
    // Do NOT clear the slot: several requests can be pending at once (parallel
    // tool calls, subagents) and the old single-card behaviour dropped all but
    // the last, leaving the rest to time out. Each card owns its own timer. #2
    const { requestId, toolName, input = {} } = evt;
    if (toolName === 'AskUserQuestion') return showAskQuestion(chat, evt);
    chat.permCount = (chat.permCount || 0) + 1;
    updatePermBadge(chat);
    const card = el('div', 'perm-card' + (toolName === 'ExitPlanMode' ? ' plan' : ''));
    card.dataset.rid = requestId;
    const head = el('div', 'perm-head');
    head.appendChild(elIcon('span', 'tool-ico', toolIcon(toolName)));

    // Use the engine's own prompt sentence when it sends one; only fall back to
    // reconstructing from the tool name. #28
    const title = evt.title || ('Claude wants to use ' + toolName);
    const t = el('span', '', '');
    t.appendChild(el('b', '', title));
    head.appendChild(t);
    if (chat.permCount > 1) head.appendChild(el('span', 'chip', chat.permCount + ' pending'));
    card.appendChild(head);

    if (toolName === 'ExitPlanMode') {
      const planBody = el('div', 'perm-plan md');
      planBody.innerHTML = md(input.plan || '(no plan text)');
      card.appendChild(planBody);
    } else {
      if (evt.description) card.appendChild(el('div', 'perm-desc', evt.description));
      if (evt.decisionReason) card.appendChild(el('div', 'hint', 'why: ' + evt.decisionReason));
      if (evt.blockedPath) card.appendChild(el('div', 'hint', 'blocked path: ' + evt.blockedPath));
      card.appendChild(renderToolInput(toolName, input));
      if (Array.isArray(evt.suggestions) && evt.suggestions.length) {
        card.appendChild(el('div', 'hint', 'Session rule: ' + describeSuggestions(evt.suggestions)));
      }
    }

    startPermCountdown(chat, card, head, evt);
    const actions = el('div', 'perm-actions');
    const setMode = async (mode) => {
      const r = await ccx.invoke('chat:set-mode', { id: chat.id, mode });
      if (r.ok) {
        chat.mode = uiMode(r.permissionMode || mode, chat.provider);
        chat.modeSel.value = chat.mode;
        toast('Mode → ' + modeLabel(chat.mode), 'ok');
      }
    };
    const finish = () => {
      card.remove();
      chat.permCount = Math.max(0, (chat.permCount || 1) - 1);
      updatePermBadge(chat);
    };
    const mk = (label, cls, decision, afterMode, tip) => {
      const b = el('button', 'btn ' + cls, label);
      if (tip) b.title = tip;
      b.addEventListener('click', async () => {
        finish();
        const r = await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision });
        if (!r || !r.ok) { toast((r && r.error) || 'failed to send permission answer', 'err'); setBusy(chat, false); return; }
        if (afterMode) await setMode(afterMode);
        setBusy(chat, true);
      });
      return b;
    };
    if (toolName === 'ExitPlanMode') {
      actions.appendChild(mk('✓ approve + accept edits', 'primary', 'allow', 'acceptEdits'));
      // auto is only offered where its classifier can work (Anthropic's own API).
      if (modeAutoOk(chat.provider)) actions.appendChild(mk('✓ approve + auto', '', 'allow', 'auto'));
      // Keep planning, with a way to say why: the deny message reaches the
      // model, so the desktop app's "keep planning" is really feedback. #40
      const feedback = el('input', 'perm-feedback');
      feedback.type = 'text';
      feedback.placeholder = 'Keep planning — what should change? (optional)';
      actions.appendChild(feedback);
      const keep = el('button', 'btn', '✗ keep planning');
      keep.addEventListener('click', async () => {
        const why = feedback.value.trim();
        finish();
        const r = await ccx.invoke('chat:permission-answer', {
          id: chat.id, requestId, decision: 'deny',
          message: why || 'Keep planning. Do not start implementing yet.',
        });
        if (!r || !r.ok) { toast((r && r.error) || 'failed to send permission answer', 'err'); setBusy(chat, false); return; }
        setBusy(chat, true);
      });
      actions.appendChild(keep);
    } else {
      actions.appendChild(mk('Allow once', 'primary', 'allow', null,
        'Approve just this call. Nothing else is remembered.'));
      // Only offer the persistent choice when the engine gave a scoped rule for
      // it; a bare toolName rule would approve every future use. #3
      if (!evt.suppressAlwaysAllowRule && Array.isArray(evt.suggestions) && evt.suggestions.length) {
        actions.appendChild(mk('Allow for this session', '', 'always', null,
          'Adds: ' + describeSuggestions(evt.suggestions)));
      }
      actions.appendChild(mk('Deny', 'danger', 'deny'));
    }
    card.appendChild(actions);
    chat.permSlot.appendChild(card);
    card.scrollIntoView({ block: 'nearest' });
  }

  /** Human summary of what "always allow" will actually grant. #28 */
  function describeSuggestions(suggestions) {
    const parts = [];
    for (const s of suggestions.slice(0, 2)) {
      for (const r of (s.rules || [])) {
        parts.push(r.ruleContent ? r.toolName + ' ' + r.ruleContent : r.toolName);
      }
    }
    return parts.join(' · ') || 'this tool';
  }

  /** Readable summary of a tool's input instead of a raw JSON dump. #28 */
  function renderToolInput(toolName, input) {
    const wrap = el('div', 'perm-tool-input');
    // A connector call carries a URL, and that URL can carry a credential.
    // The card is what the user screenshots, so the secret is masked here.
    // #p5-connector-url
    const shown = (window.CCESecrets && window.CCESecrets.maskToolInput)
      ? window.CCESecrets.maskToolInput(input)
      : input;
    if (toolName === 'Bash' && input.command) {
      // The command is the whole point of the prompt: show it large, not as JSON.
      wrap.appendChild(el('pre', 'perm-command mono', String(input.command).slice(0, 2000)));
      if (input.description) wrap.appendChild(el('div', 'hint', input.description));
    } else if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) && input.file_path) {
      wrap.appendChild(el('div', 'perm-path mono', String(input.file_path)));
    } else if ((toolName === 'Grep' || toolName === 'Glob') && input.pattern) {
      wrap.appendChild(el('div', 'perm-path mono', String(input.pattern)));
    } else if (toolName === 'WebFetch' && input.url) {
      wrap.appendChild(el('div', 'perm-path mono', String(shown.url || input.url)));
    }
    const det = el('details', 'tool-json');
    det.appendChild(el('summary', '', 'raw input'));
    det.appendChild(el('pre', 'tool-io mono', (JSON.stringify(shown == null ? {} : shown, null, 2) || '{}').slice(0, 1200)));
    wrap.appendChild(det);
    return wrap;
  }

  function updatePermBadge(chat) {
    const n = chat.permCount || 0;
    chat.permSlot.classList.toggle('has-many', n > 1);
    if (n > 1) {
      chat.permSlot.title = n + ' permission requests pending — each needs its own answer';
    } else {
      chat.permSlot.removeAttribute('title');
    }
    publishTabState(chat);   // a pending prompt is what "waiting on you" means
  }

  // AskUserQuestion arrives as a permission request, but it is a question, not
  // an action: draw real options and send the picked labels back as answers.
  // The engine reads them from updatedInput.answers, keyed by question text.
  function showAskQuestion(chat, evt) {
    const { requestId, input = {} } = evt;
    // Counted like any other pending card so the badge and "N pending" chip
    // stay truthful while a question is on screen.
    chat.permCount = (chat.permCount || 0) + 1;
    updatePermBadge(chat);
    const qs = Array.isArray(input.questions) ? input.questions : [];
    const answers = {};
    const card = el('div', 'perm-card ask');
    const head = el('div', 'perm-head');
    head.appendChild(elIcon('span', 'tool-ico', toolIcon('AskUserQuestion')));
    const t = el('span', '', '');
    t.innerHTML = '<b>Claude has questions</b> — answer to continue';
    head.appendChild(t);
    card.appendChild(head);

    qs.forEach((q) => {
      const box = el('div', 'ask-q');
      if (q.header) box.appendChild(el('span', 'ask-chip', q.header));
      box.appendChild(el('div', 'ask-text', q.question));
      const opts = Array.isArray(q.options) ? q.options : [];
      if (!opts.length) {
        // free-form question (text/number kind) — no option list
        const inp = el('input', 'ask-input');
        inp.type = q.kind === 'number' ? 'number' : 'text';
        inp.placeholder = q.placeholder || 'Type your answer';
        inp.addEventListener('input', () => {
          const v = inp.value.trim();
          if (v) answers[q.question] = v; else delete answers[q.question];
          sync();
        });
        box.appendChild(inp);
      } else {
        const row = el('div', 'ask-opts');
        opts.forEach((o) => {
          const b = el('button', 'ask-opt');
          b.appendChild(el('b', '', o.label));
          if (o.description) b.appendChild(el('span', '', o.description));
          if (o.preview) {
            const det = el('details', 'ask-preview');
            det.appendChild(el('summary', '', 'preview'));
            det.appendChild(el('pre', '', String(o.preview).slice(0, 1500)));
            det.addEventListener('click', (e) => e.stopPropagation());
            b.appendChild(det);
          }
          b.addEventListener('click', () => {
            if (q.multiSelect) {
              const cur = Array.isArray(answers[q.question]) ? answers[q.question] : [];
              const i = cur.indexOf(o.label);
              if (i >= 0) cur.splice(i, 1); else cur.push(o.label);
              if (cur.length) answers[q.question] = cur; else delete answers[q.question];
              b.classList.toggle('sel', i < 0);
            } else {
              answers[q.question] = o.label;
              row.querySelectorAll('.ask-opt').forEach(x => x.classList.remove('sel'));
              b.classList.add('sel');
            }
            sync();
          });
          row.appendChild(b);
        });
        box.appendChild(row);
      }
      card.appendChild(box);
    });

    const actions = el('div', 'perm-actions');
    const send = el('button', 'btn primary', 'Send answers');
    const skip = el('button', 'btn danger', 'Skip');
    const sync = () => { send.disabled = qs.some(q => answers[q.question] === undefined); };
    const finish = () => {
      endPermCountdown(card);
      card.remove();
      chat.permCount = Math.max(0, (chat.permCount || 1) - 1);
      updatePermBadge(chat);
    };
    card.dataset.rid = requestId;
    startPermCountdown(chat, card, head, evt);
    send.addEventListener('click', async () => {
      finish();
      const r = await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision: 'allow', answers });
      if (!r || !r.ok) { toast((r && r.error) || 'failed to send answers', 'err'); setBusy(chat, false); return; }
      setBusy(chat, true);
    });
    skip.addEventListener('click', async () => {
      finish();
      const r = await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision: 'deny' });
      if (!r || !r.ok) { toast((r && r.error) || 'failed to send answers', 'err'); setBusy(chat, false); return; }
      setBusy(chat, true);
    });
    actions.appendChild(send);
    actions.appendChild(skip);
    card.appendChild(actions);
    sync();
    chat.permSlot.appendChild(card);
    card.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- MCP elicitation cards (#feat-elicitation) ----------------
     Connectors ask for input mid-call: 'url' mode = open this URL and
     authorize; 'form' mode = structured fields from the server's JSON schema.
     The main process parks the SDK callback until the card is answered. */

  // A connector prompt blocks the turn like a permission does, so it counts
  // toward the tab's "needs you" state; a background chat used to time out on it
  // unnoticed.
  function dropElicCard(chat, card) {
    if (!card.isConnected) return;
    card.remove();
    chat.elicCount = Math.max(0, (chat.elicCount || 1) - 1);
    publishTabState(chat);
  }

  function clearElicitation(chat, requestId, note) {
    for (const card of chat.permSlot.querySelectorAll('.elic')) {
      if (card.dataset.rid !== requestId) continue;
      dropElicCard(chat, card);
      if (note) {
        const n = el('div', 'sys-note', note);
        chat.msgs.appendChild(n);
        scrollDownSoft(chat);
      }
      return;
    }
  }

  function showElicitation(chat, evt) {
    const card = el('div', 'perm-card elic');
    card.dataset.rid = evt.requestId;
    card.dataset.elid = evt.elicitationId || '';
    const head = el('div', 'perm-head');
    head.appendChild(elIcon('span', 'tool-ico', toolIcon('mcp__connector')));
    const t = el('span', '');
    t.innerHTML = '<b>' + esc(evt.displayName || evt.serverName || 'connector') + '</b> wants to connect';
    head.appendChild(t);
    card.appendChild(head);
    if (evt.message) card.appendChild(el('div', 'elic-msg', evt.message));
    if (evt.description) card.appendChild(el('div', 'hint', evt.description));

    const collect = () => {   // form-mode: read inputs into the accept payload
      const out = {};
      for (const inp of card.querySelectorAll('[data-key]')) {
        const key = inp.dataset.key;
        if (inp.type === 'checkbox') out[key] = inp.checked;
        else if (inp.value !== '') out[key] = inp.type === 'number' ? Number(inp.value) : inp.value;
      }
      return out;
    };

    const answer = async (action) => {
      dropElicCard(chat, card);
      const r = await ccx.invoke('chat:elicit-answer', {
        id: chat.id, requestId: evt.requestId, action,
        content: action === 'accept' ? collect() : undefined,
      }).catch(() => null);
      if (!r || !r.ok) toast((r && r.error) || 'failed to answer connector prompt', 'err');
    };

    if (evt.mode === 'url') {
      // OAuth handshake: open the URL in the real browser; the connector
      // resolves once the user finishes there.
      const row = el('div', 'perm-actions');
      const open = el('button', 'btn primary', 'Open authorization page');
      open.addEventListener('click', () => ccx.invoke('shell:openExternal', { url: evt.url }));
      if (evt.url) open.title = evt.url;
      const done = el('button', 'btn', 'I have authorized');
      done.addEventListener('click', () => answer('accept'));
      const no = el('button', 'btn danger', 'Decline');
      no.addEventListener('click', () => answer('decline'));
      const cancel = el('button', 'btn ghost', 'Cancel');
      cancel.addEventListener('click', () => answer('cancel'));
      row.appendChild(open); row.appendChild(done); row.appendChild(no); row.appendChild(cancel);
      card.appendChild(row);
      if (evt.url) {
        const u = el('div', 'elic-url mono', evt.url.slice(0, 160));
        u.title = evt.url;
        card.appendChild(u);
      }
    } else {
      // form mode: render the requestedSchema (MCP input schema: object with
      // typed properties) as inputs; only primitive fields are supported.
      const props = (evt.requestedSchema && evt.requestedSchema.properties) || {};
      const required = new Set(Array.isArray(evt.requestedSchema && evt.requestedSchema.required) ? evt.requestedSchema.required : []);
      const fill = el('div', 'elic-form');
      for (const key of Object.keys(props)) {
        const spec = props[key] || {};
        const lab = el('label', 'elic-field');
        lab.appendChild(el('span', 'elic-key', (spec.title || key) + (required.has(key) ? ' *' : '')));
        let inp;
        if (Array.isArray(spec.enum) && spec.enum.length) {
          inp = document.createElement('select');
          inp.appendChild(el('option', '', ''));
          for (const e of spec.enum) { const o = el('option', '', String(e)); o.value = String(e); inp.appendChild(o); }
        } else if (spec.type === 'boolean') {
          inp = el('input'); inp.type = 'checkbox';
        } else if (spec.type === 'number' || spec.type === 'integer') {
          inp = el('input'); inp.type = 'number';
        } else {
          inp = el('input'); inp.type = 'text';
        }
        if (spec.description) inp.placeholder = String(spec.description).slice(0, 80);
        inp.dataset.key = key;
        lab.appendChild(inp);
        fill.appendChild(lab);
      }
      card.appendChild(fill);
      const row = el('div', 'perm-actions');
      const send = el('button', 'btn primary', 'Submit');
      send.disabled = [...card.querySelectorAll('[data-key]')].some(i =>
        required.has(i.dataset.key) && i.type !== 'checkbox' && !i.value);
      send.addEventListener('click', () => answer('accept'));
      const no = el('button', 'btn danger', 'Decline');
      no.addEventListener('click', () => answer('decline'));
      const cancel = el('button', 'btn ghost', 'Cancel');
      cancel.addEventListener('click', () => answer('cancel'));
      row.appendChild(send); row.appendChild(no); row.appendChild(cancel);
      card.appendChild(row);
      fill.addEventListener('input', () => {
        send.disabled = [...fill.querySelectorAll('[data-key]')].some(i =>
          required.has(i.dataset.key) && i.type !== 'checkbox' && !i.value);
      });
    }
    chat.permSlot.appendChild(card);
    chat.elicCount = (chat.elicCount || 0) + 1;
    publishTabState(chat);
    card.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------- find in transcript (#feat-find) ----------------
     Uses the engine's native window.find (Chromium find-in-page) so matches
     highlight across the whole rendered transcript, plus a naive occurrence
     count from the text. */
  function showFind(chat) {
    let bar = chat.pane.querySelector('.chat-find');
    if (!bar) {
      bar = el('div', 'chat-find');
      const inp = el('input');
      inp.type = 'text';
      inp.placeholder = 'find in transcript';
      inp.setAttribute('aria-label', 'Find in transcript');
      const prev = el('button', 'btn small', '◀');
      prev.setAttribute('aria-label', 'Previous match');
      const next = el('button', 'btn small', '▶');
      next.setAttribute('aria-label', 'Next match');
      const count = el('span', 'hint chat-find-count', '');
      const close = el('button', 'btn small', '✕');
      close.setAttribute('aria-label', 'Close find bar');
      const step = (back) => {
        const q = inp.value;
        if (!q) return;
        try { window.find(q, !!back, false, true); } catch { /* empty */ }
        paintCount();
      };
      const paintCount = () => {
        const q = inp.value;
        if (!q) { count.textContent = ''; return; }
        const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let n = 0;
        try { n = (chat.msgs.textContent.match(new RegExp(esc, 'gi')) || []).length; } catch { /* bad regex */ }
        count.textContent = n ? n + ' match' + (n === 1 ? '' : 'es') : 'no matches';
      };
      const hide = () => { bar.classList.add('hidden'); inp.value = ''; paintCount(); };
      inp.addEventListener('input', () => { try { window.find(inp.value, false, false, false); } catch { /* empty */ } paintCount(); });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { step(e.shiftKey); e.preventDefault(); }
        else if (e.key === 'Escape') { hide(); chat.composer.focus(); e.preventDefault(); e.stopPropagation(); }
      });
      [prev, next].forEach((b, i) => b.addEventListener('click', () => step(i === 0)));
      close.addEventListener('click', hide);
      bar.appendChild(inp); bar.appendChild(prev); bar.appendChild(next); bar.appendChild(count); bar.appendChild(close);
      chat.pane.appendChild(bar);
    }
    bar.classList.remove('hidden');
    const inp = bar.querySelector('input');
    inp.focus();
    inp.select();
  }

  function appendError(chat, text) {
    const m = String(text || '');
    const ctx = m.match(/exceeds the available context size \((\d+)\s*tokens\)/i);
    const need = m.match(/request \((\d+)\s*tokens\)/i);
    const e = el('div', 'msg error-msg');
    e.appendChild(el('div', '', '⚠ ' + m.slice(0, 260)));
    if (ctx) {
      const g = el('div', 'ctx-guide');
      g.appendChild(el('div', 'hint', `This model serves only ${Number(ctx[1]).toLocaleString()} tokens of context, but the claude engine's base prompt (your skills + plugins) needs ${Number(need ? need[1] : 0).toLocaleString()}. Options: pick a ≥128K-context model (gpt-oss:120b-cloud / nemotron-3-*), load a bigger local model via the ⚙ manager, or disable some plugins to shrink the base prompt.`));
      const row = el('div', 'perm-actions');
      const sw = el('button', 'btn small primary', 'Switch to gpt-oss:120b-cloud');
      sw.addEventListener('click', () => {
        switchModel(chat, 'gpt-oss:120b-cloud').then(() => {
          if (![...chat.modelSel.options].some(o => o.value === 'gpt-oss:120b-cloud')) {
            const o = el('option', '', 'gpt-oss:120b-cloud'); o.value = 'gpt-oss:120b-cloud';
            chat.modelSel.insertBefore(o, chat.modelSel.querySelector('[value="__custom"]'));
          }
          chat.modelSel.value = 'gpt-oss:120b-cloud';
        });
      });
      row.appendChild(sw);
      const mgr = el('button', 'btn small', '⚙ model manager');
      mgr.addEventListener('click', () => { if (window.openOllamaManager && chat.provider) window.openOllamaManager(chat.provider); });
      row.appendChild(mgr);
      g.appendChild(row);
      e.appendChild(g);
    }
    chat.msgs.appendChild(e);
    scrollDownSoft(chat);
  }

  /* ---------------- slash palette ---------------- */

  // Handled by cce itself, so they work before the engine has said anything.
  const OWN_SLASH = [
    { name: 'compact', description: 'Summarise the conversation and carry on in a fresh session' },
    { name: 'clear', description: 'Start a fresh session in this folder' },
    { name: 'cost', description: 'Tokens and cost so far' },
    { name: 'model', description: 'Switch model' },
    { name: 'help', description: 'What cce can do here' },
  ];

  /**
   * Every command the session offers, with descriptions. The engine only lists
   * them in its first reply, so a fresh chat showed nothing for "/": ask the
   * session directly instead, once.
   */
  async function loadSlashCommands(chat) {
    if (chat.slashCatalog) return chat.slashCatalog;
    if (!chat.slashLoading) {
      chat.slashLoading = (async () => {
        let live = [];
        try {
          const r = await ccx.invoke('chat:commands', { id: chat.id });
          if (r && r.ok) live = (r.commands || []).map(c => (typeof c === 'string' ? { name: c } : c));
        } catch { /* fall back to the init list */ }
        if (!live.length) live = (chat.commands || []).map(name => ({ name }));
        const seen = new Set();
        chat.slashCatalog = OWN_SLASH.concat(live).filter(c => c && c.name && !seen.has(c.name) && seen.add(c.name));
        chat.slashLoading = null;
        return chat.slashCatalog;
      })();
    }
    return chat.slashLoading;
  }

  async function maybeSlash(chat) {
    const v = chat.composer.value;
    if (!(v.startsWith('/') && !v.includes(' '))) return hideSlash(chat);
    const all = await loadSlashCommands(chat);
    // The user may have typed on while the list loaded.
    const now = chat.composer.value;
    if (!(now.startsWith('/') && !now.includes(' '))) return hideSlash(chat);
    const q = now.slice(1).toLowerCase();
    const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
    const contains = q ? all.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : [];
    chat.slashItems = starts.concat(contains).slice(0, 14);
    if (!chat.slashItems.length) return hideSlash(chat);
    if (chat.slashIdx < 0 || chat.slashIdx >= chat.slashItems.length) chat.slashIdx = 0;
    renderSlash(chat);
  }

  function renderSlash(chat) {
    chat.slash.innerHTML = '';
    chat.slashItems.forEach((c, i) => {
      const item = el('div', 'slash-item' + (i === chat.slashIdx ? ' sel' : ''));
      item.appendChild(el('span', 'slash-name', '/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : '')));
      if (c.description) item.appendChild(el('span', 'slash-desc', c.description));
      item.addEventListener('mousedown', (e) => { e.preventDefault(); chat.slashIdx = i; applySlash(chat); });
      chat.slash.appendChild(item);
    });
    chat.slash.classList.remove('hidden');
  }
  function moveSlash(chat, d) {
    if (!chat.slashItems.length) return;
    chat.slashIdx = (chat.slashIdx + d + chat.slashItems.length) % chat.slashItems.length;
    renderSlash(chat);
  }
  function applySlash(chat) {
    const c = chat.slashItems[chat.slashIdx >= 0 ? chat.slashIdx : 0];
    if (c) { chat.composer.value = '/' + c.name + ' '; chat.composer.focus(); }
    hideSlash(chat);
  }
  function hideSlash(chat) { chat.slash.classList.add('hidden'); chat.slashIdx = -1; }

  // The composer auto-expands as new lines are formed (matching Claude Code Desktop)
  // up to max height, with scrolling once cap is exceeded.
  const ONE_LINE = 20;   // one line of text (line-height); the box adds the margin
  function autosize(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    const lines = (ta.value || '').split('\n').length;
    // In jsdom or before layout, scrollHeight is 0: estimate from line count if scrollHeight <= ONE_LINE
    const full = Math.max(ta.scrollHeight || 0, lines * ONE_LINE);
    const maxHeight = Math.min(320, Math.max(160, Math.round((window.innerHeight || 800) * 0.35)));
    const h = Math.min(maxHeight, Math.max(ONE_LINE, full));
    ta.style.height = h + 'px';
    ta.style.overflowY = full > maxHeight ? 'auto' : 'hidden';
  }
  function setExpanded(chat, on) {
    // Kept as no-op for backward compatibility
  }

  /* ---------------- global event wiring ---------------- */

  // Anchor interception: a markdown link opens externally instead of replacing
  // the app with a web page. #6 (main.js also blocks navigation; this is the
  // renderer half so the click feels immediate.)
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    ccx.invoke('shell:openExternal', { url: href });
  });

  if (window.ccx && window.ccx.onChatEvent) {
    window.ccx.onChatEvent((evt) => {
      try { handleEvent(evt); } catch (err) { console.error('chat render error', err); }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // A palette, find bar or dialog that already handled Escape must not
      // also interrupt the running turn.
      if (e.defaultPrevented) return;
      // The Conversations dropdown outranks everything: close it, don't stop the turn.
      const drop = document.querySelector('#convo-drop');
      if (drop && !drop.classList.contains('hidden')) return;
      for (const [, chat] of chats) {
        if (chat.pane.classList.contains('active')) {
          const panel = chat.pane.querySelector('.chat-skills-panel');
          if (panel) { panel.remove(); return; }
          if (!chat.permSlot.querySelector(".perm-card:not(.elic)") && chat.busy && !e.shiftKey) {
            ccx.invoke('chat:interrupt', { id: chat.id });
          }
        }
      }
    }
  });

  const toggleExpanded = (chat) => {
    if (chat && chat.composer) chat.composer.focus();
  };

  return { createSession, handleEvent, chats, closeChat, activateChat, showFind, openPalette, toggleExpanded, fixNestedFences, pollContext, renderDiff };
})();
