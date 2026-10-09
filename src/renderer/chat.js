// Claude Code Enhanced — chat tabs powered by the Claude Agent SDK.
// Renders the same message stream the Claude Code desktop app shows:
// streaming text/thinking, tool cards, diffs, todos, permissions,
// plan approval, slash-command palette, model + mode selectors, skills.
'use strict';

const Chat = (() => {
  const chats = new Map(); // id -> chat view state

  const md = (text) => {
    try {
      let html = DOMPurify.sanitize(marked.parse(text || '', { breaks: true, gfm: true }));
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

  const TOOL_ICONS = {
    Bash: '❯', Read: '📄', Write: '✏️', Edit: '✏️', MultiEdit: '✏️', NotebookEdit: '📓',
    Grep: '🔍', Glob: '📁', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖', Agent: '🤖',
    TodoWrite: '☑️', ExitPlanMode: '🗺️', Skill: '⚡', AskUserQuestion: '❓',
    BashOutput: '❯', KillShell: '⏹', NotebookRead: '📓',
  };
  function toolIcon(name) {
    if (name && name.startsWith('mcp__')) return '🔌';
    return TOOL_ICONS[name] || '🔧';
  }
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
      default: return mcp ? `${mcp[0]} ▸ ${mcp.slice(1).join('.')}` : name;
    }
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
        <button class="chat-btn chat-mgr-btn hidden" title="Model manager: load / unload, context size, keep-alive">⚙ models</button>
        <button class="chat-btn chat-stop hidden" title="Interrupt (Esc)">■ stop</button>
        <button class="chat-btn chat-cont-btn hidden" title="Continue from where the model stopped — completes remaining work">▶ continue</button>
        <button class="chat-btn hdr-more" title="More actions">⋯</button>
      </div>
      <div class="chat-ctxbar hidden" title="Context window usage"><i></i></div>
      <div class="chat-body">
        <div class="chat-msgs">
          <div class="chat-empty">
            <div class="chat-empty-icon">❯</div>
            <h3>Claude Code</h3>
            <p>Ask anything about this project. Claude can read & edit files, run commands, use skills and MCP tools — you approve each step.</p>
            <p class="chat-empty-hint">Type <b>/</b> for commands · <b>Enter</b> to send · <b>Shift+Enter</b> newline</p>
          </div>
        </div>
        <div class="chat-todos hidden"><h4>todos</h4><ol></ol></div>
      </div>
      <div class="chat-perm-slot"></div>
      <div class="chat-composer">
        <div class="chat-workflows" title="One-click workflows">          <span class="wf-label">workflows</span>
          <button class="wf-chip" data-wf="research">🧭 deep research</button>
          <button class="wf-chip" data-wf="review">🔍 code review</button>
          <button class="wf-chip" data-wf="explain">📚 explain repo</button>
          <button class="wf-chip" data-wf="plan">🗺️ plan feature</button>
          <button class="wf-chip" data-wf="testfix">🧪 test &amp; fix</button>
        </div>
        <div class="chat-imgs hidden"></div>
        <div class="chat-queued hidden"></div>
        <div class="chat-slash hidden"></div>
        <div class="chat-input-row">
          <button class="chat-attach" title="Attach an image or a file">＋</button>
          <textarea class="chat-input" rows="1" placeholder="Ask Claude to work on this project…  (@ mentions files · paste or drop images · ↑ history)"></textarea>
          <button class="chat-send" title="Send (Enter)">➤</button>
        </div>
        <div class="chat-footbar">
          <select class="chat-model-foot" title="Model"></select>
          <select class="chat-mode-foot" title="Permission mode">
            <option value="default">normal</option>
            <option value="acceptEdits">accept edits</option>
            <option value="plan">plan</option>
            <option value="auto">auto</option>
            <option value="bypassPermissions">yolo</option>
          </select>
          <button class="chat-effort" title="Reasoning effort">effort: auto</button>
          <span class="foot-spacer"></span>
          <span class="foot-hint">⏎ send · ⇧⏎ newline · esc stop</span>
        </div>
        <div class="chat-statusline"><span class="sl-left">ready — the session starts with your first message</span><span class="sl-right"></span></div>
      </div>`;

    $('#terminals').appendChild(pane);

    const chat = {
      id, cwd: res.cwd, provider: res.provider, model: res.model || '', mode: res.permissionMode || 'default',
      pane, msgs: pane.querySelector('.chat-msgs'), composer: pane.querySelector('.chat-input'),
      sendBtn: pane.querySelector('.chat-send'), stopBtn: pane.querySelector('.chat-stop'),
      statusLine: pane.querySelector('.chat-statusline .sl-left'),
      statusRight: pane.querySelector('.chat-statusline .sl-right'),
      dot: pane.querySelector('.chat-dot'), providerEl: pane.querySelector('.chat-provider'),
      projEl: pane.querySelector('.chat-project'),
      modelSel: pane.querySelector('.chat-model-foot'), modeSel: pane.querySelector('.chat-mode-foot'),
      effortBtn: pane.querySelector('.chat-effort'), attachBtn: pane.querySelector('.chat-attach'),
      queued: pane.querySelector('.chat-queued'),
      permSlot: pane.querySelector('.chat-perm-slot'), slash: pane.querySelector('.chat-slash'),
      todosEl: pane.querySelector('.chat-todos'), todosList: pane.querySelector('.chat-todos ol'),
      moreBtn: pane.querySelector('.hdr-more'),
      ctxBar: pane.querySelector('.chat-ctxbar'),
      ctxFill: pane.querySelector('.chat-ctxbar i'),
      imgs: pane.querySelector('.chat-imgs'),
      contBtn: pane.querySelector('.chat-cont-btn'),
      init: null, lives: null, tools: new Map(), busy: false, alive: true, dead: false,
      skillsDetail: [], slashIdx: -1, slashItems: [], sandbox: !!res.sandbox,
      pendingImages: [], promptHistory: [], histIdx: -1, filesCache: null,
      titled: false, atMode: false, compacting: false, unread: false,
      permCount: 0, ctxTimer: null, spent: 0, hooks: [], bgTasks: new Map(),
      pendingMsgs: [], effort: '', suggested: false,
      pendingResults: new Map(),
    };
    chats.set(id, chat);
    if (window.__CCE_SMOKE) console.log('[chat-created]', id, 'map size', chats.size);

    // tab
    const tab = el('div', 'tab active');
    tab.appendChild(el('span', '', '⌘ ' + basename(res.cwd)));
    const closeBtn = el('button', 'close', '✕');
    closeBtn.title = 'Close chat';
    tab.appendChild(closeBtn);
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeChat(id); });
    tab.addEventListener('click', () => activateChat(id));
    $('#tabs').appendChild(tab);
    chat.tabEl = tab;

    registerTab(id, { kind: 'chat', pane, tabEl: tab, sessionId: null, cwd: chat.cwd, focus: () => { if (chat.alive) chat.composer.focus(); } });
    // The nav badge counts every open tab, chat tabs included.
    if (typeof window.updateTabCount === 'function') window.updateTabCount();

    // project folder + linked GitHub repo, like the desktop header
    renderProjectInfo(chat);
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
    chat.modeSel.value = chat.mode;
    chat.modelSel.addEventListener('change', async () => {
      if (chat.modelSel.value === '__custom') { openCustomModel(chat); return; }
      await switchModel(chat, chat.modelSel.value);
    });
    chat.modeSel.addEventListener('change', async () => {
      const r = await ccx.invoke('chat:set-mode', { id, mode: chat.modeSel.value });
      if (r.ok) { chat.mode = chat.modeSel.value; toast('Mode → ' + modeLabel(chat.mode), 'ok'); }
      else { toast(r.error, 'err'); chat.modeSel.value = chat.mode; }
    });
    chat.effortBtn.addEventListener('click', () => cycleEffort(chat));
    chat.stopBtn.addEventListener('click', () => ccx.invoke('chat:interrupt', { id }));

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
    pane.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        openPalette(chat);
      }
    });

    // composer
    const send = () => {
      const text = chat.composer.value.trim();
      const blocks = chat.pendingImages.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }));
      if ((!text && !blocks.length) || !chat.alive) return;
      if (text.startsWith('/') && !blocks.length && handleBuiltin(chat, text)) {
        chat.composer.value = '';
        autosize(chat.composer);
        hideSlash(chat);
        return;
      }
      appendUser(chat, text || '(image)');
      if (chat.busy) {
        chat.pendingMsgs.push(text);
        renderQueued(chat);
        chat.msgs.appendChild(el('div', 'sys-note', '↯ steered — Claude will see this mid-turn'));
      }
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
      ccx.invoke('chat:send', { id, text, blocks }).then((r) => {
        if (!r.ok) appendError(chat, 'Session is no longer running — open a new chat (Ctrl+Shift+T). ' + (r.error || ''));
      });
    };
    wireWorkflows(chat, send);
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
    chat.composer.addEventListener('input', () => {
      autosize(chat.composer);
      if (!maybeAt(chat)) maybeSlash(chat);
    });
    chat.sendBtn.addEventListener('click', () => {
      if (chat.busy) ccx.invoke('chat:interrupt', { id });   // button turns into stop
      else send();
    });
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
      if (!chat.slash.classList.contains('hidden')) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(chat, 1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(chat, -1); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && chat.slashItems.length)) {
          e.preventDefault(); (chat.atMode ? applyAt(chat) : applySlash(chat)); return;
        }
        if (e.key === 'Escape') { hideSlash(chat); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    chat.msgs.addEventListener('scroll', () => {}, { passive: true });

    activateChat(id);
    switchView('terminal');
    chat.composer.focus();
    if (opts.initText) {
      setTimeout(() => {
        if (!chat.alive) return;
        appendUser(chat, opts.initText);
        ccx.invoke('chat:send', { id, text: opts.initText });
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
    const top = el('div', 'sys-note', '🕘 previous conversation restored — ' + r.items.length + ' entries');
    chat.msgs.insertBefore(top, chat.msgs.firstChild);
    const items = r.items.slice(-150);
    for (const it of items) {
      if (it.t === 'user') appendUser(chat, it.text);
      else if (it.t === 'assistant') {
        const w = el('div', 'msg assistant-msg');
        const body = el('div', 'md');
        body.innerHTML = md(it.text);
        w.appendChild(body);
        enhanceMarkdown(body, it.text);
        chat.msgs.appendChild(w);
      } else if (it.t === 'thinking') {
        const d = buildThinking('Thought — click to view');
        d.open = false;
        d.querySelector('.think-body').textContent = it.text;
        chat.msgs.appendChild(d);
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
  const modeLabel = (m) => ({ default: 'normal', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto (classifier)', bypassPermissions: 'yolo' }[m] || m);
  const fmtAge = (ms) => {
    const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  };

  function registerTab(id, meta) { if (window.__tabs) window.__tabs.set(id, meta); }
  function activateChat(id) {
    const chat = chats.get(id);
    if (!chat) return;
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
    if (window.__tabs) window.__tabs.delete(id);
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
    chat.queued.innerHTML = '';
    chat.queued.classList.toggle('hidden', !chat.pendingMsgs.length);
    for (const t of chat.pendingMsgs) {
      const chip = el('span', 'queued-chip', t.length > 70 ? t.slice(0, 70) + '…' : t);
      chat.queued.appendChild(chip);
    }
  }

/* ---------------- header overflow menu (#33) ---------------- */

  function wireHeaderMenu(chat, forkConversation) {
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; } };
    const item = (icon, label, run) => {
      const b = el('button', 'chat-menu-item');
      b.appendChild(el('span', '', icon));
      b.appendChild(el('span', '', label));
      b.addEventListener('click', () => { close(); run(); });
      return b;
    };
    chat.moreBtn.addEventListener('click', () => {
      if (menu) return close();
      menu = el('div', 'chat-menu');
      menu.appendChild(item('⚡', 'Skills, commands, agents, hooks', () => toggleSkillsPanel(chat)));
      menu.appendChild(item('⧉', 'MCP servers (live)', () => toggleMcpPanel(chat)));
      menu.appendChild(item('🕘', 'Past conversations', () => toggleHistoryPanel(chat)));
      menu.appendChild(item('⏪', 'Rewind files', () => toggleRewindPanel(chat)));
      menu.appendChild(item('🧠', 'Memory & rules', () => toggleMemoryPanel(chat)));
      menu.appendChild(item('⑂', 'Fork this conversation', forkConversation));
      menu.appendChild(item('⌨', 'Terminal tab in this folder', () => window.createSession({ cwd: chat.cwd, type: 'shell' })));
      menu.appendChild(item('▶', 'Run build / test scripts', () => chat.runBtn.click()));
      menu.appendChild(item('▦', 'Toggle split view', () => window.toggleSplit && window.toggleSplit()));
      if (chat.provider && chat.provider.baseUrl) {
        menu.appendChild(item('⚙', 'Model manager (load / unload)',
          () => (window.ProvidersUI ? ProvidersUI.openLocalManager(chat.provider.baseUrl) : (window.openOllamaManager && window.openOllamaManager(chat.provider)))));
      }
      const rect = chat.moreBtn.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 6) + 'px';
      menu.style.right = '18px';
      menu.style.position = 'fixed';
      document.body.appendChild(menu);
      const away = (e) => { if (!menu.contains(e.target)) { close(); document.removeEventListener('mousedown', away); } };
      setTimeout(() => document.addEventListener('mousedown', away), 0);
    });
  }

  /* ---------------- model selector ---------------- */

  function fillModelSelector(chat) {
    const sel = chat.modelSel;
    sel.innerHTML = '';
    const add = (value, label) => { const o = el('option', '', label); o.value = value; sel.appendChild(o); };
    add('', 'provider default');
    if (chat.provider && chat.provider.model) add(chat.provider.model, chat.provider.model + ' (' + basename(chat.provider.name) + ')');
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
        const o = el('option', '', m.displayName || m.label || id2 + (m.contextWindow ? ' · ' + Math.round(m.contextWindow / 1000) + 'K' : ''));
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
      const folder = el('span', 'proj-chip', '📁 ' + basename(chat.cwd));
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

  async function toggleMemoryPanel(chat) {
    if (chat.pane.querySelector('.chat-memory-panel')) { chat.pane.querySelector('.chat-memory-panel').remove(); return; }
    const panel = el('div', 'chat-skills-panel chat-memory-panel');
    panel.appendChild(el('h4', '', '🧠 Memory & rules'));
    panel.appendChild(el('p', 'hint', 'What the engine loads at session start: CLAUDE.md memory, .claude/rules/*.md, and settings.json hooks. Hooks apply to sessions started after saving.'));
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
    add('panel', '⚡ skills, agents, hooks, tools', '', () => { close(); toggleSkillsPanel(chat); });
    add('panel', '⧉ MCP servers (live)', '', () => { close(); toggleMcpPanel(chat); });
    add('panel', '🕘 past conversations', '', () => { close(); toggleHistoryPanel(chat); });
    add('panel', '⏪ rewind files', '', () => { close(); toggleRewindPanel(chat); });
    add('panel', '🧠 memory & rules', '', () => { close(); toggleMemoryPanel(chat); });
    add('chat', '⑂ fork this conversation', '', () => { close(); chat.forkBtn.click(); });
    add('chat', '⌨ terminal tab in this folder', '', () => { close(); chat.termBtn.click(); });
    add('chat', '✍ summarize session into a handoff brief', '', () => { close(); prefilledSummary(chat); });
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
    let panel = chat.pane.querySelector('.chat-skills-panel');
    if (panel) { panel.remove(); return; }
    panel = el('div', 'chat-skills-panel');
    panel.appendChild(el('h4', '', '⚡ Skills & commands'));
    panel.appendChild(el('p', 'hint', 'Type / in the composer to run a command; skills auto-trigger when a task matches. Click a row to use it. Esc closes.'));

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
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.remove(); });
    render();

    // Memory & rules editor (CLAUDE.md, .claude/rules, settings hooks)
    const memBtn = el('button', 'btn small', '🧠 edit memory & rules');
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
      panel.appendChild(el('h4', '', '⧉ MCP servers'));
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
    if (chat.pane.querySelector('.chat-mcp-panel')) { chat.pane.querySelector('.chat-mcp-panel').remove(); return; }
    const panel = el('div', 'chat-skills-panel chat-mcp-panel');
    panel.appendChild(el('h4', '', '⧉ MCP servers'));
    panel.appendChild(el('p', 'hint', 'Live session status. Disable/enable applies to this session only; ↻ reconnects a failed server. Server config lives in Connectors.'));
    const body = el('div', 'skills-list');
    body.appendChild(el('div', 'hint', 'loading…'));
    panel.appendChild(body);
    const link = el('button', 'btn small', '⚙ open connectors');
    link.addEventListener('click', () => { panel.remove(); switchView('connectors'); });
    panel.appendChild(link);
    chat.pane.appendChild(panel);

    const load = async () => {
      const r = await ccx.invoke('chat:mcp', { id: chat.id, op: 'status' });
      if (!panel.isConnected) return;
      body.innerHTML = '';
      const servers = (r.ok && r.servers) || [];
      if (!servers.length) { body.appendChild(el('div', 'hint', 'No MCP servers in this session.')); return; }
      for (const s of servers) {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', s.name));
        row.appendChild(el('span', 'chip ' + (MCP_CLS[s.status] || ''), s.status));
        if (s.error) row.appendChild(el('span', 'skill-desc', String(s.error).slice(0, 120)));
        const tog = el('button', 'btn small', s.status === 'disabled' ? 'enable' : 'disable');
        tog.addEventListener('click', async () => {
          tog.disabled = true;
          const nr = await ccx.invoke('chat:mcp', { id: chat.id, op: 'toggle', name: s.name, enabled: s.status === 'disabled' });
          if (!nr.ok) { toast(nr.error, 'err'); tog.disabled = false; } else load();
        });
        row.appendChild(tog);
        if (s.status === 'failed' || s.status === 'needs-auth') {
          const rc = el('button', 'btn small', '↻ reconnect');
          rc.addEventListener('click', async () => {
            rc.disabled = true;
            const nr = await ccx.invoke('chat:mcp', { id: chat.id, op: 'reconnect', name: s.name });
            if (!nr.ok) { toast(nr.error, 'err'); rc.disabled = false; } else load();
          });
          row.appendChild(rc);
        }
        body.appendChild(row);
      }
    };
    load();
  }

  /* ---------------- rewind (file checkpoints) ---------------- */

  async function toggleRewindPanel(chat) {
    const old = chat.pane.querySelector('.chat-rewind-panel');
    if (old) { old.remove(); return; }
    const r = await ccx.invoke('chat:checkpoints', { id: chat.id });
    const list = (r.ok && r.checkpoints) || [];
    const panel = el('div', 'chat-skills-panel chat-rewind-panel');
    panel.appendChild(el('h4', '', '⏪ Rewind files'));
    panel.appendChild(el('p', 'hint', 'Restore files written/edited by this session to an earlier checkpoint. The conversation is NOT undone. Changes made by Bash are not tracked.'));
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
        scrollDown(chat);
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
    const r = await ccx.invoke('chat:context', { id: chat.id });
    if (!r.ok || !r.usage) return;
    const u = r.usage;
    const pct = Math.max(0, Math.min(100, Number(u.percentage) || 0));
    chat.ctxBar.classList.remove('hidden');
    chat.ctxFill.style.width = pct.toFixed(1) + '%';
    chat.ctxFill.style.background = pct > 85 ? '#e5484d' : pct > 65 ? 'var(--warn)' : 'var(--accent)';
    chat.ctxBar.title = 'context: ' + (u.totalTokens || 0).toLocaleString() + ' / '
      + (u.maxTokens || 0).toLocaleString() + ' tokens (' + pct.toFixed(0) + '%)';
  }

  function startContextPolling(chat) {
    if (chat.ctxTimer) return;
    pollContext(chat);
    chat.ctxTimer = setInterval(() => {
      if (!chat.alive) { stopContextPolling(chat); return; }
      pollContext(chat);
    }, 5000);
  }
  function stopContextPolling(chat) {
    clearInterval(chat.ctxTimer);
    chat.ctxTimer = null;
  }

  /* ---------------- background tasks ---------------- */

  function onTaskEvent(chat, msg) {
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
      const node = el('div', 'tool-card kind-agent bg-task');
      const head = el('div', 'tool-head');
      const dot = el('span', 'tool-dot running');
      const ico = el('span', 'tool-ico', '🤖');
      const title = el('span', 'tool-title mono', '');
      const chip = el('span', 'chip', msg.subagent_type || 'task');
      head.appendChild(dot); head.appendChild(ico); head.appendChild(title); head.appendChild(chip);
      const stop = el('button', 'btn small', '⏹ stop');
      stop.title = 'Stop this background task';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        const rr = await ccx.invoke('chat:stopTask', { id: chat.id, taskId: msg.task_id });
        if (!rr.ok) { toast(rr.error, 'err'); stop.disabled = false; }
      });
      head.appendChild(stop);
      node.appendChild(head);
      chat.msgs.appendChild(node);
      t = { node, dot, title, stop, label: msg.description || 'background task' };
      chat.bgTasks.set(msg.task_id, t);
      scrollDownSoft(chat);
    }
    t.label = msg.description || t.label;
    const usage = msg.usage ? ' · ' + Math.round((msg.usage.total_tokens || 0) / 1000) + 'k tok' : '';
    t.title.textContent = '⏳ ' + t.label + (msg.last_tool_name ? ' — ' + msg.last_tool_name : '') + usage;
    if (msg.subtype === 'task_started' && !msg.is_backgrounded) t.stop.remove();  // foreground task: turn blocks on it anyway
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
      mode: 'default', fill: true,
      prompt: () => `Deep-research this project.\n\n1. Explore the repository (docs, source, config) to understand what exists.\n2. Pick the 3–5 most important open questions about it and investigate each: read the code, and use web search for current best practices and prior art.\n3. Produce a report: what the project is, how it works, what is missing or risky, and a recommended next step — with file paths and URLs as evidence.\n\nThe question I care about most: `,
    },
    review: {
      mode: 'default', fill: false,
      prompt: () => `Code-review the current work in this repository.\n\n1. Run git status and git diff (including --staged). If the working tree is clean, diff against the default branch (origin/main or origin/master).\n2. For every finding report: severity (blocker / major / minor / nit), file:line, what is wrong, why it matters, and a concrete fix as a diff snippet.\n3. Cover correctness, security, error handling, tests, and naming. Spawn subagents to review different areas in parallel if the diff is large. End with a one-screen summary table sorted by severity.`,
    },
    explain: {
      mode: 'default', fill: false,
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

  function wireWorkflows(chat, send) {
    chat.pane.querySelectorAll('.wf-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const wf = WORKFLOWS[chip.dataset.wf];
        if (!wf || !chat.alive) return;
        if (wf.mode && wf.mode !== chat.mode) {
          const r = await ccx.invoke('chat:set-mode', { id: chat.id, mode: wf.mode });
          if (r.ok) { chat.mode = wf.mode; chat.modeSel.value = wf.mode; toast('Mode → ' + modeLabel(chat.mode)); }
          else toast(r.error, 'err');
        }
        chat.composer.value = wf.prompt(chat.cwd);
        autosize(chat.composer);
        chat.composer.focus();
        chat.composer.setSelectionRange(chat.composer.value.length, chat.composer.value.length);
        if (!wf.fill) send();   // self-contained workflows run immediately; fill-in ones wait for the user
      });
    });
  }

  /* ---------------- nested subagent timelines ---------------- */

  // Frames produced inside a Task/Agent subagent carry parent_tool_use_id —
  // render them nested inside their parent card (orchestration view).
  function nestedTarget(chat, parentId) {
    if (!parentId) return null;
    const ctx = chat.tools.get(parentId);
    if (!ctx) return null;
    if (!ctx.nested) {
      ctx.nested = el('div', 'nested-agents');
      ctx.nested.appendChild(el('div', 'nested-label', '⌥ subagent activity'));
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
      const chip = el('span', 'img-chip', '🖼 image ' + (i + 1));
      const x = el('button', 'close', '✕');
      x.title = 'Remove';
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
      const item = el('div', 'slash-item' + (i === chat.slashIdx ? ' sel' : ''), '📄 ' + f);
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

  function addCopyBtn(host, getText, cls) {
    const b = el('button', 'copy-btn ' + (cls || ''), '⧉');
    b.title = 'Copy';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(getText());
        b.textContent = '✓';
        setTimeout(() => { b.textContent = '⧉'; }, 1200);
      } catch { /* clipboard denied */ }
    });
    host.appendChild(b);
  }

  function enhanceMarkdown(container, rawText) {
    addCopyBtn(container, () => rawText, 'msg-copy');
    container.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code') || pre;
      addCopyBtn(pre, () => code.textContent, 'pre-copy');
      colorizeCode(pre, code);
    });
  }

  // Monaco is already vendored for the diff editor, so syntax highlighting
  // costs no extra dependency. Falls back to plain text when unavailable. #35
  function colorizeCode(pre, code) {
    if (!window.monaco || !window.monaco.editor || typeof window.monaco.editor.colorize !== 'function') return;
    const text = code.textContent || '';
    if (!text.trim() || text.length > 20000) return;
    try {
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
    btn.style.display = 'none';
    chat.pane.appendChild(btn);
    chat.runBtn = btn;
    btn.addEventListener('click', async () => {
      if (menu) return close();
      menu = el('div', 'chat-skills-panel chat-run-menu');
      menu.appendChild(el('h4', '', '▶ run in a terminal tab'));
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
    let panel = chat.pane.querySelector('.chat-history-panel');
    if (panel) { panel.remove(); return; }
    panel = el('div', 'chat-skills-panel chat-history-panel');
    panel.appendChild(el('h4', '', '🕘 Past conversations — ' + basename(chat.cwd)));
    panel.appendChild(el('p', 'hint', 'From the claude engine\u2019s transcript store — includes terminal TUI sessions. Open resumes; Fork branches without touching the original.'));
    const list = el('div', 'skills-list');
    panel.appendChild(list);
    panel.appendChild(el('div', 'hint', 'Esc closes.'));
    chat.pane.appendChild(panel);

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
      const del = el('button', 'btn small danger', '🗑');
      del.title = 'Delete this session from disk';
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'sure?'; setTimeout(() => { armed = false; del.textContent = '🗑'; }, 2500); return; }
        const rd = await ccx.invoke('chat:delete', { cwd: chat.cwd, sessionId: s.sessionId });
        if (rd.ok) { row.remove(); toast('Session deleted', 'ok'); } else toast(rd.error, 'err');
      });
      row.appendChild(open); row.appendChild(fork); row.appendChild(del);
      list.appendChild(row);
    }
  }

  /* ---------------- built-in slash commands ---------------- */

  const COMPACT_PROMPT = 'Summarize this conversation so far as a handoff brief for a fresh session: project state, key decisions, files changed, open tasks, and next steps. Be dense and concrete. Reply with ONLY the brief.';

  async function doCompact(chat) {
    if (!chat.alive) return;
    chat.compacting = true;
    chat.msgs.querySelector('.chat-empty')?.remove();
    chat.msgs.appendChild(el('div', 'sys-note', '✂ compacting — asking the engine for a handoff brief, then continuing in a fresh session…'));
    scrollDownSoft(chat);
    await ccx.invoke('chat:send', { id: chat.id, text: COMPACT_PROMPT });
  }

  function handleBuiltin(chat, text) {
    const cmd = text.split(/\s/)[0];
    if (cmd === '/compact') { doCompact(chat); return true; }
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
    if (cmd === '/help') {
      toast('Built-ins: /compact (handoff to fresh session) · /clear (new session) · /cost · /model · /help — every other /command runs in the engine (skills, custom commands)', '');
      return true;
    }
    return false; // engine-side command (skills, plugins, custom)
  }

  /* ---------------- plan viewer (claude-desktop style) ---------------- */

  function openPlanViewer(chat) {
    if (chat.planViewer) return chat.planViewer.body;
    const wrap = el('div', 'chat-plan-viewer');
    const head = el('div', 'plan-head');
    head.appendChild(el('h4', '', '🗺 Plan'));
    const close = el('button', 'close', '✕');
    close.title = 'Hide plan panel';
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
    scrollDown(chat);
    return wrap;
  }

  /** Branch the conversation from a message with an edited prompt. #30 */
  function resendFrom(chat, uuid, originalText) {
    const edited = window.prompt('Re-ask from this message (the conversation branches):', originalText);
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

  function nearBottom(chat) {
    return chat.msgs.scrollHeight - chat.msgs.scrollTop - chat.msgs.clientHeight < 120;
  }
  function scrollDown(chat) { chat.msgs.scrollTop = chat.msgs.scrollHeight; }
  function scrollDownSoft(chat) { if (nearBottom(chat)) scrollDown(chat); }

  function handleEvent(evt) {
    if (window.__CCE_SMOKE) console.log('[chat-event]', evt && evt.id, evt && evt.kind, evt && evt.msg && evt.msg.type);
    const { id, kind } = evt;
    const chat = chats.get(id);
    if (!chat) { if (window.__CCE_SMOKE) console.log('[chat-event] DROPPED — have ids:', [...chats.keys()].join(',')); return; }
    if (kind === 'message') handleMessage(chat, evt.msg);
    else if (kind === 'status') setBusy(chat, evt.busy);
    else if (kind === 'permission') showPermission(chat, evt);
    else if (kind === 'permission-timeout') clearPermission(chat, evt.requestId, 'Permission request timed out — auto-denied');
    // Interrupt / tab close: drop the card instead of leaving it clickable. #11
    else if (kind === 'permission-cleared') {
      clearPermission(chat, evt.requestId, null);
      if (evt.reason === 'interrupted') toast('Pending permission cleared (interrupted)', '');
    }
    else if (kind === 'task') onTaskEvent(chat, evt.msg);
    else if (kind === 'hook') onHookEvent(chat, evt.msg);
    else if (kind === 'auth') onAuth(chat, evt);
    else if (kind === 'interrupted') {
      if (evt.stillQueued) {
        chat.msgs.appendChild(el('div', 'sys-note', '⏹ interrupted — ' + evt.stillQueued + ' queued message(s) still run next'));
        scrollDownSoft(chat);
      }
    }
    else if (kind === 'error') appendError(chat, evt.error);
    else if (kind === 'exit') {
      chat.alive = false; chat.tabEl.classList.add('dead'); setBusy(chat, false);
      const n = el('div', 'sys-note', '— chat session ended —');
      chat.msgs.appendChild(n); scrollDownSoft(chat);
    }
  }

  function setBusy(chat, busy) {
    chat.busy = busy;
    chat.dot.classList.toggle('busy', busy);
    chat.stopBtn.classList.toggle('hidden', !busy);
    chat.contBtn.classList.toggle('hidden', busy || !chat.lastResult || !chat.alive);
    // While a turn runs the primary button becomes stop, as in the desktop app.
    chat.sendBtn.textContent = busy ? '■' : '➤';
    chat.sendBtn.title = busy ? 'Stop (Esc)' : 'Send (Enter)';
    chat.sendBtn.classList.toggle('busy', busy);
    if (busy) { chat.statusLine.textContent = 'working…'; startContextPolling(chat); }
    else {
      if (chat.ctxTimer) { stopContextPolling(chat); pollContext(chat); }
      setStatusLine(chat);
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
      if (u.input_tokens != null) parts.push('↑' + fmtTok(u.input_tokens) + ' ↓' + fmtTok(u.output_tokens));
    }
    chat.statusLine.textContent = parts.join('  ·  ');
    if (chat.init) {
      const auth = chat.init.apiKeySource;
      const keyProvider = !!(chat.provider && (chat.provider.hasApiKey || chat.provider.hasAuthToken));
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
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') { chat.init = msg; onInit(chat); }
        else if (msg.subtype === 'compact_boundary') {
          chat.msgs.querySelector('.chat-empty')?.remove();
          const n = el('div', 'sys-note', '✂ context auto-compacted by the engine — earlier history summarized');
          chat.msgs.appendChild(n);
          scrollDownSoft(chat);
        } else handleSystemSubtype(chat, msg);
        break;
      case 'stream_event': handleStream(chat, msg.event, msg.parent_tool_use_id); break;
      case 'assistant': {
        // Replace any live blocks with the finalized rendering.
        clearLive(chat, msg.parent_tool_use_id);
        if (msg.error && msg.error !== 'unknown') { appendError(chat, msg.error); break; }
        for (const block of (msg.message?.content || [])) renderBlock(chat, block, msg.parent_tool_use_id);
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
            if (String(t || '').trim()) {
              // The composer already showed this message when it was sent; the
              // engine's replay only adds the uuid. Swap it in place instead of
              // drawing the message twice.
              const sent = [...chat.msgs.querySelectorAll('.msg.user-msg')]
                .find(n => !n.dataset.uuid && n.dataset.text === String(t).trim());
              const fresh = appendUser(chat, t, msg.uuid);
              if (sent) sent.replaceWith(fresh);
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
      case 'tool_progress': onToolProgress(chat, msg); break;
      case 'api_retry': onApiRetry(chat, msg); break;
      case 'rate_limit': onRateLimit(chat, msg); break;
      case 'prompt_suggestion': onPromptSuggestion(chat, msg); break;
      case 'permission_denied': onPermissionDenied(chat, msg); break;
      case 'session_state_changed': onSessionState(chat, msg); break;
      case 'commands_changed': onCommandsChanged(chat, msg); break;
      case 'engine_notification': onEngineNotification(chat, msg); break;
      case 'result': {
        chat.lastResult = msg;
        const metered = !chat.provider || !chat.provider.baseUrl;
        if (metered && typeof msg.total_cost_usd === 'number') chat.spent = (chat.spent || 0) + msg.total_cost_usd;
        setStatusLine(chat);
        setBusy(chat, false);
        if (chat.compacting) {
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
          } else {
            appendError(chat, 'Compaction failed (' + msg.subtype + '). The engine auto-compacts near the context limit regardless.');
          }
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
            appendError(chat, 'Turn failed (' + msg.subtype + '): ' + text.slice(0, 300));
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
    if (ctx) {
      if (!ctx.statusEl) ctx.statusEl = el('span', 'tool-elapsed', '');
      ctx.card.querySelector('.tool-head').appendChild(ctx.statusEl);
      ctx.statusEl.textContent = secs >= 1 ? secs + 's' : '';
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
      '🚫 ' + String(msg.tool_name || 'tool') + ' denied: ' + String(reason).slice(0, 200)));
    scrollDownSoft(chat);
  }

  // prompt_suggestion: predicted next prompts, as clickable chips. #37
  function onPromptSuggestion(chat, msg) {
    const picks = Array.isArray(msg.suggestions) ? msg.suggestions
      : (msg.prompt ? [msg.prompt] : []);
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
    if (s.permission_mode && s.permission_mode !== chat.mode) {
      chat.mode = s.permission_mode;
      chat.modeSel.value = s.permission_mode;
      setStatusLine(chat);
    }
    if (s.model && s.model !== chat.model) {
      chat.model = s.model;
      setStatusLine(chat);
    }
  }

  // commands_changed: the slash-command list changed (a plugin installed, a file
  // appeared). Refresh so the palette is not stale.
  function onCommandsChanged(chat, msg) {
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
  function handleSystemSubtype(chat, msg) {
    if (msg.subtype === 'permission_denied') return onPermissionDenied(chat, msg);
    if (msg.subtype === 'commands_changed') return onCommandsChanged(chat, msg);
    if (msg.subtype === 'session_state_changed') return onSessionState(chat, msg);
    if (msg.subtype === 'compact_boundary') return;   // already handled
  }

  function onInit(chat) {
    chat.msgs.querySelector('.chat-empty')?.remove();
    // show what CLAUDE.md memory the engine auto-loads (imported from claude config)
    if (!chat.memChipAdded) {
      chat.memChipAdded = true;
      ccx.invoke('memory:read', { cwd: chat.cwd }).then(r => {
        if (!r.ok) return;
        const g = (r.global.content || '').length;
        const pr = r.project && r.project.content ? r.project.content.length : 0;
        if (g || pr) {
          const chip = el('span', 'proj-chip sandbox', '🧠 memory loaded');
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
        '⚠ MCP not ready: ' + bad.map(s => s.name + ' (' + s.status + ')').join(', ') + ' — open ⧉ mcp to reconnect'));
      scrollDownSoft(chat);
    }
    ccx.invoke('tools:check').then((r) => {
      if (!r.ok) return;
      const missing = (r.tools || []).filter(t => !t.found).map(t => t.name);
      if (missing.length) {
        chat.msgs.appendChild(el('div', 'sys-note',
          '⚠ missing tools some skills need: ' + missing.join(', ') + ' — install them from ⚡ skills'));
        scrollDownSoft(chat);
      }
    }).catch(() => {});
  }

  function renderMcpChips(chat) {
    const old = chat.pane.querySelector('.chat-mcp-chips'); old && old.remove();
    const servers = (chat.init && chat.init.mcp_servers) || [];
    if (!servers.length) return;
    const row = el('div', 'chat-mcp-chips');
    for (const s of servers) {
      const chip = el('span', 'chip mcp-chip ' + (s.status === 'connected' ? 'mcp-ok' : ''), `⧉ ${s.name}`);
      chip.title = 'MCP server: ' + s.name + ' (' + s.status + ')';
      row.appendChild(chip);
    }
    chat.pane.querySelector('.chat-header').insertBefore(row, chat.pane.querySelector('.chat-header-sep:last-of-type'));
  }

  /* ---------------- streaming (per-thread: main + each subagent) ---------------- */

  function clearLive(chat, parentId) {
    const key = parentId || 'main';
    const live = chat.lives && chat.lives.get(key);
    if (!live) return;
    for (const [, b] of live.blocks) b.node && b.node.remove();
    chat.lives.delete(key);
  }

  /** JSON.parse that returns null instead of throwing on partial input. */
  function tryJson(s) {
    try { return JSON.parse(s || '{}'); } catch { return null; }
  }

  // Re-parsing markdown on every streamed token is O(n^2) and visibly stutters
  // on long answers. Coalesce to one render per frame. #21
  function scheduleMarkdown(blk) {
    if (blk._raf) return;
    blk._raf = requestAnimationFrame(() => {
      blk._raf = null;
      blk.body.innerHTML = md(blk.text);
    });
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
          if (pill) pill.textContent = '✻ Thinking… ' + ((Date.now() - blk.t0) / 1000).toFixed(0) + 's';
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
          if (pill) pill.textContent = '✻ Thought for ' + secs + 's — click to view';
          blk.node.open = false;   // collapse into the desktop-style summary pill
        }
        break;
      }
      case 'message_stop': clearLive(chat, parentId); break;
      default: break;
    }
  }

  function buildThinking(label) {
    const d = el('details', 'thinking-block');
    d.open = true;
    const s = el('summary');
    s.appendChild(el('span', 'think-pill', '✻ ' + label));
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
    sum.appendChild(el('span', 'tool-ico', toolIcon(name)));
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
      const w = el('div', 'msg assistant-msg' + (parentId ? ' nested' : ''));
      const body = el('div', 'md');
      body.innerHTML = md(block.text);
      w.appendChild(body);
      enhanceMarkdown(body, block.text);
      host.appendChild(w);
    } else if (block.type === 'thinking') {
      if (!block.thinking) return;
      const d = buildThinking('Thought — click to view reasoning');
      d.querySelector('.think-body').textContent = block.thinking;
      d.open = false;
      host.appendChild(d);
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
    const icon = el('span', 'tool-ico', toolIcon(name));
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
      pre.textContent = JSON.stringify(ctx.input, null, 2).slice(0, 4000);
      const det = el('details', 'tool-json');
      det.appendChild(el('summary', '', 'raw input'));
      det.appendChild(pre);
      body.appendChild(det);
      const d = body.querySelector('.monaco-diff');
      if (d && d.__init && !body.classList.contains('hidden')) d.__init();
    }
    head.addEventListener('click', () => {
      const opening = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      if (opening) {
        const d = body.querySelector('.monaco-diff');
        if (d && d.__init) d.__init();
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
    chat.tools.set(toolUseId, ctx);
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

  /** Fill the todo drawer from a TodoWrite tool input. #5 */
  function renderTodos(chat, input) {
    const items = Array.isArray(input.todos) ? input.todos : [];
    if (!items.length) {
      chat.todosEl.classList.add('hidden');
      return;
    }
    chat.todosList.innerHTML = '';
    for (const t of items) {
      const li = el('li', 'todo-item' + (t.status === 'completed' ? ' done' : t.status === 'in_progress' ? ' active' : ''));
      li.appendChild(el('span', 'todo-mark', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'));
      li.appendChild(el('span', 'todo-text', String(t.content || '')));
      if (t.status === 'in_progress') li.appendChild(el('span', 'chip', 'now'));
      chat.todosList.appendChild(li);
    }
    const done = items.filter(t => t.status === 'completed').length;
    chat.todosEl.querySelector('h4').textContent = 'todos ' + done + '/' + items.length;
    chat.todosEl.classList.remove('hidden');
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
    wrap.appendChild(el('div', 'hint', 'click the card header to show the diff'));
    wrap.__init = () => {
      if (!wrap.__init) return;
      wrap.__init = null;
      wrap.classList.remove('pending');
      if (!window.monaco || !window.monaco.editor) { renderTextDiff(wrap, name, input); return; }
      wrap.innerHTML = '';
      const host = el('div', 'monaco-host');
      wrap.appendChild(host);
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
    if (!ctx) {
      // No card yet for this id: either the result beat its card (buffer it so
      // the output is not lost — #4) or the model emitted the call as prose
      // (small local models — count it so the picker can warn — #43).
      if (block.is_error && /tool|function|call/i.test(resultText(block.content).slice(0, 200))) {
        noteToolOutcome(chat.model, false);
      }
      chat.pendingResults = chat.pendingResults || new Map();
      chat.pendingResults.set(block.tool_use_id, { text: resultText(block.content), isError: !!block.is_error });
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
    ctx.output = resultText(block.content);
    ctx.isError = !!block.is_error;
    ctx.setStatus(block.is_error ? 'err' : 'done');
  }

  function renderOutput(chat, toolUseId) {
    const ctx = chat.tools.get(toolUseId);
    if (!ctx) return;
    let out = ctx.body.querySelector('.tool-output');
    if (!out) {
      out = el('pre', 'tool-output mono' + (ctx.isError ? ' tool-err' : ''));
      ctx.body.insertBefore(out, ctx.body.firstChild);
    }
    out.textContent = (ctx.output || (ctx.status === 'running' ? '…' : '(no output)')).slice(0, 8000);
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
    head.appendChild(el('span', 'tool-ico', toolIcon(toolName)));

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
      if (r.ok) { chat.mode = mode; chat.modeSel.value = mode; toast('Mode → ' + modeLabel(chat.mode), 'ok'); }
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
        await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision });
        if (afterMode) await setMode(afterMode);
        setBusy(chat, true);
      });
      return b;
    };
    if (toolName === 'ExitPlanMode') {
      actions.appendChild(mk('✓ approve + auto-accept edits', 'primary', 'allow', 'acceptEdits'));
      actions.appendChild(mk('✓ approve', '', 'allow', 'default'));
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
        await ccx.invoke('chat:permission-answer', {
          id: chat.id, requestId, decision: 'deny',
          message: why || 'Keep planning. Do not start implementing yet.',
        });
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
    if (toolName === 'Bash' && input.command) {
      // The command is the whole point of the prompt: show it large, not as JSON.
      wrap.appendChild(el('pre', 'perm-command mono', String(input.command).slice(0, 2000)));
      if (input.description) wrap.appendChild(el('div', 'hint', input.description));
    } else if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) && input.file_path) {
      wrap.appendChild(el('div', 'perm-path mono', String(input.file_path)));
    } else if ((toolName === 'Grep' || toolName === 'Glob') && input.pattern) {
      wrap.appendChild(el('div', 'perm-path mono', String(input.pattern)));
    } else if (toolName === 'WebFetch' && input.url) {
      wrap.appendChild(el('div', 'perm-path mono', String(input.url)));
    }
    const det = el('details', 'tool-json');
    det.appendChild(el('summary', '', 'raw input'));
    det.appendChild(el('pre', 'tool-io mono', JSON.stringify(input, null, 2).slice(0, 1200)));
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
  }

  // AskUserQuestion arrives as a permission request, but it is a question, not
  // an action: draw real options and send the picked labels back as answers.
  // The engine reads them from updatedInput.answers, keyed by question text.
  function showAskQuestion(chat, evt) {
    const { requestId, input = {} } = evt;
    const qs = Array.isArray(input.questions) ? input.questions : [];
    const answers = {};
    const card = el('div', 'perm-card ask');
    const head = el('div', 'perm-head');
    head.appendChild(el('span', 'tool-ico', toolIcon('AskUserQuestion')));
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
      await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision: 'allow', answers });
      setBusy(chat, true);
    });
    skip.addEventListener('click', async () => {
      finish();
      await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision: 'deny' });
      setBusy(chat, true);
    });
    actions.appendChild(send);
    actions.appendChild(skip);
    card.appendChild(actions);
    sync();
    chat.permSlot.appendChild(card);
    card.scrollIntoView({ block: 'nearest' });
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

  function maybeSlash(chat) {
    const v = chat.composer.value;
    if (v.startsWith('/') && !v.includes(' ')) {
      const q = v.slice(1).toLowerCase();
      chat.slashItems = (chat.commands || []).filter(c => c.toLowerCase().startsWith(q)).slice(0, 12);
      if (!chat.slashItems.length) return hideSlash(chat);
      renderSlash(chat);
    } else hideSlash(chat);
  }

  function renderSlash(chat) {
    chat.slash.innerHTML = '';
    chat.slashItems.forEach((c, i) => {
      const item = el('div', 'slash-item' + (i === chat.slashIdx ? ' sel' : ''), '/' + c);
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
    if (c) { chat.composer.value = '/' + c + ' '; chat.composer.focus(); }
    hideSlash(chat);
  }
  function hideSlash(chat) { chat.slash.classList.add('hidden'); chat.slashIdx = -1; }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
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
      // The Conversations dropdown outranks everything: close it, don't stop the turn.
      const drop = document.querySelector('#convo-drop');
      if (drop && !drop.classList.contains('hidden')) return;
      for (const [, chat] of chats) {
        if (chat.pane.classList.contains('active')) {
          const panel = chat.pane.querySelector('.chat-skills-panel');
          if (panel) { panel.remove(); return; }
          if (!chat.permSlot.childElementCount && chat.busy && !e.shiftKey) {
            ccx.invoke('chat:interrupt', { id: chat.id });
          }
        }
      }
    }
  });

  return { createSession, handleEvent, chats, closeChat, activateChat };
})();
