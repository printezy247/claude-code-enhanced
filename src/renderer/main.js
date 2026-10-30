// The renderer's entry point. Everything below used to be three plain scripts
// (chat.js, providers.js, app.js) sharing one global scope; they are now ES
// modules, bundled by scripts/build-renderer.js into app.bundle.js.
//
// ./chat/index.js comes first on purpose: modules evaluate in import order and
// the chat modules and the app modules reference each other (only inside
// functions, never while loading), so the chat side must finish loading before
// anything here runs.
import { Chat } from './chat/index.js';
import { ProvidersUI } from './providers/ui.js';
import { invalidateConnectorStatus, refreshMcpList, renderConnectors } from './app/connectors.js';
import { ensureConvoDrop, loadConversationList, renderConversationList, renderOpenTabs, toggleConversations } from './app/conversations.js';
import { $, applyTheme, applyThinkingDisplay, elIcon, loadMonaco, lsGet, paintDeclaredIcons, state, toast } from './app/core.js';
import { initSplitTabMenu, renderOverview, renderSplit, setAllOverviewCards, openSplitTab, splitTerm, toggleOverview, toggleSplit } from './app/overview.js';
import { openNewSessionModal, openProviderEditor } from './app/provider-forms.js';
import { parseForceCtx, renderClaudeBanner, renderSettings } from './app/settings.js';
import { activateSession, createSession, killSession, paintReopenButton, recentlyClosedCount, reopenLastClosed, resumeLatest, switchView, tabRegistry, toggleSidebar, usedAt } from './app/tabs.js';
import { chordAction, mruCycle } from './app/nav.js';
import { initHome } from './app/home.js';
import { renderBoard } from './app/board.js';
import { renderUsage } from './app/usage.js';
import { openNewWindow } from './app/window.js';
import { applyLang, setLang } from './i18n.js';

// What other scripts, the tests and the console reach for.
Object.assign(window, {
  Chat, switchView, createSession, toast, state, tabRegistry, killSession, cceLoadMonaco: loadMonaco,
  recentlyClosedCount, paintDeclaredIcons, elIcon, parseForceCtx,
});

/* ================= boot ================= */

function wireChrome() {
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
  // "← Conversations" and the breadcrumb's Home on the other views.
  document.querySelectorAll('[data-back]').forEach(b =>
    b.addEventListener('click', (e) => { e.preventDefault(); switchView(b.dataset.back); }));
  // Explanatory text: one "?" in the header shows or hides it.
  document.querySelectorAll('.view > .banner:not([id])').forEach((banner) => {
    const head = banner.parentElement.querySelector('.panel-head');
    if (!head) return;
    banner.hidden = true;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'banner-toggle';
    b.textContent = '?';
    b.title = 'What is this?';
    b.setAttribute('aria-label', 'What is this?');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => { banner.hidden = !banner.hidden; b.setAttribute('aria-expanded', String(!banner.hidden)); });
    head.appendChild(b);
  });
  paintDeclaredIcons();
  // The conversation list and the Open list live in the sidebar from the start.
  ensureConvoDrop();
  loadConversationList().catch(() => {});
  const tabsEl = $('#tabs');
  if (tabsEl && typeof MutationObserver === 'function') {
    // A tab was added, closed, renamed or marked dead: repaint the Open list.
    new MutationObserver(() => renderOpenTabs()).observe(tabsEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  }
  renderOpenTabs();
  $('#qa-new').addEventListener('click', openNewSessionModal);
  $('#qa-resume').addEventListener('click', resumeLatest);
  $('#qa-reopen').addEventListener('click', reopenLastClosed);
  paintReopenButton();
  $('#btn-usage-refresh').addEventListener('click', () => renderUsage());
  $('#btn-board-refresh')?.addEventListener('click', () => renderBoard());
  $('#btn-add-provider').addEventListener('click', () => (window.ProvidersUI ? ProvidersUI.openConnect() : openProviderEditor(null)));
  $('#btn-mcp-refresh').addEventListener('click', () => refreshMcpList(true));
  // (The per-dropdown wiring — search/sort/filter/refresh/close — lives in
  // ensureConvoDrop, which builds that markup. Nothing to wire here.)
  // cce:// deep links (item 24): main pings, we pull the pending link. The
  // boot pull catches a link that arrived before this listener existed.
  const pullDeepLink = async () => {
    try {
      const r = await ccx.invoke('deeplink:pending');
      const d = r && r.ok && r.link;
      if (!d) return;
      if (d.action === 'view') switchView(d.view);
      else if (d.action === 'open') {
        Chat.createSession({ cwd: d.path, providerUid: state.providers && state.providers.defaultUid })
          .catch((e) => toast(String(e && e.message || e), 'err'));
      } else if (d.action === 'chat') {
        const idx = await ccx.invoke('chats:index');
        const row = ((idx && idx.sessions) || []).find((s) => s && s.sessionId === d.id);
        if (row) {
          Chat.createSession({ cwd: row.cwd || undefined, resume: row.sessionId, providerUid: state.providers && state.providers.defaultUid })
            .catch((e) => toast(String(e && e.message || e), 'err'));
        } else toast('No conversation with id ' + d.id, 'err');
      }
    } catch { /* deep links are best effort */ }
  };
  if (typeof ccx.onDeepLink === 'function') ccx.onDeepLink(pullDeepLink);
  pullDeepLink();

  $('#btn-split-close').addEventListener('click', () => toggleSplit(false));
  $('#split-kind')?.addEventListener('change', () => {
    renderSplit();
    try { localStorage.setItem('cce.split', $('#split-kind').value); } catch { /* private mode */ }
  });
  // The visible tabs drive the (hidden) select, so everything that reads the
  // current pane keeps one source of truth.
  document.querySelectorAll('#splitpane .split-tab').forEach((t) => t.addEventListener('click', () => {
    const k = $('#split-kind');
    if (!k) return;
    k.value = t.dataset.kind;
    k.dispatchEvent(new Event('change'));
  }));
  $('#btn-split-refresh')?.addEventListener('click', () => renderSplit());
  initSplitTabMenu();

  // Layout toggles: left sidebar (Ctrl+\) and the right tasks panel. #feat-desktop-layout
  $('#btn-sidebar')?.addEventListener('click', () => toggleSidebar());
  // A second application window (Ctrl+Shift+N).
  $('#btn-new-window')?.addEventListener('click', () => openNewWindow());
  $('#btn-tasks')?.addEventListener('click', () => {
    const main = document.querySelector('#main');
    if (main && main.classList.contains('split')) toggleSplit(false);
    else toggleSplit(true);
  });
  // Restore the persisted layout. The Overview is always docked; the tool panel
  // (changes / files / terminal / diff / preview) stays closed until it is opened.
  // "+N more" in the Context card: state lives on the stable #overview-body, so a
  // refresh that swaps the card cannot undo it, and pointerdown beats a swap that
  // lands between press and release.
  const ovBody = $('#overview-body');
  const flipCtx = () => ovBody.classList.toggle('ctx-open');
  ovBody?.addEventListener('pointerdown', (e) => { if (e.button === 0 && e.target.closest('.ctx-more')) flipCtx(); });
  ovBody?.addEventListener('click', (e) => { if (e.detail === 0 && e.target.closest('.ctx-more')) flipCtx(); });
  $('#btn-overview-refresh')?.addEventListener('click', () => { window.__connCache = {}; renderOverview(); });
  $('#btn-overview-fold')?.addEventListener('click', () => {
    const cards = [...document.querySelectorAll('#overview-body .task-card')];
    setAllOverviewCards(cards.some((c) => !c.classList.contains('closed')));   // any open: fold all, else unfold all
  });
  $('#btn-overview')?.addEventListener('click', () => toggleOverview());
  if (lsGet('cce.ovHidden', false) === true) toggleOverview(false);
  else $('#btn-overview')?.setAttribute('aria-pressed', 'true');
  try {
    if (localStorage.getItem('cce.sidebarHidden') === '1') toggleSidebar(true);
    const sp = localStorage.getItem('cce.split');
    const k = $('#split-kind');
    if (k && sp && sp !== 'closed' && [...k.options].some(o => o.value === sp)) {
      k.value = sp;
      toggleSplit(true);
    }
  } catch { /* private mode */ }
  renderOverview();

  // Drag-resize the split pane.
  (() => {
    const splitter = $('#splitter');
    if (!splitter) return;
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pane = $('#splitpane');
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      const move = (ev) => {
        const w = Math.max(220, Math.min(window.innerWidth - 420, startW - (ev.clientX - startX)));
        pane.style.width = w + 'px';
        if (splitTerm && splitTerm._fit) { try { splitTerm._fit.fit(); } catch { /* hidden */ } }
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        pane.dataset.w = pane.style.width;   // reopening restores this width
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  })();
  

  // Drag-resize the Overview (right edge of the chat).
  (() => {
    const pane = $('#overviewpane');
    if (!pane) return;
    const root = document.documentElement;
    const clamp = (w) => Math.max(240, Math.min(560, Math.round(w)));
    try { const saved = Number(localStorage.getItem('cce.ovWidth')); if (saved) root.style.setProperty('--ov-w', clamp(saved) + 'px'); } catch { /* private mode */ }
    const grip = document.createElement('div');
    grip.id = 'ov-resize';
    grip.title = 'Drag to resize · double-click to reset';
    pane.prepend(grip);
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      document.body.classList.add('ov-resizing');
      const move = (ev) => root.style.setProperty('--ov-w', clamp(startW - (ev.clientX - startX)) + 'px');
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('ov-resizing');
        try { localStorage.setItem('cce.ovWidth', String(clamp(pane.getBoundingClientRect().width))); } catch { /* private mode */ }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    grip.addEventListener('dblclick', () => {
      root.style.removeProperty('--ov-w');
      try { localStorage.removeItem('cce.ovWidth'); } catch { /* private mode */ }
    });
  })();

  // global shortcuts
  document.addEventListener('keydown', (e) => {
    // The active tab decides what copy/paste and Tab mean: a chat composer must
    // not have Ctrl+Shift+V hijacked by the PTY. #17
    const meta = tabRegistry.get(state.activeId);
    const inChat = !!(meta && meta.kind === 'chat');
    if (e.ctrlKey && e.shiftKey) {
      if (e.key === 'T') { e.preventDefault(); openNewSessionModal(); }
      else if (e.key === 'W') { e.preventDefault(); if (state.activeId) killSession(state.activeId); }
      // A second window. Nothing else claims Ctrl+Shift+N, so it is safe here
      // — and it must not swallow the T/W/C/V branches above.
      else if (String(e.key).toLowerCase() === 'n') { e.preventDefault(); openNewWindow(); }
      else if (e.key === 'C' && !inChat) {
        const s = state.sessions.get(state.activeId);
        if (s && s.term.hasSelection()) {
          navigator.clipboard.writeText(s.term.getSelection());
          e.preventDefault();
        }
      } else if (e.key === 'V' && !inChat) {
        e.preventDefault();
        navigator.clipboard.readText().then(t => {
          if (t && state.activeId) ccx.send('session:write', { id: state.activeId, data: t });
        });
      }
      return;
    }
    // Ctrl+Tab cycles every tab (chat and terminal alike), as documented. #16
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const ids = [...tabRegistry.keys()];
      if (ids.length > 1) {
        const next = mruCycle(ids, usedAt, state.activeId, e.shiftKey);
        if (next && next !== state.activeId) activateSession(next);
      }
      return;
    }
    // Ctrl+1..9 jump to a tab; Alt+1..6 open a tool tab in the split pane.
    const chord = chordAction(e, tabRegistry.size);
    if (chord) {
      if (chord.tab !== undefined) {
        e.preventDefault();
        const id = [...tabRegistry.keys()][chord.tab];
        if (id) { switchView('conversations'); activateSession(id); }
      } else {
        e.preventDefault();
        openSplitTab(chord.split);
      }
      return;
    }
    // Escape in the sidebar search clears it and hands focus back to the chat.
    if (e.key === 'Escape') {
      const search = document.querySelector('#convo-drop .convo-search');
      if (search && document.activeElement === search) {
        e.preventDefault();
        if (search.value) { search.value = ''; renderConversationList(); }
        else { search.blur(); const m = tabRegistry.get(state.activeId); if (m && m.focus) m.focus(); }
        return;
      }
    }
    if (e.ctrlKey && String(e.key).toLowerCase() === 'b') {   // conversation list #34
      e.preventDefault();
      toggleConversations();
    }
    if (e.altKey && String(e.key).toLowerCase() === 'v') {   // split view #44
      e.preventDefault();
      toggleSplit();
    }
    if (e.ctrlKey && e.key === '\\') {   // hide/show the left sidebar #feat-desktop-layout
      e.preventDefault();
      toggleSidebar();
    }
    if (e.ctrlKey && !e.shiftKey && String(e.key).toLowerCase() === 'f') {   // find in transcript #feat-find
      const m = tabRegistry.get(state.activeId);
      if (m && m.kind === 'chat' && window.Chat) {
        const c = Chat.chats.get(state.activeId);
        if (c) { e.preventDefault(); Chat.showFind(c); }
      }
    }
    // Command palette from anywhere in a chat tab.
    const mod = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
    const k = String(e.key).toLowerCase();
    if (mod && k === 'k' && window.Chat) {
      const c = inChat ? Chat.chats.get(state.activeId) : null;
      // Only when focus is in the chat itself (or nowhere). The side-panel
      // shell, the diff editor, other views and dialogs keep their own keys.
      const t = e.target;
      const home = !t || t === document.body || t === document.documentElement
        || (c && c.pane.contains(t)) || !!(t.closest && t.closest('.palette-back'));
      const own = !!(t && t.closest && t.closest('.xterm, .monaco-editor'));
      if ((!c || state.view !== 'conversations' || (home && !own)) && !(t && t.closest && t.closest('.xterm, .monaco-editor, .modal'))) {
        e.preventDefault();
        Chat.openPalette(c);
      }
    }
  });

  // keep active terminal fitted
  new ResizeObserver(() => {
    const s = state.sessions.get(state.activeId);
    if (s && s.alive) { try { s.fit.fit(); } catch { /* hidden */ } }
  }).observe($('#terminals'));
}

(async function boot() {
  wireChrome();
  const [info, provAll, settingsRes, connPresets] = await Promise.all([
    ccx.invoke('app:info'),
    ccx.invoke('providers:all'),
    ccx.invoke('settings:get'),
    ccx.invoke('connectors:presets'),
  ]);
  if (!(info.ok && provAll.ok && settingsRes.ok)) {
    toast('Failed to load configuration: ' + (info.error || provAll.error || settingsRes.error), 'err');
    return;
  }
  state.info = { appVersion: info.appVersion, electron: info.electron, claude: info.claude, home: info.home };
  state.providers = { presets: provAll.presets, catalog: provAll.catalog || [], modelsdev: provAll.modelsdev || null, instances: provAll.instances, defaultUid: provAll.defaultUid };
  state.leanPresets = (provAll.leanPresets || (settingsRes.leanPresets || []));
  state.leanAllTools = (provAll.leanAllTools || settingsRes.leanAllTools || []);
  state.settings = settingsRes.settings;
  applyTheme(state.settings.theme);   // #47
  applyThinkingDisplay();
  setLang(state.settings.lang || 'en');   // item 26: stored language wins over en
  applyLang();
  state.connectorPresets = connPresets.presets;
  state.booting = false;

  $('#foot-info').textContent = (state.info.claude && state.info.claude.found)
    ? `claude ${state.info.claude.version}\nCCE v${state.info.appVersion} · Electron ${state.info.electron}`
    : `CCE v${state.info.appVersion} · Electron ${state.info.electron}`;

  renderClaudeBanner();
  // Main re-probes the CLI when the window regains focus (a startup race with a
  // claude self-update used to stick the "not found" banner until restart).
  if (ccx.onClaudeDetected) ccx.onClaudeDetected((c) => {
    state.info = { ...state.info, claude: c };
    $('#foot-info').textContent = (c && c.found)
      ? `claude ${c.version}\nCCE v${state.info.appVersion} · Electron ${state.info.electron}`
      : `CCE v${state.info.appVersion} · Electron ${state.info.electron}`;
    renderClaudeBanner();
  });
  // Sleep made the last connector health check a guess: forget it and, if the
  // connectors view is what the user is looking at, re-run the check. #fix-resume
  if (ccx.onAppResumed) ccx.onAppResumed(() => {
    invalidateConnectorStatus();
    if (state.view === 'connectors') refreshMcpList();
  });
  if (window.__CCE_SMOKE || window.__CCE_DEBUG) setTimeout(() => console.log('[monaco]', !!(window.monaco && window.monaco.editor)), 3000);
  // Connectors and Settings draw themselves the first time their view opens (switchView).
  switchView('terminal');

  // A blank home page with a folder picker, the way the desktop app opens. A
  // chat starts only once a folder is picked; autoOpenWelcomeChat restores
  // the old welcome chat in the default folder.
  initHome();
  if (state.settings.autoOpenWelcomeChat) {
    await Chat.createSession({
      cwd: state.settings.defaultCwd || '~',
      providerUid: state.providers.defaultUid,
    });
  }
})();
