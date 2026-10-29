// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { $, paintDeclaredIcons, state, toast } from '../app/core.js';
import { fillModeSelect, uiMode } from '../app/modes.js';
import { switchView } from '../app/tabs.js';
import { addFileRef, applyAt, applyAttachedFiles, attachFiles, autosize, clearImages, maybeAt, restoreDraftImages, persistPending, readImageFile, renderImageChips, renderQueued, restoreUnsent } from './composer.js';
import { Chat } from './index.js';
import { enhanceMarkdown, wireRunMenu } from './markdown.js';
import { renderProjectInfo, wireHeaderMenu } from './panels.js';
import { endPermCountdown } from './permissions.js';
import { discoverModels, fillModelSelector, guardSwitch, openCustomModel, refreshEffort, setEffort, switchModel, switchProvider, wireModelPicker } from './picker.js';
import { applySlash, doCompact, handleBuiltin, hideSlash, jumpSlash, maybeSlash, moveSlash, noteSlashUsed } from './slash.js';
import { enqueue, restoreQueue, setQueue } from './qpanel.js';
import { wireTargetChip } from './target.js';
import { cancelChain, finishWorkflowRun, wireWorkflowPicker } from './workflows.js';
import { drainQueue, setBusy, setStatusLine, updateBusyUi } from './status.js';
import { thoughtNode } from './stream.js';
import { clearTodos, makeToolCard, renderTodoItems, seedTodosFromPrompt } from './tools.js';
import { appendCommandNote, appendError, appendSummary, appendUser, installVirtualization, nearBottom, scrollDown, scrollDownSoft, setupRequestRail, updateLatestBtn } from './transcript.js';
import { basename, chats, el, md, modeLabel, splitThink } from './util.js';

/* ---------------- session lifecycle ---------------- */

export async function createSession(opts) {
  const res = await ccx.invoke('chat:create', opts);
  if (!res.ok) { toast('Failed to start chat: ' + res.error, 'err'); switchView('terminal'); return; }
  const id = res.id;

  const pane = el('div', 'term-pane chat-pane active');
  pane.innerHTML = `
      <div class="chat-header">
        <span class="chat-dot" title="ready"></span>
        <span class="chat-title"></span>
        <span class="chat-project"></span>
        <span class="chat-provider" title="provider"></span>
        <span class="chat-header-sep"></span>
        <button class="chat-btn chat-mgr-btn hidden" title="Model manager: load / unload, context size, keep-alive"><span data-icon="gear"></span> models</button>
        <button class="chat-btn chat-stop hidden" title="Interrupt (Esc)"><span data-icon="square"></span> stop</button>
        <button class="chat-btn chat-cont-btn hidden" title="Continue from where the model stopped — completes remaining work"><span data-icon="play"></span> continue</button>
        <button class="chat-btn hdr-more" title="Chat actions" aria-label="Chat actions"><span data-icon="dots"></span></button>
      </div>
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
          <button class="foot-pick chat-target-btn" type="button" aria-haspopup="menu" aria-expanded="false"><span class="tg-label">Local</span><span class="caret" data-icon="chevron"></span></button>
          <button class="foot-pick chat-model-btn" type="button" aria-haspopup="listbox" title="Model and provider (switching provider keeps this conversation)"><span class="mb-label">model</span><span class="caret" data-icon="chevron"></span></button>
          <select class="foot-pick chat-model-foot hidden" tabindex="-1" aria-hidden="true"></select>
          <select class="foot-pick chat-mode-foot" title="Permission mode"></select>
          <select class="foot-pick chat-effort hidden" title="Reasoning effort (only the levels this model supports)" aria-label="Reasoning effort"></select>
          <button class="foot-pick chat-compact-btn" title="Compact this conversation in place — earlier turns are summarized, the chat keeps going"><span class="ctx-ring" style="--p:0"></span><span class="ctx-pct">ctx</span></button>
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
    id, cwd: res.cwd, provider: res.provider, model: res.model || '', mode: uiMode(res.permissionMode, res.provider, res.autoPolicy), autoPolicy: !!res.autoPolicy,
    pane, msgs: pane.querySelector('.chat-msgs'), composer: pane.querySelector('.chat-input'),
    sendBtn: pane.querySelector('.chat-send'), stopBtn: pane.querySelector('.chat-stop'),
    statusLine: pane.querySelector('.chat-statusline .sl-left'),
    statusRight: pane.querySelector('.chat-statusline .sl-right'),
    dot: pane.querySelector('.chat-dot'), providerEl: pane.querySelector('.chat-provider'),
    projEl: pane.querySelector('.chat-project'), titleEl: pane.querySelector('.chat-title'),
    headerEl: pane.querySelector('.chat-header'),
    modelSel: pane.querySelector('.chat-model-foot'), modelBtn: pane.querySelector('.chat-model-btn'), modeSel: pane.querySelector('.chat-mode-foot'),
    effortBtn: pane.querySelector('.chat-effort'), attachBtn: pane.querySelector('.chat-attach'), targetBtn: pane.querySelector('.chat-target-btn'),
    // Element ref and queue *counter* must not share a name: showQueued used
    // to overwrite the element with a number and the next send threw.
    queuedEl: pane.querySelector('.chat-queued'),
    permSlot: pane.querySelector('.chat-perm-slot'), slash: pane.querySelector('.chat-slash'),
    latestBtn: pane.querySelector('.chat-latest'),
    todos: [],
    moreBtn: pane.querySelector('.hdr-more'),
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
  setupRequestRail(chat);
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
  if (chat.titleEl) chat.titleEl.textContent = basename(res.cwd);
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

  registerTab(id, { kind: 'chat', engine: res.engine || null, pane, tabEl: tab, sessionId: null, cwd: chat.cwd, focus: () => { if (chat.alive) chat.composer.focus(); } });
  // Engine chats (Codex / Antigravity / OpenCode): the CLI owns its model,
  // permissions and context, so the Claude-only controls are hidden. #feat-engine-chat
  if (res.engine) {
    const name = res.label || res.model || res.engine;
    chat.engine = res.engine;
    chat.memProbed = true;   // the memory / skill probes are Claude prompts
    pane.classList.add('engine-chat');
    tab.firstChild.textContent = '◆ ' + basename(res.cwd) + ' · ' + name;
    if (chat.providerEl) chat.providerEl.textContent = res.model || name;
    chat.composer.placeholder = 'Message ' + name + '…  (text only)';
    const h = pane.querySelector('.chat-empty h3');
    if (h) h.textContent = name;
    const p = pane.querySelector('.chat-empty p');
    if (p) {
      p.textContent = name + ' runs headless in this project: one CLI run per message, ' + (/CLI default$/.test(res.model || '') ? 'with its own login and models. ' : 'on ' + String(res.model || '').replace(/^[^·]*·\s*/, '') + '. ')
        + (res.permissionMode === 'bypassPermissions'
          ? 'YOLO is on: it runs commands and edits files without asking.'
          : 'It cannot stop to ask you, so actions that need approval are blocked (Codex may still edit files inside this folder).');
    }
  }
  // Restore any draft left by a crash/refresh. #crash-recovery
  try {
    const d = localStorage.getItem('cce:draft:' + (chat.cwd || ''));
    if (d) { chat.composer.value = d; autosize(chat.composer); }
  } catch { /* ignore */ }
  chat.drainQueue = () => drainQueue(chat);
  restoreQueue(chat);
  restoreDraftImages(chat);
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
  refreshEffort(chat);
  wireModelPicker(chat);
  wireTargetChip(chat, res);
  chat.modelSel.addEventListener('change', async () => {
    const v = chat.modelSel.value;
    if (!(await guardSwitch(chat, v))) { fillModelSelector(chat); return; }
    if (v.startsWith('__pm:')) { const [uid, m] = v.slice(5).split('\u0001'); await switchProvider(chat, uid, m || ''); return; }
    if (v.startsWith('__prov:')) { await switchProvider(chat, v.slice(7)); return; }
    if (v === '__custom') { openCustomModel(chat); return; }
    await switchModel(chat, v);
  });
  chat.modeSel.addEventListener('change', async () => {
    const want = chat.modeSel.value;
    const r = await ccx.invoke('chat:set-mode', { id: chat.id, mode: want });
    if (r.ok) {
      // The main process is the authority: it may fall back (auto → accept edits on a third-party provider).
      chat.autoPolicy = !!r.autoPolicy;
      chat.mode = uiMode(r.permissionMode || want, chat.provider, chat.autoPolicy);
      chat.modeSel.value = chat.mode;
      if (chat.mode !== want) toast('auto needs Anthropic’s own API — using ' + modeLabel(chat.mode) + ' instead', 'err');
      else toast('Mode → ' + modeLabel(chat.mode), 'ok');
      setStatusLine(chat);
    } else { toast(r.error, 'err'); chat.modeSel.value = chat.mode; }
  });
  chat.effortBtn.addEventListener('change', () => setEffort(chat, chat.effortBtn.value));
  chat.stopBtn.addEventListener('click', () => { cancelChain(chat); finishWorkflowRun(chat, 'stopped'); ccx.invoke('chat:interrupt', { id: chat.id }); });
  // Header overflow menu. 13 buttons wrapped onto three rows; everything that
  // is not model/mode/stop now lives behind one "⋯". #33
  const forkConversation = async () => {
    try {
      const p = await ccx.invoke('chat:fork', { id: chat.id });
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
    if (text.startsWith('/')) noteSlashUsed(chat, text);
    if (text.startsWith('/') && !blocks.length && handleBuiltin(chat, text)) {
      chat.composer.value = '';
      autosize(chat.composer);
      hideSlash(chat);
      return;
    }
    chat.follow = true;   // sending jumps back to the live end
    chat.spendWarn = false;
    updateLatestBtn(chat);
    if (text !== NUDGE_TEXT) chat.nudges = 0;   // a real prompt re-arms the one automatic nudge
    try { localStorage.removeItem('cce:draft:' + (chat.cwd || '')); } catch { /* ignore */ }

    if (chat.busy) {
      const mode = action || chat.busyMode || 'queue';
      if (mode === 'queue') {
        appendUser(chat, text || '(image)');
        enqueue(chat, { text, blocks });
        chat.msgs.appendChild(el('div', 'sys-note', '⏭ queued — will run after current turn finishes'));
        scrollDownSoft(chat);
        chat.composer.value = '';
        autosize(chat.composer);
        hideSlash(chat);
        clearImages(chat);
        updateBusyUi(chat);
        return;
      }

      // Steer mode: send now, Claude reads it at the next step (no interrupt)
      appendUser(chat, text || '(image)');
      chat.msgs.appendChild(el('div', 'sys-note', '↯ steered — Claude will read this after its current step'));
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
      ccx.invoke('chat:steer', { id: chat.id, text, blocks: blocks.length ? blocks : null }).then((r) => {
        if (!r || !r.ok) {
          appendError(chat, 'Not sent — ' + ((r && r.error) || 'the session is no longer running; open a new chat (Ctrl+Shift+T)') + ' (your message is back in the box)');
          restoreUnsent(chat, text, blocks);
          setBusy(chat, false);
        }
      }).catch((e) => {
        appendError(chat, 'Not sent — ' + ((e && e.message) || e) + ' (your message is back in the box)');
        restoreUnsent(chat, text, blocks);
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
    if (blocks.some((b) => b && b.type === 'image')) chat.sentImages = true;
    ccx.invoke('chat:send', { id: chat.id, text, blocks: blocks.length ? blocks : null }).then((r) => {
      if (!r || !r.ok) {
        appendError(chat, 'Not sent — ' + ((r && r.error) || 'the session is no longer running; open a new chat (Ctrl+Shift+T)') + ' (your message is back in the box)');
        restoreUnsent(chat, text, blocks);
        setBusy(chat, false);
      }
    }).catch((e) => {
      appendError(chat, 'Not sent — ' + ((e && e.message) || e) + ' (your message is back in the box)');
      restoreUnsent(chat, text, blocks);
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
    if (e.key === 'ArrowUp' && chat.composer.value === '' && chat.pendingMsgs.length && !chat.pendingImages.length) {
      // Edit the newest queued message: it comes back into the box.
      e.preventDefault();
      const last = chat.pendingMsgs[chat.pendingMsgs.length - 1];
      chat.composer.value = last.text;
      for (const b of last.blocks || []) if (b && b.source) chat.pendingImages.push({ media_type: b.source.media_type, data: b.source.data });
      renderImageChips(chat);
      setQueue(chat, chat.pendingMsgs.slice(0, -1));
      autosize(chat.composer);
      return;
    }
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
    // Ctrl+End: back to the newest response (plain End stays a text caret
    // key). The composer keeps focus so the next message can be typed.
    if (e.key === 'End' && e.ctrlKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      chat.follow = true;
      scrollDown(chat);
      updateLatestBtn(chat);
    }
  });

  // paste images straight into the chat
  chat.composer.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const fileItem = items.find(i => i.kind === 'file' && !i.type.startsWith('image/'));
    if (fileItem) {
      const f = fileItem.getAsFile();
      const p = f && ccx.pathForFile ? ccx.pathForFile(f) : '';
      if (p) { e.preventDefault(); addFileRef(chat, p); return; }
    }
    const imgItem = items.find(i => i.type.startsWith('image/'));
    if (!imgItem) return;
    e.preventDefault();
    const file = imgItem.getAsFile();
    if (!file) return;
    readImageFile(file).then((img) => { chat.pendingImages.push(img); renderImageChips(chat); })
      .catch(() => toast('could not read the pasted image', 'err'));
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
        cancelChain(chat); finishWorkflowRun(chat, 'stopped');
        ccx.invoke('chat:interrupt', { id: chat.id });
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
  // The whole chat is a drop target (not just the textbox); files with a real
  // disk path go by reference, small images still travel inline.
  let dragDepth = 0;
  const dropFiles = (files) => {
    for (const file of [...files]) {
      const p = ccx.pathForFile ? ccx.pathForFile(file) : '';
      if (String(file.type || '').startsWith('image/') && file.size < 20 * 1024 * 1024) attachFiles(chat, [file]);
      else if (p) addFileRef(chat, p);
      else attachFiles(chat, [file]);
    }
  };
  chat.pane.addEventListener('dragenter', (e) => {
    if (!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'))) return;
    e.preventDefault(); dragDepth++; chat.pane.classList.add('drop-active');
  });
  chat.pane.addEventListener('dragover', (e) => { e.preventDefault(); });
  chat.pane.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) chat.pane.classList.remove('drop-active'); });
  chat.pane.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; chat.pane.classList.remove('drop-active');
    if (e.dataTransfer && e.dataTransfer.files.length) dropFiles(e.dataTransfer.files);
  });
  chat.composer.addEventListener('keydown', (e) => {
    // IME composition: Enter/arrows belong to the composition, not the app.
    if (e.isComposing || e.keyCode === 229) return;
    if (!chat.slash.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(chat, 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(chat, -1); return; }
      if (!chat.atMode && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); jumpSlash(chat, e.key.toLowerCase()); return; }
      if (!chat.atMode && e.ctrlKey && (e.key === 'Home' || e.key === 'End')) { e.preventDefault(); jumpSlash(chat, e.key.toLowerCase()); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && chat.slashItems.length)) {
        e.preventDefault();
        if (chat.atMode) applyAt(chat);
        else applySlash(chat);
        return;
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
      ccx.invoke('chat:send', { id: chat.id, text: opts.initText })
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
    }).catch(() => { /* no stored transcript to replay; the chat starts empty */ });
  }
  // A new conversation exists now: the sidebar list must stop saying
  // "No conversations yet".
  if (typeof window.scheduleConvoRefresh === 'function') window.scheduleConvoRefresh(true);
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

export function maybeNudge(chat, msg) {
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
  if (window.__CCE_DEBUG || window.__CCE_SMOKE) console.log('[cce] auto-nudge triggered for chat:', chat.id);
  chat.msgs.appendChild(el('div', 'sys-note warn', '↻ [Auto-nudge] the model announced a next step but stopped — nudging it to continue (automatic, once)'));
  scrollDownSoft(chat);
  chat.composer.value = NUDGE_TEXT;
  autosize(chat.composer);
  chat.send();
  return true;
}

function registerTab(id, meta) { if (window.__tabs) window.__tabs.set(id, meta); }

/**
 * Publish what this tab needs from the user, so the sidebar can say "waiting
 * on you" instead of just counting tabs. A permission prompt is the case that
 * matters: the turn is blocked and only this user can unblock it.
 */
export function publishTabState(chat) {
  const meta = window.__tabs && window.__tabs.get(chat.id);
  if (!meta) return;
  const busy = !!chat.busy;
  const needsYou = !!(chat.permCount > 0) || !!(chat.elicCount > 0) || (!!chat.queued && chat.queued > 0);
  if (meta.tabEl) meta.tabEl.dataset.queued = (chat.pendingMsgs && chat.pendingMsgs.length) ? String(chat.pendingMsgs.length) : '';
  if (meta.busy === busy && meta.needsYou === needsYou) return;
  meta.busy = busy;
  meta.needsYou = needsYou;
  if (typeof window.updateNavState === 'function') window.updateNavState();
}

export function activateChat(id) {
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

export async function closeChat(id) {
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
  if (chat.alive) { try { await ccx.invoke('chat:close', { id }); } catch { /* tear down anyway */ } }
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

/* ---------------- context meter ---------------- */

export async function pollContext(chat) {
  // Only the newest poll may paint: overlapping calls can answer out of
  // order, and the older answer then overwrote the newer one (the meter flickered).
  const n = chat.ctxSeq = (chat.ctxSeq || 0) + 1;
  const r = await ccx.invoke('chat:context', { id: chat.id });
  if (n !== chat.ctxSeq || !r || !r.ok || !r.usage) return;
  const u = r.usage;
  const pct = Math.max(0, Math.min(100, Number(u.percentage) || 0));
  const trimmed = Math.max(0, Number(u.outputCharsTrimmed) || 0);
  const trimmedHint = trimmed ? ` · ${trimmed.toLocaleString()} tool-output characters kept out of model input` : '';
  chat.ctxUsage = u;
  if (chat.compactBtn) {
    const ring = chat.compactBtn.querySelector('.ctx-ring');
    if (ring) ring.style.setProperty('--p', pct.toFixed(1));
    chat.compactBtn.classList.toggle('warn', pct > 65);
    const lbl = chat.compactBtn.querySelector('.ctx-pct');
    if (lbl) lbl.textContent = pct.toFixed(0) + '%';
    chat.compactBtn.title = 'Context ' + pct.toFixed(0) + '% used (' + (u.totalTokens || 0).toLocaleString()
      + ' / ' + (u.maxTokens || 0).toLocaleString() + ' tokens)' + trimmedHint + '. Click to compact in place.';
  }
}

export function startContextPolling(chat) {
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

export function stopContextPolling(chat) {
  clearInterval(chat.ctxTimer);
  chat.ctxTimer = null;
}

/* ---------------- composer helpers (titles, images, @files, copy, run) ---------------- */

function autoTitle(chat, text) {
  if (chat.titled || !text) return;
  chat.titled = true;
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 26) || basename(chat.cwd);
  if (chat.tabEl && chat.tabEl.firstChild) chat.tabEl.firstChild.textContent = '⌘ ' + t;
  if (chat.titleEl) chat.titleEl.textContent = t;
}
