// Claude Code Enhanced — renderer. Vanilla JS; xterm UMD globals.
'use strict';

const TermCtor = window.Terminal;
const FitCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
const LinksCtor = (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) || window.WebLinksAddon;

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * An element whose content is trusted markup (an inline SVG from CCEIcons).
 *
 * `el()` assigns textContent on purpose — that is what makes it safe to pass
 * model and server strings. Icons are the one thing that must be parsed, so they
 * get their own constructor instead of turning `el()` into an innerHTML helper
 * for everyone. #54
 */
function elIcon(tag, cls, markup) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.innerHTML = String(markup || '');
  return n;
}
function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, msg);
  // An error toast is the app telling you something went wrong; a screen-reader
  // user was never told, because the toast area was not a live region. #53
  if (kind === 'err') t.setAttribute('role', 'alert');
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => t.remove(), 4000);
}
/**
 * Text input dialog. Electron does not implement window.prompt (it throws), so
 * Rename and re-ask silently did nothing. Resolves to the text, or null.
 */
window.askText = function askText(title, value = '', { multiline = false, okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', '', title));
    const field = el(multiline ? 'textarea' : 'input', 'ask-field');
    if (multiline) field.rows = 6; else field.type = 'text';
    field.value = value;
    field.setAttribute('aria-label', title);
    modal.appendChild(field);
    const row = el('div', 'modal-actions');
    const cancel = el('button', 'btn', 'Cancel');
    const ok = el('button', 'btn primary', okLabel);
    row.appendChild(cancel); row.appendChild(ok);
    modal.appendChild(row);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(field.value));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); done(field.value); }
    });
    setTimeout(() => { field.focus(); field.select(); }, 0);
  });
};
// Real HTML escaping: several call sites interpolate provider- and
// server-supplied strings into innerHTML, and MCP server names are untrusted. #7
/**
 * Fill every <span data-icon="name"> in the static markup with its SVG. The
 * HTML stays readable and the icon set stays in one file; emoji cannot do this
 * because they cannot inherit colour or follow the theme. #54
 */
function paintDeclaredIcons(root) {
  const scope = root || document;
  for (const host of scope.querySelectorAll('[data-icon]')) {
    if (host.dataset.iconPainted) continue;
    const svg = CCEIcons.svg(host.dataset.icon);
    if (!svg) continue;
    host.innerHTML = svg;
    host.dataset.iconPainted = '1';
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const state = {
  info: null,
  settings: null,
  providers: { presets: [], catalog: [], modelsdev: null, instances: [], defaultUid: null },
  leanPresets: [],
  leanAllTools: [],
  theme: 'dark',
  connectorPresets: [],
  sessions: new Map(),   // id -> { term, fit, tabEl, pane, alive, label, cwd, provider }
  activeId: null,
  view: 'terminal',
  booting: true,
};

const TERM_THEME = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ff9a3c',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(255,154,60,0.32)',
  black: '#0b0b0b', red: '#d2626a', green: '#7dc98f', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c8c8d4',
  brightBlack: '#61627a', brightRed: '#e8878d', brightGreen: '#9ddba7',
  brightYellow: '#eecb8b', brightBlue: '#9cc2ff', brightMagenta: '#cdb4fc',
  brightCyan: '#a8dcff', brightWhite: '#ffffff',
};

/* ================= view switching ================= */

function switchView(view) {
  // 'terminal' is the old name for the Conversations workspace; keep it working
  // for any caller that has not been updated.
  if (view === 'terminal') view = 'conversations';
  state.view = view;
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v =>
    v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'conversations') {
    const s = state.sessions.get(state.activeId);
    if (s) { s.fit && s.fit.fit(); s.term && s.term.focus(); }
  }
  if (view === 'usage') renderUsage();
  if (view === 'providers') renderProviders();
  if (view === 'connectors') {
    renderConnectors();
    // Health checks take a while; re-run on opening only if the last result is stale.
    if (Date.now() - connectorCheckedAt > 60_000 && !connectorChecking) refreshMcpList();
  }
  if (view === 'settings') renderSettings();
}

/* ================= sidebar toggle (#feat-desktop-layout) ================= */

let sidebarHidden = false;
function toggleSidebar(force) {
  sidebarHidden = force !== undefined ? force : !sidebarHidden;
  document.body.classList.toggle('sb-hidden', sidebarHidden);
  try { localStorage.setItem('cce.sidebarHidden', sidebarHidden ? '1' : '0'); } catch { /* private mode */ }
}

/* ================= tabs & terminals ================= */

// Unified tab registry so chat tabs (Agent SDK) and terminal tabs (PTY) coexist.
const tabRegistry = new Map(); // id -> { kind: 'pty'|'chat', pane, tabEl, focus }
window.__tabs = tabRegistry;
window.__activate = (id) => {
  for (const [sid, meta] of tabRegistry) {
    meta.pane.classList.toggle('active', sid === id);
    meta.tabEl.classList.toggle('active', sid === id);
  }
  // The active chat's header (folder, repo, branch, provider, actions) sits in the
  // quick row beside "Closed tab", so the top is two lines: tabs, then actions + chat.
  const slot = document.querySelector('#qa-chat-slot');
  if (slot) {
    const out = slot.firstElementChild;
    if (out && out.__pane) out.__pane.prepend(out);
    const meta = tabRegistry.get(id);
    const head = meta && meta.pane.querySelector('.chat-header');
    if (head) { head.__pane = meta.pane; slot.appendChild(head); }
  }
  // Chat tabs activate through here too, not activateSession, so this is the one
  // place that knows the active tab. Without it the side panel kept showing the
  // home folder and "start a chat" while a chat was open.
  const changed = state.activeId !== id;
  state.activeId = id;
  // Preview and terminal do not depend on the tab; re-rendering them reloaded
  // the iframe on every switch.
  const kind = document.querySelector('#split-kind')?.value || 'changes';
  if (changed) {
    renderOverview();
    if (document.querySelector('#main.split') && kind !== 'preview' && kind !== 'terminal') renderSplit();
  }
};
window.__activateNext = (closedId) => {
  tabRegistry.delete(closedId);
  if (state.activeId === closedId) {
    const next = [...tabRegistry.keys()].pop();
    if (next) activateSession(next);
    else { state.activeId = null; $('#st-provider').textContent = '—'; $('#st-cwd').textContent = ''; }
  }
};
window.Chat = Chat;

/* ================= theme (#47) ================= */

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  state.theme = t;
  // Code blocks and diffs are painted by Monaco; keep its theme in step with the app's.
  if (window.monaco && window.monaco.editor && typeof window.monaco.editor.setTheme === 'function') {
    window.monaco.editor.setTheme(t === 'light' ? 'vs' : 'vs-dark');
  }
}
window.applyTheme = applyTheme;

/* ================= conversation list (#34) ================= */
/*
 * One list for everything: open chat/terminal tabs and every stored session.
 * Grouped by the folder the conversation ran in, with time buckets inside
 * each group. Clicking a row resumes that session live.
 */

let convoSessions = [];

/** Folders present in the current list, most recent first. */
function convoFolders() {
  const counts = new Map();
  for (const s of convoSessions) {
    const key = String(s.cwd || s.folder || '~');
    const cur = counts.get(key);
    if (!cur || s.mtime > cur.mtime) counts.set(key, { cwd: key, mtime: s.mtime });
  }
  return [...counts.values()].sort((a, b) => b.mtime - a.mtime);
}

/** "3 minutes ago" style label, shorter than the old 1m/1h/1d buckets. */
function convoAge(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 604800) return Math.round(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}

/** Time buckets used inside each folder group. */
const CONVO_BUCKETS = [
  ['Today', 24 * 3600e3],
  ['Yesterday', 48 * 3600e3],
  ['Earlier this week', 7 * 86400e3],
  ['Older', Infinity],
];

/*
 * Categories: All · Open · Pinned · Archived. Pins are a per-machine
 * convenience (localStorage); archive is a tag on the transcript itself.
 */
let convoView = 'all';
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
function pinnedSessions() { return new Set(lsGet('cce.pinned', [])); }
function togglePin(sessionId) {
  const set = pinnedSessions();
  if (set.has(sessionId)) set.delete(sessionId); else set.add(sessionId);
  lsSet('cce.pinned', [...set]);
  return set.has(sessionId);
}
function convoGroupBy() {
  return (document.querySelector('#convo-drop .convo-groupby') || {}).value || 'folder';
}
function paintConvoTabs(pinned, openIds) {
  const tabs = document.querySelectorAll('#convo-drop .convo-tab');
  const counts = {
    all: convoSessions.filter((s) => s.tag !== 'archived').length,
    open: convoSessions.filter((s) => openIds.has(s.sessionId)).length,
    pinned: convoSessions.filter((s) => pinned.has(s.sessionId)).length,
    archived: convoSessions.filter((s) => s.tag === 'archived').length,
  };
  for (const t of tabs) {
    const on = t.dataset.view === convoView;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    const n = t.querySelector('.ct-n');
    if (n) n.textContent = String(counts[t.dataset.view] || 0);
  }
}
function collapsedFolders() { return new Set(lsGet('cce.convoCollapsed', [])); }

// A search token: a later search wins over an earlier one that is still
// running, so a fast typist never sees the answer to an old query.
let convoSearchToken = 0;

/**
 * Search the stored transcripts for text the conversation list does not
 * know about. The main process does the scan on a worker thread.
 */
async function searchTranscripts(query, foot) {
  if (!foot) return;
  const token = ++convoSearchToken;
  const before = foot.textContent;
  foot.textContent = 'Searching the stored transcripts…';
  try {
    const res = await ccx.invoke('chats:search', { query, limit: 50 });
    // A newer search started, or the list was re-rendered: drop this answer.
    if (token !== convoSearchToken) return;
    const n = Number((res && res.count) || 0);
    foot.textContent = n
      ? n + ' transcript ' + (n === 1 ? 'entry' : 'entries') + ' mention "' + query + '"'
      : (before || 'Nothing matches.');
  } catch {
    if (token !== convoSearchToken) return;
    foot.textContent = before || 'Nothing matches.';
  }
}

function renderConversationList() {  // Async data can land after the window is gone; bail out instead of throwing.
  if (typeof document === 'undefined') return;
  const root = document.querySelector('#convo-drop #convo-list');
  if (!root) return;
  const foot = document.querySelector('#convo-drop #convo-foot');
  const q = String((document.querySelector('#convo-drop .convo-search') || {}).value || '').trim().toLowerCase();
  const folder = (document.querySelector('#convo-drop .convo-filter') || {}).value || '';
  const sort = (document.querySelector('#convo-drop .convo-sort') || {}).value || 'new';

  // Archived conversations stay on disk but out of the way until asked for.
  const showArchived = (document.querySelector('#convo-drop .convo-archived') || {}).checked === true;
  const view = convoView;
  const pinned = pinnedSessions();
  const openIds = new Set([...tabRegistry.values()].map((m) => m.sessionId).filter(Boolean));
  let items = convoSessions.filter((s) => {
    if (view === 'archived') { if (s.tag !== 'archived') return false; }
    else if (!showArchived && s.tag === 'archived') return false;
    if (view === 'pinned' && !pinned.has(s.sessionId)) return false;
    if (view === 'open' && !openIds.has(s.sessionId)) return false;
    return !q || String(s.preview || '').toLowerCase().includes(q)
      || String(s.cwd || s.folder || '').toLowerCase().includes(q)
      || String(s.branch || '').toLowerCase().includes(q);
  });
  if (folder) items = items.filter((s) => String(s.cwd || s.folder || '~') === folder);
  paintConvoTabs(pinned, openIds);

  // Sort first, then bucket: the bucket pass preserves this order inside groups.
  if (sort === 'new') items.sort((a, b) => b.mtime - a.mtime);
  else if (sort === 'old') items.sort((a, b) => a.mtime - b.mtime);
  else items.sort((a, b) => String(a.preview || '').localeCompare(String(b.preview || '')));

  root.innerHTML = '';
  if (foot) {
    foot.textContent = items.length === convoSessions.length
      ? convoSessions.length + ' conversation' + (convoSessions.length === 1 ? '' : 's')
      : items.length + ' of ' + convoSessions.length + ' conversations';
  }
  if (!items.length) {
    const empty = { pinned: 'Nothing pinned — use ▾ → Pin on a conversation you come back to.',
      open: 'No open conversations.', archived: 'Nothing archived.' }[view];
    root.appendChild(el('div', 'convo-empty hint', q || folder ? 'Nothing matches.' : (empty || 'No conversations yet.')));
    // The list only knows the previews. When a search finds nothing there,
    // the stored transcripts are searched too — on a worker thread in the
    // main process, so a big history does not freeze the window. #t0-workers
    if (q && q.length >= 3 && !folder) searchTranscripts(q, foot);
    return;
  }

  // Pinned rows sit in their own block on top of the All view.
  if (view === 'all' && !q) {
    const pins = items.filter((s) => pinned.has(s.sessionId));
    if (pins.length) {
      const sec = el('div', 'convo-group convo-pinned');
      const head = el('div', 'convo-sec');
      head.appendChild(elIcon('span', 'cs-name', CCEIcons.svg('star', 12) + ' Pinned'));
      head.appendChild(el('span', 'cs-path', ''));
      head.appendChild(el('span', 'cs-count', String(pins.length)));
      sec.appendChild(head);
      const listEl = el('div', 'convo-rows');
      for (const s of pins) listEl.appendChild(convoRow(s, String(s.cwd || s.folder || '~')));
      sec.appendChild(listEl);
      root.appendChild(sec);
      items = items.filter((s) => !pinned.has(s.sessionId));
    }
  }

  // Group by date: one list, time buckets, folder shown on each row.
  if (convoGroupBy() === 'date') {
    const now0 = Date.now();
    let prev = 0;
    for (const [label, within] of CONVO_BUCKETS) {
      const inBucket = items.filter((s) => now0 - s.mtime <= within && now0 - s.mtime > prev);
      prev = within;
      if (!inBucket.length) continue;
      const sec = el('div', 'convo-group');
      const head = el('div', 'convo-sec');
      head.appendChild(el('span', 'cs-name', label));
      head.appendChild(el('span', 'cs-path', ''));
      head.appendChild(el('span', 'cs-count', String(inBucket.length)));
      sec.appendChild(head);
      const listEl = el('div', 'convo-rows');
      for (const s of inBucket) listEl.appendChild(convoRow(s, String(s.cwd || s.folder || '~')));
      sec.appendChild(listEl);
      root.appendChild(sec);
    }
    return;
  }

  // Group by folder, folders ordered by their newest conversation.
  const groups = new Map();
  for (const s of items) {
    const key = String(s.cwd || s.folder || '~');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  // Folders follow the chosen direction too, so the whole list reads one way.
  const byNewest = sort !== 'old';
  const ordered = [...groups.entries()].sort((a, b) =>
    byNewest ? b[1][0].mtime - a[1][0].mtime : a[1][0].mtime - b[1][0].mtime);

  const now = Date.now();
  const collapsed = collapsedFolders();
  for (const [cwd, rows] of ordered) {
    const sec = el('div', 'convo-group');
    const head = el('button', 'convo-sec');
    const isCollapsed = collapsed.has(cwd) && !q;
    head.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    head.appendChild(elIcon('span', 'cs-caret', CCEIcons.svg('chevron', 12)));
    head.appendChild(el('span', 'cs-name', basenameOf(cwd)));
    head.appendChild(el('span', 'cs-path', cwd === '~' ? '~' : cwd));
    head.appendChild(el('span', 'cs-count', String(rows.length)));
    head.title = cwd + ' — click to collapse / expand';
    sec.appendChild(head);
    const listEl = el('div', 'convo-rows');
    if (isCollapsed) { listEl.classList.add('hidden'); sec.classList.add('collapsed'); }
    head.addEventListener('click', () => {
      const set = collapsedFolders();
      const nowCollapsed = !set.has(cwd);
      if (nowCollapsed) set.add(cwd); else set.delete(cwd);
      lsSet('cce.convoCollapsed', [...set]);
      listEl.classList.toggle('hidden', nowCollapsed);
      sec.classList.toggle('collapsed', nowCollapsed);
      head.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
    });
    sec.appendChild(listEl);

    // Time buckets inside the folder, preserving the chosen sort within a bucket.
    let bi = 0;
    while (bi < CONVO_BUCKETS.length) {
      const [label, within] = CONVO_BUCKETS[bi];
      const prev = bi === 0 ? 0 : CONVO_BUCKETS[bi - 1][1];
      const inBucket = rows.filter((s) => now - s.mtime <= within && now - s.mtime > prev);
      if (inBucket.length) {
        const bhead = el('div', 'convo-bucket', label);
        listEl.appendChild(bhead);
        for (const s of inBucket) listEl.appendChild(convoRow(s, cwd));
      }
      bi++;
    }
    root.appendChild(sec);
  }
}

/** One conversation row: preview, age, and a ▾ actions menu. */
// An already-open transcript must be focused, not re-opened: a second live
// session on the same file races two writers on one transcript.
function focusIfOpen(sessionId) {
  if (!sessionId) return false;
  const hit = [...tabRegistry.entries()].find(([, m]) => m.sessionId === sessionId);
  if (!hit) return false;
  activateSession(hit[0]);
  return true;
}

function convoRow(s, cwd) {
  const row = el('div', 'convo-row');
  row.title = (s.preview || '(empty session)') + '\n' + cwd;
  const main = el('div', 'convo-main');
  main.appendChild(el('div', 'convo-preview', s.preview || '(empty session)'));
  // gitBranch comes free with the SDK's index; knowing which branch a session
  // ended on is what makes a list of 200 rows navigable.
  main.appendChild(el('div', 'convo-meta',
    basenameOf(cwd) + (s.branch ? ' · ' + s.branch : '') + ' · ' + convoAge(s.mtime)));
  row.appendChild(main);

  // Live tab state, so the row shows which conversations are already open.
  const openTab = [...tabRegistry.entries()].find(([, meta]) =>
    meta.sessionId === s.sessionId);
  if (openTab) {
    row.classList.add('is-open');
    row.appendChild(el('span', 'chip open-chip', 'open'));
  }
  if (s.tag === 'archived') row.appendChild(el('span', 'chip arch-chip', 'archived'));
  if (pinnedSessions().has(s.sessionId)) {
    const star = elIcon('span', 'pin-mark', CCEIcons.svg('star', 12));
    star.title = 'Pinned';
    row.appendChild(star);
  }

  const menu = elIcon('button', 'convo-more', CCEIcons.svg('dots', 15));
  menu.title = 'Conversation actions';
  // A glyph is not an accessible name; `title` alone is unreliable, so the
  // button is named for assistive tech too. #53
  menu.setAttribute('aria-label', 'Conversation actions');
  menu.setAttribute('aria-haspopup', 'true');
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    openConvoMenu(menu, s, cwd);
  });
  row.appendChild(menu);

  // A row was a bare div with a click handler: no tab stop, no Enter, no role.
  // Now it is a real control. #53
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', (s.preview || 'Conversation') + ' — ' + basenameOf(cwd));
  const openIt = () => {
    if (!focusIfOpen(s.sessionId)) Chat.createSession({ cwd, resume: s.sessionId });
    toggleConversations(false);
    switchView('conversations');
  };
  row.addEventListener('click', openIt);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); openIt(); }
    else if (e.key === ' ') { e.preventDefault(); openConvoMenu(menu, s, cwd); }
  });
  return row;
}

/** The ▾ dropdown for one conversation. */
function openConvoMenu(anchor, s, cwd) {
  document.querySelectorAll('.convo-menu').forEach(m => m.remove());
  const menu = el('div', 'convo-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Conversation actions');
  const ICONS = { Open: 'play', Fork: 'fork', 'Rename…': 'pencil', Archive: 'archive', Unarchive: 'archive',
    Transcript: 'notebook', Export: 'download', 'New chat in this folder': 'plus', Delete: 'trash', Pin: 'star', Unpin: 'star' };
  const add = (label, hint, run) => {
    const b = el('button', 'convo-menu-item');
    b.setAttribute('role', 'menuitem');
    b.appendChild(elIcon('span', 'cm-ico', CCEIcons.svg(ICONS[label] || 'dots', 14)));
    b.appendChild(el('span', 'cm-label', label));
    if (hint) b.appendChild(el('span', 'cm-hint', hint));
    b.addEventListener('click', () => { menu.remove(); run(); });
    menu.appendChild(b);
    return b;
  };
  add('Open', 'resume live', () => {
    if (!focusIfOpen(s.sessionId)) Chat.createSession({ cwd, resume: s.sessionId });
    toggleConversations(false);
    switchView('conversations');
  });
  add('Fork', 'branch a copy', () => {
    Chat.createSession({ cwd, resume: s.sessionId, fork: true });
    toggleConversations(false);
    switchView('conversations');
  });
  const isPinned = pinnedSessions().has(s.sessionId);
  add(isPinned ? 'Unpin' : 'Pin', isPinned ? 'remove from the top' : 'keep it on top', () => {
    const on = togglePin(s.sessionId);
    renderConversationList();
    toast(on ? 'Pinned' : 'Unpinned', 'ok');
  });
  add('Rename…', 'name it yourself', async () => {
    const title = await window.askText('Name this conversation', s.preview || '', { okLabel: 'Rename' });
    if (!title || !title.trim()) return;
    const r = await ccx.invoke('session:rename', { sessionId: s.sessionId, title: title.trim(), cwd });
    if (!r.ok) return toast(r.error || 'rename failed', 'err');
    s.preview = title.trim();
    s.renamed = true;
    renderConversationList();
    toast('Renamed', 'ok');
  });
  // Archive hides the row without touching the transcript, so a mistake is
  // always recoverable — unlike Delete below.
  add(s.tag === 'archived' ? 'Unarchive' : 'Archive', s.tag === 'archived' ? 'bring it back' : 'hide, keep on disk',
    async () => {
      const next = s.tag === 'archived' ? '' : 'archived';
      const r = await ccx.invoke('session:tag', { sessionId: s.sessionId, tag: next, cwd });
      if (!r.ok) return toast(r.error || 'failed', 'err');
      s.tag = next;
      renderConversationList();
      toast(next ? 'Archived — find it under the Archived tab' : 'Restored', 'ok');
    });
  add('Transcript', 'read it first', () => showTranscript(s, cwd));
  add('Export', 'markdown file', async () => {
    const r = await ccx.invoke('chat:export', { cwd, sessionId: s.sessionId });
    if (r.ok && r.saved) toast('Saved ' + r.path, 'ok');
    else if (!r.ok) toast(r.error, 'err');
  });
  add('New chat in this folder', basenameOf(cwd), () => {
    Chat.createSession({ cwd });
    toggleConversations(false);
    switchView('conversations');
  });
  const del = add('Delete', 'removes from disk', async () => {
    // An open tab keeps writing this transcript; close it so the delete sticks.
    for (const [id, meta] of [...tabRegistry]) {
      if (meta.sessionId === s.sessionId && meta.kind === 'chat') await Chat.closeChat(id);
    }
    const r = await ccx.invoke('chat:delete', { cwd: s.cwd || cwd, sessionId: s.sessionId });
    if (!r.ok) return toast(r.error, 'err');
    convoSessions = convoSessions.filter((x) => x.sessionId !== s.sessionId);
    renderConversationList();
    toast('Conversation deleted', 'ok');
  });
  del.classList.add('danger');
  let armed = false;
  del.addEventListener('click', (e) => {
    if (!armed) { e.stopPropagation(); armed = true; del.querySelector('.cm-hint').textContent = 'sure?'; setTimeout(() => { armed = false; }, 2500); return; }
  }, true);

  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = r.bottom + 4 + 'px';
  menu.style.left = Math.max(8, r.right - 240) + 'px';
  document.body.appendChild(menu);
  const away = (e) => {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', away);
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}

/** Read-only transcript modal, with Resume / Fork at the bottom. */
async function showTranscript(s, cwd) {
  const overlay = el('div', 'modal-overlay');
  // A dialog must say so: role + aria-modal, or a screen reader treats the
  // backdrop as ordinary content and keeps reading the page behind it. #53
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const modal = el('div', 'modal wide');
  modal.appendChild(el('h3', '', (s.preview || 'Conversation').slice(0, 90)));
  modal.appendChild(el('div', 'hint', cwd + ' · ' + new Date(s.mtime).toLocaleString()));
  const body = el('div', 'transcript-pre');
  body.textContent = 'loading…';
  modal.appendChild(body);
  let items = [];
  const r = await ccx.invoke('chat:transcript', { cwd, sessionId: s.sessionId });
  if (r && r.ok && r.items) {
    items = r.items;
    body.innerHTML = '';
    // Each user message carries the uuid forkSession needs, so "branch from
    // here" is available at any point — not just the latest message. #52
    for (const it of items) {
      const row = el('div', 'tx-row tx-' + it.t);
      const txt = it.t === 'user' ? it.text
        : it.t === 'assistant' ? it.text
          : it.t === 'thinking' ? '(thinking) ' + String(it.text).slice(0, 400)
            : '[' + it.name + '] ' + JSON.stringify(it.input || {}).slice(0, 300);
      row.appendChild(el('div', 'tx-who', it.t === 'user' ? 'You' : it.t === 'assistant' ? 'Claude' : it.t));
      row.appendChild(el('div', 'tx-text', String(txt || '')));
      if (it.t === 'user' && it.uuid) {
        const br = el('button', 'btn tiny', 'branch from here');
        br.title = 'Copy this conversation up to this message, then continue in a new session';
        br.addEventListener('click', async () => {
          br.disabled = true;
          const f = await ccx.invoke('session:fork', { sessionId: s.sessionId, upToMessageId: it.uuid, cwd });
          if (!f.ok) { toast(f.error || 'fork failed', 'err'); br.disabled = false; return; }
          overlay.remove();
          toast('Branched — opening the copy', 'ok');
          Chat.createSession({ cwd, resume: f.sessionId });
          toggleConversations(false);
          switchView('conversations');
        });
        row.appendChild(br);
      }
      body.appendChild(row);
    }
    if (!items.length) body.appendChild(el('div', 'hint', '(empty)'));
  } else {
    body.textContent = 'could not read this transcript' + (r && r.error ? ': ' + r.error : '');
  }
  const actions = el('div', 'actions');
  const close = el('button', 'btn', 'Close');
  close.addEventListener('click', () => overlay.remove());
  const resume = el('button', 'btn primary', 'Resume');
  resume.addEventListener('click', () => {
    overlay.remove();
    Chat.createSession({ cwd, resume: s.sessionId });
    toggleConversations(false);
    switchView('conversations');
  });
  const fork = el('button', 'btn', 'Fork');
  fork.addEventListener('click', () => {
    overlay.remove();
    Chat.createSession({ cwd, resume: s.sessionId, fork: true });
    toggleConversations(false);
    switchView('conversations');
  });
  actions.appendChild(close); actions.appendChild(fork); actions.appendChild(resume);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  document.querySelector('#modal-root').appendChild(overlay);
}

/** Repopulate the folder dropdown, preserving the current selection. */
function refreshConvoFolderFilter() {
  // The list data arrives asynchronously; the window may be gone by then
  // (tests close it, and so does a fast user). Bail out instead of throwing.
  if (typeof document === 'undefined') return;
  const sel = document.querySelector('#convo-drop .convo-filter');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '';
  const all = el('option', '', 'all folders');
  all.value = '';
  sel.appendChild(all);
  for (const f of convoFolders()) {
    const o = el('option', '', basenameOf(f.cwd) + '  (' + f.cwd + ')');
    o.value = f.cwd;
    sel.appendChild(o);
  }
  sel.value = keep;
}

async function loadConversationList() {
  const r = await ccx.invoke('chats:index');
  if (r.ok) convoSessions = r.sessions || [];
  refreshConvoFolderFilter();
  renderConversationList();
}

/** Show or hide the Conversations dropdown. Opens with a fresh disk read. */
function toggleConversations(force) {
  const drop = ensureConvoDrop();
  const open = force !== undefined ? force : drop.classList.contains('hidden');
  drop.classList.toggle('hidden', !open);
  document.querySelector('#btn-convo-drop')?.classList.toggle('active', open);
  if (open) {
    loadConversationList();
    drop.querySelector('.convo-search')?.focus();
  }
}

window.toggleConversations = toggleConversations;

/** Build the dropdown panel once; all list markup lives here, not in index.html. */
function ensureConvoDrop() {
  let drop = document.querySelector('#convo-drop');
  if (drop) return drop;
  drop = el('div', 'hidden');
  drop.id = 'convo-drop';
  drop.innerHTML = `
    <div class="convo-title">
      <span class="ico" data-icon="layers"></span><b>Conversations</b>
      <span class="spacer"></span>
      <button class="icon-btn" id="btn-convo-new" title="New chat (Ctrl+Shift+T)" aria-label="New chat"><span data-icon="plus"></span></button>
      <button class="icon-btn" id="btn-convo-refresh" title="Reload from disk" aria-label="Reload"><span data-icon="refresh"></span></button>
      <button class="icon-btn" id="btn-convo-hide" title="Close (Ctrl+B)" aria-label="Close"><span data-icon="close"></span></button>
    </div>
    <div class="convo-tabs" role="tablist" aria-label="Conversation categories">
      <button class="convo-tab active" role="tab" data-view="all">All <span class="ct-n">0</span></button>
      <button class="convo-tab" role="tab" data-view="open">Open <span class="ct-n">0</span></button>
      <button class="convo-tab" role="tab" data-view="pinned">Pinned <span class="ct-n">0</span></button>
      <button class="convo-tab" role="tab" data-view="archived">Archived <span class="ct-n">0</span></button>
    </div>
    <div class="convo-head">
      <input class="convo-search" type="text" placeholder="Search text, folder or branch…" />
      <select class="convo-groupby" title="Group by">
        <option value="folder">by project</option>
        <option value="date">by date</option>
      </select>
      <select class="convo-sort" title="Sort order">
        <option value="new">newest first</option>
        <option value="old">oldest first</option>
        <option value="name">by name</option>
      </select>
      <select class="convo-filter" title="Filter by project folder">
        <option value="">all folders</option>
      </select>
    </div>
    <div class="convo-list" id="convo-list"></div>
    <div class="convo-foot">
      <span id="convo-foot"></span>
      <label class="convo-archived-wrap" title="Also list archived conversations under All">
        <input class="convo-archived" type="checkbox" /> include archived
      </label>
    </div>`;
  document.querySelector('#view-conversations').appendChild(drop);
  paintDeclaredIcons(drop);
  drop.querySelector('#btn-convo-refresh').addEventListener('click', () => loadConversationList());
  drop.querySelector('#btn-convo-hide').addEventListener('click', () => toggleConversations(false));
  drop.querySelector('#btn-convo-new').addEventListener('click', () => { toggleConversations(false); document.querySelector('#qa-new')?.click(); });
  for (const t of drop.querySelectorAll('.convo-tab')) {
    t.addEventListener('click', () => { convoView = t.dataset.view; renderConversationList(); });
  }
  drop.querySelector('.convo-groupby').value = lsGet('cce.convoGroupBy', 'folder');
  drop.querySelector('.convo-groupby').addEventListener('change', (e) => { lsSet('cce.convoGroupBy', e.target.value); renderConversationList(); });
  drop.querySelector('.convo-search').addEventListener('input', () => renderConversationList());
  drop.querySelector('.convo-sort').addEventListener('change', () => renderConversationList());
  drop.querySelector('.convo-filter').addEventListener('change', () => renderConversationList());
  drop.querySelector('.convo-archived').addEventListener('change', () => renderConversationList());
  // Clicking outside closes it; Escape is handled globally.
  document.addEventListener('mousedown', (e) => {
    const d = document.querySelector('#convo-drop');
    if (!d || d.classList.contains('hidden')) return;
    if (d.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#btn-convo-drop')) return;
    if (e.target.closest && e.target.closest('.convo-menu')) return;
    toggleConversations(false);
  });
  return drop;
}

const basenameOf = (p) => String(p || '~').replace(/\/+$/, '').split('/').pop() || String(p || '');

/* ================= split view (#44) ================= */

let splitTerm = null;
let splitSession = null;  // { id } — the PTY behind the right-rail terminal
let tasksTimer = null;   // auto-refresh while the tasks panel is visible

/**
 * Give the right-rail terminal a real PTY. Without one it rendered an empty
 * grid and swallowed every keystroke.
 */
async function ensureSplitSession(cwd) {
  if (splitSession) return splitSession;
  const dir = String(cwd || '');
  let res;
  try {
    res = await ccx.invoke('session:create', { cwd: dir, type: 'shell', cols: 100, rows: 24 });
  } catch { return null; }
  if (!res || !res.id) return null;
  splitSession = { id: res.id };
  if (splitTerm) {
    splitTerm.onData((d) => ccx.send('session:write', { id: res.id, data: d }));
    splitTerm.onResize(({ cols, rows }) => ccx.invoke('session:resize', { id: res.id, cols, rows }));
  }
  return splitSession;
}

function activeCwd() {
  // A chat's folder can change after its tab was registered; ask the chat first.
  const chat = window.Chat && Chat.chats.get(state.activeId);
  if (chat && chat.cwd) return chat.cwd;
  const meta = tabRegistry.get(state.activeId);
  if (meta && meta.cwd) return meta.cwd;
  const s = state.sessions.get(state.activeId);
  return (s && s.cwd) || (state.settings && state.settings.defaultCwd) || '';
}

function toggleSplit(force) {
  const main = document.querySelector('#main');
  const pane = document.querySelector('#splitpane');
  if (!main || !pane) return;
  const open = force !== undefined ? force : !main.classList.contains('split');
  main.classList.toggle('split', open);
  // #splitpane is a SIBLING of #main, so the old `#main.split #splitpane`
  // selector never matched and the pane stayed display:none. #feat-desktop-layout
  document.body.classList.toggle('split-open', open);
  pane.style.width = open ? (pane.dataset.w || '380px') : '0';
  try { localStorage.setItem('cce.split', open ? (document.querySelector('#split-kind')?.value || 'changes') : 'closed'); } catch { /* private mode */ }
  if (open) renderSplit();
}

/**
 * The Overview is docked on the right at all times. Its cards redraw every few
 * seconds while the window is visible, and on demand when something it shows
 * changes (see refreshTasksRail).
 */
function renderOverview() {
  const body = document.querySelector('#overview-body');
  if (!body) return;
  renderTasks(body, activeCwd());
  if (!tasksTimer) {
    tasksTimer = setInterval(() => {
      const b = document.querySelector('#overview-body');
      if (!b || !document.body.contains(b)) { clearInterval(tasksTimer); tasksTimer = null; return; }
      // Hidden or minimized: no git spawn and no repaint for a panel nobody sees.
      if (document.hidden) return;
      renderTasks(b, activeCwd());
    }, 6000);
  }
}
window.renderOverview = renderOverview;

function renderSplit() {
  const kind = document.querySelector('#split-kind')?.value || 'changes';
  const body = document.querySelector('#split-body');
  if (!body) return;
  document.querySelectorAll('#splitpane .split-tab').forEach((t) => {
    const on = t.dataset.kind === kind;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (kind === 'terminal') {
    // A live shell, not a bare xterm: the pane used to create a terminal with
    // no PTY behind it, so it stayed blank and nothing could be typed. #feat-desktop-layout
    const active = state.sessions.get(state.activeId);
    const chat = Chat.chats.get(state.activeId);
    const cwd = (chat && chat.cwd) || (active && active.cwd)
      || (state.settings && state.settings.defaultCwd) || '';
    if (!splitTerm) {
      splitTerm = new TermCtor({
        fontSize: 12, scrollback: 2000, cursorBlink: true, theme: TERM_THEME,
        fontFamily: "'JetBrains Mono','Fira Code','DejaVu Sans Mono',monospace",
      });
      const fit = new FitCtor();
      splitTerm.loadAddon(fit);
      splitTerm._fit = fit;
    }
    if (splitTerm.element && body.contains(splitTerm.element)) {
      // already attached; nothing to do
    } else {
      body.innerHTML = '';
      try {
        if (splitTerm.element) body.appendChild(splitTerm.element);
        else splitTerm.open(body);
      } catch { try { splitTerm.open(body); } catch { /* already opened */ } }
    }
    try { splitTerm._fit.fit(); } catch { /* hidden */ }
    ensureSplitSession(cwd);
    return;
  }
  body.innerHTML = '';
  body.classList.remove('preview-body');
  const cwd2 = activeCwd();
  if (kind === 'files') {
    // File tree of the active folder, the way the desktop app's Files pane
    // lists the working directory. #feat-desktop-layout
    const filter = el('input', 'rail-filter');
    filter.placeholder = 'Filter files…';
    filter.setAttribute('aria-label', 'Filter files');
    body.appendChild(filter);
    const count = el('div', 'rail-sub hint', '');
    body.appendChild(count);
    const list = el('div', 'task-rows tall');
    list.appendChild(el('div', 'task-row hint', 'loading…'));
    body.appendChild(list);
    let files = [];
    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = files.filter((f) => !q || f.toLowerCase().includes(q));
      list.innerHTML = '';
      count.textContent = shown.length + ' of ' + files.length + ' files' + (shown.length > 500 ? ' (first 500 shown)' : '');
      if (!shown.length) { list.appendChild(el('div', 'task-row hint', files.length ? 'nothing matches' : 'no files')); return; }
      for (const f of shown.slice(0, 500)) {
        const row = el('button', 'task-row mono file-row');
        const slash = f.lastIndexOf('/');
        row.appendChild(el('span', 'fr-dir', slash >= 0 ? f.slice(0, slash + 1) : ''));
        row.appendChild(el('span', 'fr-name', slash >= 0 ? f.slice(slash + 1) : f));
        row.title = cwd2 + '/' + f + '\nclick: show in folder · shift+click: mention in the chat';
        row.addEventListener('click', (e) => {
          const chat = Chat.chats.get(state.activeId);
          if (e.shiftKey && chat && chat.composer) {
            chat.composer.value += (chat.composer.value && !/\s$/.test(chat.composer.value) ? ' ' : '') + '@' + f + ' ';
            chat.composer.focus();
          } else ccx.invoke('shell:reveal', { path: cwd2 + '/' + f });
        });
        list.appendChild(row);
      }
    };
    filter.addEventListener('input', paint);
    ccx.invoke('project:files', { cwd: cwd2 }).then((r) => {
      if (!body.contains(list)) return;
      files = (r && r.files) || [];
      paint();
    });
    return;
  }
  if (kind === 'changes') {
    const head = el('div', 'rail-sub hint', 'loading…');
    body.appendChild(head);
    const list = el('div', 'task-rows tall');
    body.appendChild(list);
    ccx.invoke('git:info', { cwd: cwd2 }).then((r) => {
      if (!body.contains(list)) return;
      const info = r && r.ok ? r : {};
      head.textContent = (info.repo ? info.repo : (info.branch ? 'local repository' : 'not a git repository'))
        + (info.branch ? ' · ' + info.branch : '')
        + (info.dirty ? ' · ' + info.dirty + ' uncommitted file(s)' : ' · clean');
      for (const f of (info.files || [])) {
        const row = el('button', 'task-row mono file-row');
        row.appendChild(el('span', 'fr-name', f));
        row.title = cwd2 + '/' + f;
        row.addEventListener('click', () => ccx.invoke('shell:reveal', { path: cwd2 + '/' + f }));
        list.appendChild(row);
      }
      const chat = Chat.chats.get(state.activeId);
      if ((info.files || []).length && chat && chat.send) {
        const acts = el('div', 'rail-actions');
        const rev = el('button', 'btn small', 'Ask Claude to review these changes');
        rev.addEventListener('click', () => {
          chat.composer.value = 'Review my uncommitted changes (git diff): correctness, tests, naming. Severity-ranked, file:line, concrete fixes.';
          chat.send();
        });
        acts.appendChild(rev);
        body.appendChild(acts);
      }
    });
    return;
  }
  if (kind === 'preview') {
    // Dev-server / artifact preview: sandboxed iframe with a URL bar. The
    // frame is an isolated origin — it cannot reach ccx. #feat-preview-pane
    body.classList.add('preview-body');
    const bar = el('div', 'preview-bar');
    const url = el('input', 'preview-url'); url.type = 'url';
    url.placeholder = 'http://localhost:3000 — dev server or file URL';
    url.setAttribute('aria-label', 'Preview URL');
    const go = el('button', 'btn small', 'load');
    const ext = el('button', 'btn small', '↗ open');
    ext.title = 'Open in the system browser';
    const frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
    try { const saved = localStorage.getItem('cce.previewUrl'); if (saved) url.value = saved; } catch { /* private mode */ }
    const nav = () => {
      let u = (url.value || '').trim();
      if (!u) return;
      if (!/^(https?|file):\/\//.test(u)) u = 'http://' + u;
      url.value = u;
      frame.src = u;
      try { localStorage.setItem('cce.previewUrl', u); } catch { /* private mode */ }
    };
    go.addEventListener('click', nav);
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') nav(); });
    ext.addEventListener('click', () => { if (/^https?:\/\//.test(url.value)) ccx.invoke('shell:openExternal', { url: url.value }); });
    bar.appendChild(url); bar.appendChild(go); bar.appendChild(ext);
    body.appendChild(bar);
    body.appendChild(frame);
    if (url.value) frame.src = url.value;
    return;
  }
  const chat = Chat.chats.get(state.activeId);
  const card = chat && chat.msgs ? chat.msgs.querySelector('.monaco-diff') : null;
  if (card && card.__diffData && window.Chat && window.Chat.renderDiff) {
    const diffEl = window.Chat.renderDiff(card.__diffData.name, card.__diffData.input, card.__diffData.source);
    body.appendChild(diffEl);
    if (diffEl.__init) diffEl.__init();
    body.appendChild(el('div', 'hint', 'Diff of the most recent file edit in this chat.'));
  } else if (card) {
    const clone = card.cloneNode(true);
    body.appendChild(clone);
    body.appendChild(el('div', 'hint', 'Diff of the most recent file edit in this chat.'));
  } else {
    body.appendChild(el('div', 'hint', 'No edit diff yet in this chat.'));
  }
}
/**
 * Tabs other than Overview can be hidden; the choice is remembered. Overview
 * is never offered here, it is always on.
 */
const HIDEABLE_TABS = [
  ['changes', 'Changes'], ['files', 'Files'], ['terminal', 'Terminal'], ['diff', 'Diff'], ['preview', 'Preview'],
];
function hiddenTabs() {
  const v = lsGet('cce.splitHidden', []);
  return new Set(Array.isArray(v) ? v.filter((k) => HIDEABLE_TABS.some(([id]) => id === k)) : []);
}
function applyHiddenTabs() {
  const hidden = hiddenTabs();
  document.querySelectorAll('#splitpane .split-tab').forEach((t) => {
    t.classList.toggle('hidden', hidden.has(t.dataset.kind));
  });
  // The open tab was just hidden: move to the first one still on offer, or
  // close the panel when every tab is hidden.
  const k = document.querySelector('#split-kind');
  if (k && hidden.has(k.value)) {
    const next = HIDEABLE_TABS.map(([id]) => id).find((id) => !hidden.has(id));
    if (next) { k.value = next; k.dispatchEvent(new Event('change')); }
    else toggleSplit(false);
  }
}
function initSplitTabMenu() {
  const btn = document.querySelector('#btn-split-tabs');
  if (!btn) return;
  applyHiddenTabs();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = document.querySelector('#split-tabs-menu');
    if (open) { open.remove(); return; }
    const menu = el('div', 'split-tabs-menu');
    menu.id = 'split-tabs-menu';
    menu.setAttribute('role', 'menu');
    const hidden = hiddenTabs();
    for (const [kind, label] of HIDEABLE_TABS) {
      const row = el('label', 'split-tabs-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden.has(kind);
      cb.addEventListener('change', () => {
        const now = hiddenTabs();
        if (cb.checked) now.delete(kind); else now.add(kind);
        lsSet('cce.splitHidden', [...now]);
        applyHiddenTabs();
      });
      row.appendChild(cb);
      row.appendChild(el('span', '', label));
      menu.appendChild(row);
    }
    btn.after(menu);
    const close = (ev) => {
      if (menu.contains(ev.target) || ev.target === btn) return;
      menu.remove();
      document.removeEventListener('click', close, true);
    };
    document.addEventListener('click', close, true);
  });
}
window.toggleSplit = toggleSplit;
window.renderSplit = renderSplit;
// The agent's task list changed: redraw the Overview now (coalesced, so a burst
// of TaskUpdate calls is one redraw), but only for the tab that is on screen.
const railTimers = {};
window.refreshTasksRail = (chatId, only = 'tasks') => {
  if (chatId && chatId !== state.activeId) return;
  clearTimeout(railTimers[only]);
  railTimers[only] = setTimeout(() => {
    const body = document.querySelector('#overview-body');
    if (body) renderTasks(body, activeCwd(), only);
  }, 150);
};

/**
 * Right-hand tasks panel — the desktop layout's coding-task column:
 * Environment (folder + git state), Context (active chat's window usage),
 * Tasks (the agent's todo list), Changes (uncommitted files). #feat-desktop-layout
 */
const CTX_VISIBLE = 5;
let ctxExpanded = false;
function renderTasks(target, cwd, only) {
  const chat = Chat.chats.get(state.activeId);
  // Build off-screen and swap once every async card has filled in: clearing
  // the live panel and refilling it piecemeal made it blink on each refresh.
  const body = document.createElement('div');
  const pending = [];
  // A single-card update must not cancel a full render that is still in flight.
  const seq = only ? -1 : (target.__taskSeq = (target.__taskSeq || 0) + 1);
  // Overview cards are always open (like the desktop app): the header is a
  // plain title row, the badge on the right summarises the card.
  const card = (key, title, icon) => {
    const c = el('section', 'task-card');
    c.dataset.card = key;
    const head = el('div', 'task-card-head');
    head.appendChild(elIcon('span', 'tc-ico', CCEIcons.svg(icon, 12)));
    const h = el('h4', '', title);
    head.appendChild(h);
    const badge = el('span', 'tc-badge', '');
    head.appendChild(badge);
    const inner = el('div', 'task-card-body');
    c.appendChild(head);
    c.appendChild(inner);
    c.h = h; c.badge = badge; c.inner = inner;
    body.appendChild(c);
    return c;
  };

  // Tasks: the agent's todo list from the active chat, with progress. Like the
  // desktop app: a progress line, the live step spelled out, then the checklist.
  // Reads chat.todos (normalized by the chat), not the drawer's markup.
  const buildTasks = () => {
    const items = (chat && chat.todos) || [];
    if (!items.length) return;   // the four fixed cards stay; Tasks only joins with a list
    const tasks = card('tasks', 'Tasks', 'check');
    const doneN = items.filter(t => t.status === 'completed').length;
    tasks.badge.textContent = doneN + '/' + items.length;
    tasks.badge.classList.toggle('busy', doneN < items.length);
    const prog = el('div', 'task-bar');
    const pf = el('i');
    pf.style.width = (doneN / items.length * 100).toFixed(1) + '%';
    prog.appendChild(pf);
    tasks.inner.appendChild(prog);
    const live = items.find(t => t.status === 'in_progress');
    if (live) tasks.inner.appendChild(el('div', 'task-now', live.activeForm || live.content));
    else if (doneN === items.length) tasks.inner.appendChild(el('div', 'task-now done', 'All tasks done'));
    const ol = el('ol', 'task-list');
    for (const t of items) {
      const st = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'todo';
      const row = el('li', st);
      row.appendChild(elIcon('span', 'task-mark', st === 'done' ? CCEIcons.svg('check', 12) : ''));
      row.appendChild(el('span', 'task-text', t.content));
      ol.appendChild(row);
    }
    tasks.inner.appendChild(ol);
  };

  // Background work the engine runs for this chat (subagents, shells): a card only while there is some.
  const buildBackground = () => {
    if (!(chat && chat.bgTasks && chat.bgTasks.size)) return;
    const bg = card('background', 'Background', 'clock');
    bg.badge.textContent = String(chat.bgTasks.size);
    bg.badge.classList.add('busy');
    for (const [, row] of chat.bgTasks) {
      bg.inner.appendChild(el('div', 'task-row hint', '◌ ' + (row.label || 'task')));
    }
  };
  if (only === 'background') {
    buildBackground();
    const cur = target.querySelector('[data-card="background"]');
    const next = body.firstElementChild;
    if (target.isConnected) {
      if (cur && !next) cur.remove();
      else if (!cur && next) target.appendChild(next);      // last card, after Changes
      else if (cur && cur.outerHTML !== next.outerHTML) cur.replaceWith(next);
      target.__taskHtml = null;
    }
    return;
  }

  // A task-list change redraws only that card: no git spawn, no engine calls.
  if (only === 'tasks') {
    buildTasks();
    const cur = target.querySelector('[data-card="tasks"]');
    const next = body.firstElementChild;
    if (target.isConnected) {
      if (cur && !next) cur.remove();                 // list emptied
      else if (!cur && next) target.prepend(next);    // first list: Tasks sits on top
      else if (cur && cur.outerHTML !== next.outerHTML) cur.replaceWith(next);
      target.__taskHtml = null;   // the next full render compares afresh
    }
    return;
  }

  buildTasks();   // first, when there is a list (the desktop app's progress block)

  // Environment: where the chat runs and on what, plus the git state.
  const env = card('environment', 'Environment', 'folder');
  if (chat) {
    const rows = [
      ['status', chat.busy ? 'working…' : (chat.alive ? 'idle' : 'ended')],
      ['provider', chat.provider ? chat.provider.name : 'default (Claude account)'],
      ['model', chat.model || (chat.init && chat.init.model) || 'provider default'],
    ];
    for (const [k, v] of rows) {
      const row = el('div', 'kv-row');
      row.appendChild(el('span', 'kv-k', k));
      row.appendChild(el('span', 'kv-v', String(v)));
      env.inner.appendChild(row);
    }
  }
  // Cost, turns and time of the last turn: the composer's status row is gone.
  if (chat && (chat.lastResult || chat.spent > 0.0001)) {
    const r = chat.lastResult || {};
    const metered = !chat.provider || !chat.provider.baseUrl;
    const bits = [];
    if (metered && chat.spent > 0.0001) bits.push('$' + chat.spent.toFixed(4));
    if (r.num_turns != null) bits.push(r.num_turns + ' turns');
    if (r.duration_ms) bits.push(Math.round(r.duration_ms / 1000) + 's');
    if (bits.length) {
      const row = el('div', 'kv-row');
      row.appendChild(el('span', 'kv-k', 'session'));
      row.appendChild(el('span', 'kv-v', bits.join(' · ')));
      env.inner.appendChild(row);
    }
  }
  const envRow = el('div', 'task-row hint', '⌂ ' + cwd);
  envRow.title = cwd;
  env.inner.appendChild(envRow);
  let ch, chList;   // created after Connectors so the cards read in the desktop order
  pending.push(ccx.invoke('git:info', { cwd }).then((r) => {
    if (!r || !r.ok) return;
    env.inner.appendChild(el('div', 'task-row hint',
      (r.branch ? '⎇ ' + r.branch : 'no branch') + (r.repo ? ' · ' + r.repo : '')
      + (r.dirty ? ' · ' + r.dirty + ' changed' : ' · clean')));
    env.badge.textContent = r.branch || '';
    ch.badge.textContent = r.dirty ? String(r.dirty) : 'clean';
    ch.badge.classList.toggle('warn', !!r.dirty);
    if (!(r.files || []).length) { chList.appendChild(el('div', 'task-row hint', 'working tree clean')); return; }
    for (const f of r.files) {
      const row = el('div', 'task-row mono', f);
      row.title = cwd + '/' + f;
      row.addEventListener('click', () => ccx.invoke('shell:reveal', { path: cwd + '/' + f }));
      chList.appendChild(row);
    }
  }));

  // Context: like the desktop card. "N% used" with compact totals, a thin
  // segmented bar, then one row per category with its share of the window.
  const fmtK = (n) => fmtTokShort(n).replace(/\.0(?=[kMB]$)/, '');
  const ctx = card('context', 'Context', 'chart');
  const ctxHead = el('div', 'ctx-head');
  const ctxPct = el('span', 'ctx-used', chat ? '…' : 'start a chat to see usage');
  const ctxTot = el('span', 'ctx-total', '');
  ctxHead.appendChild(ctxPct);
  ctxHead.appendChild(ctxTot);
  ctx.inner.appendChild(ctxHead);
  const bar = el('div', 'ctx-seg');
  ctx.inner.appendChild(bar);
  const ctxBreak = el('div', 'task-rows ctx-rows');
  ctx.inner.appendChild(ctxBreak);
  if (chat) {
    const compact = el('button', 'btn small', 'Compact in place');
    compact.title = 'Summarize earlier turns; the same chat continues';
    compact.addEventListener('click', () => { if (chat.compactBtn) chat.compactBtn.click(); });
    const acts = el('div', 'rail-actions');
    acts.appendChild(compact);
    ctx.inner.appendChild(acts);
    pending.push(ccx.invoke('chat:context', { id: chat.id }).then((r) => {
      if (!r || !r.ok || !r.usage) return;
      const u = r.usage;
      const total = Number(u.totalTokens) || 0;
      const max = Math.max(1, Number(u.maxTokens) || 1);
      const pct = Math.max(0, Math.min(100, Number(u.percentage) || 0));
      ctxPct.textContent = pct.toFixed(0) + '% used';
      ctxPct.classList.toggle('warn', pct > 65);
      ctxTot.textContent = fmtK(total) + ' / ' + fmtK(max);
      ctxHead.title = total.toLocaleString() + ' / ' + max.toLocaleString() + ' tokens';
      ctx.badge.textContent = pct.toFixed(0) + '%';
      ctx.badge.classList.toggle('warn', pct > 65);
      bar.innerHTML = '';
      ctxBreak.innerHTML = '';
      for (const c of (u.categories || [])) {
        if (!c) continue;
        const tokens = Number(c.tokens) || 0;
        const deferred = c.kind === 'deferred' || c.isDeferred;
        const free = c.kind === 'free';
        if (!deferred && !free && tokens > 0) {
          const seg = el('i');
          seg.style.width = Math.min(100, tokens / max * 100).toFixed(2) + '%';
          if (c.color) seg.style.background = c.color;
          bar.appendChild(seg);
        }
        const row = el('div', 'task-row hint ctx-cat' + (deferred ? ' deferred' : ''));
        const dot = el('span', 'ctx-dot');
        if (c.color && !free) dot.style.background = c.color;
        if (free) dot.classList.add('free');
        row.appendChild(dot);
        row.appendChild(el('span', 'ctx-name', c.name || 'other'));
        row.appendChild(el('span', 'ctx-tokens', fmtK(tokens)));
        row.appendChild(el('span', 'ctx-share', deferred ? '—' : (tokens / max * 100).toFixed(1) + '%'));
        row.title = tokens.toLocaleString() + ' tokens';
        ctxBreak.appendChild(row);
      }
      // The first five categories tell the story; the rest sit behind a toggle.
      const catRows = [...ctxBreak.children];
      if (catRows.length > CTX_VISIBLE + 1) {
        const extra = catRows.slice(CTX_VISIBLE);
        extra.forEach((r) => r.classList.toggle('hidden', !ctxExpanded));
        const more = el('button', 'btn tiny ctx-more', ctxExpanded ? 'show less' : '+' + extra.length + ' more');
        more.addEventListener('click', () => {
          ctxExpanded = !ctxExpanded;
          extra.forEach((r) => r.classList.toggle('hidden', !ctxExpanded));
          more.textContent = ctxExpanded ? 'show less' : '+' + extra.length + ' more';
        });
        ctxBreak.appendChild(more);
      }
    }));
  }

  // Connectors: the MCP servers this session can call tools on, with the
  // per-session switch the desktop app offers. #feat-connector-tools
  const conn = card('connectors', 'Connectors', 'plug2');
  const connRows = el('div', 'task-rows');
  conn.inner.appendChild(connRows);
  if (chat) {
    // Cache connector status per chat for 10s to avoid hammering the engine
    // on repeated rail redraws. #perf-connectors
    const cacheKey = 'conn:' + chat.id;
    const cached = window.__connCache && window.__connCache[cacheKey];
    const fetcher = (cached && (Date.now() - cached.at < 10000))
      ? Promise.resolve(cached.r)
      : ccx.invoke('chat:mcp', { id: chat.id, op: 'status' }).then((r) => {
          window.__connCache = window.__connCache || {};
          window.__connCache[cacheKey] = { at: Date.now(), r };
          return r;
        });
    pending.push(fetcher.then((r) => {
      const servers = (r && r.ok && r.servers) || [];
      connRows.innerHTML = '';
      const live = servers.filter((s) => s.status === 'connected').length;
      conn.badge.textContent = servers.length ? live + '/' + servers.length : '0';
      if (!servers.length) {
        connRows.appendChild(el('div', 'task-row hint', 'no MCP servers in this session'));
        return;
      }
      const connected = servers.filter((s) => s.status === 'connected');
      if (connected.length >= 5) {
        const hint = el('div', 'task-row hint', connected.length + ' connectors live — each adds MCP preamble to every turn. Disconnect unused ones in Providers.');
        connRows.appendChild(hint);
      }
      // Warn about tool-name collisions across connectors (#wrong-tool-calls).
      const names = [];
      for (const s of connected) for (const t of (s.tools || [])) names.push(t.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length) {
        const uniq = [...new Set(dupes)];
        connRows.appendChild(el('div', 'task-row hint', 'Duplicate tool names across connectors: ' + uniq.join(', ') + '. Prefer the server matching the task.'));
      }
      for (const sv of servers) {
        const row = el('div', 'task-row hint conn-row');
        row.appendChild(el('span', 'st-dot st-' + String(sv.status || 'pending').replace(/[^a-z-]/g, '')));
        const name = el('span', 'conn-name', sv.name);
        name.title = sv.status + ((sv.tools || []).length ? '\n' + sv.tools.map((t) => t.name).join(', ') : '');
        row.appendChild(name);
        const tools = (sv.tools || []).length;
        row.appendChild(el('span', 'ctx-tokens', tools ? tools + ' tools' : sv.status || ''));
        // A switch, not a word: on = enabled for this session.
        const on = sv.status !== 'disabled';
        const tog = el('button', 'switch' + (on ? ' on' : ''));
        tog.setAttribute('role', 'switch');
        tog.setAttribute('aria-checked', on ? 'true' : 'false');
        tog.setAttribute('aria-label', (on ? 'Disable ' : 'Enable ') + sv.name + ' for this session');
        tog.title = (on ? 'Disable' : 'Enable') + ' for this session';
        tog.textContent = on ? 'disable' : 'enable';
        tog.addEventListener('click', async () => {
          tog.disabled = true;
          await ccx.invoke('chat:mcp', {
            id: chat.id, op: 'toggle', name: sv.name, enabled: sv.status === 'disabled',
          });
          window.__connCache = {};
          renderOverview();
        });
        row.appendChild(tog);
        connRows.appendChild(row);
      }
    }));
  } else {
    connRows.appendChild(el('div', 'task-row hint', 'start a chat to see connectors'));
  }

  ch = card('changes', 'Changes', 'branch');
  chList = el('div', 'task-rows');
  ch.inner.appendChild(chList);

  buildBackground();
  const swap = () => {
    // A newer render started meanwhile, or the panel was closed: drop this one.
    if (seq !== target.__taskSeq || !target.isConnected) return;
    // Nothing changed: leave the live DOM alone (no repaint, hover and focus kept).
    const html = body.innerHTML;
    if (html === target.__taskHtml) return;
    target.__taskHtml = html;
    const keepScroll = target.scrollTop;
    const fresh = [...body.children];
    const old = [...target.children];
    const sameCards = old.length === fresh.length
      && old.every((c, i) => c.dataset && c.dataset.card === fresh[i].dataset.card);
    if (sameCards) {
      // Same cards in the same order: replace only the ones whose content
      // changed, so a ticking token count does not repaint the whole panel.
      fresh.forEach((c, i) => {
        if (old[i].dataset && old[i].dataset.card === 'context') {
          // Fine-grained updates for the context card to eliminate flicker
          const oldHead = old[i].querySelector('.ctx-head');
          const newHead = c.querySelector('.ctx-head');
          if (oldHead && newHead && oldHead.innerHTML !== newHead.innerHTML) oldHead.innerHTML = newHead.innerHTML;
          const oldBar = old[i].querySelector('.ctx-seg');
          const newBar = c.querySelector('.ctx-seg');
          if (oldBar && newBar && oldBar.innerHTML !== newBar.innerHTML) oldBar.innerHTML = newBar.innerHTML;
          const oldRows = old[i].querySelector('.ctx-rows');
          const newRows = c.querySelector('.ctx-rows');
          if (oldRows && newRows && oldRows.innerHTML !== newRows.innerHTML) oldRows.innerHTML = newRows.innerHTML;
          const oldBadge = old[i].querySelector('.tc-badge');
          const newBadge = c.querySelector('.tc-badge');
          if (oldBadge && newBadge && oldBadge.textContent !== newBadge.textContent) oldBadge.textContent = newBadge.textContent;
        } else if (old[i].outerHTML !== c.outerHTML) {
          old[i].replaceWith(c);
        }
      });
    } else {
      target.replaceChildren(...fresh);
    }
    target.scrollTop = keepScroll;
  };
  // A slow call must not hold the whole panel back: show what is there after 1.5s.
  Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 1500))]).then(swap);
}

/** A chat recreated on another provider gets a new engine session id: move the
 *  tab registry entry and active pointer so nothing else notices. #feat-provider-toggle */
window.rekeyTab = (oldId, newId) => {
  const meta = tabRegistry.get(oldId);
  if (meta) { tabRegistry.delete(oldId); tabRegistry.set(newId, meta); }
  if (state.activeId === oldId) state.activeId = newId;
};

/** Chat.js calls this when a tab learns its engine session id. */
window.onConvoSessionsChanged = () => {
  const drop = document.querySelector('#convo-drop');
  if (drop && !drop.classList.contains('hidden') && convoSessions.length) renderConversationList();
};

function fitSize(s) {
  try { s.fit.fit(); } catch { /* hidden */ }
  return { cols: s.term.cols, rows: s.term.rows };
}

function activateSession(id) {
  state.activeId = id;
  window.__activate(id);
  const meta = tabRegistry.get(id);
  if (meta && meta.kind === 'pty') {
    const s = state.sessions.get(id);
    if (s) {
      if (s.alive) { s.fit.fit(); s.term.focus(); }
      updateStatusbar(s);
    }
  } else if (meta && meta.focus) {
    meta.focus();
  }
}

async function createSession(opts) {
  // Build the xterm first so we can size the PTY correctly.
  const pane = el('div', 'term-pane');
  $('#terminals').appendChild(pane);

  const term = new TermCtor({
    fontSize: state.settings.fontSize,
    fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code','DejaVu Sans Mono',monospace",
    scrollback: state.settings.scrollback,
    cursorBlink: true,
    theme: TERM_THEME,
    allowProposedApi: true,
    rightClickSelectsWord: false,
  });
  const fit = new FitCtor();
  term.loadAddon(fit);
  if (LinksCtor) term.loadAddon(new LinksCtor());
  term.open(pane);

  // Activate now so fit() sees real dimensions.
  const placeholderId = 'pending-' + Math.random().toString(36).slice(2);
  state.sessions.set(placeholderId, { term, fit, pane, tabEl: null, alive: false, placeholder: true });
  // Temporarily activate without a tab element.
  for (const [sid, s] of state.sessions) {
    s.pane && s.pane.classList.toggle('active', sid === placeholderId);
  }
  const { cols, rows } = fitSize(state.sessions.get(placeholderId));

  const res = await ccx.invoke('session:create', { ...opts, cols, rows });
  if (!res.ok) {
    state.sessions.delete(placeholderId);
    pane.remove();
    toast('Failed to start session: ' + res.error, 'err');
    switchView('terminal');
    return;
  }

  // Re-key the session and add its tab.
  const id = res.id;
  const sess = state.sessions.get(placeholderId);
  state.sessions.delete(placeholderId);
  sess.placeholder = false;
  sess.alive = true;
  sess.cwd = res.cwd;
  sess.provider = res.provider;
  sess.label = res.label;

  const tab = el('div', 'tab active');
  tab.appendChild(el('span', '', res.label));
  const closeBtn = elIcon('button', 'close', CCEIcons.svg('close', 13));
  closeBtn.title = 'Close session';
  closeBtn.setAttribute('aria-label', 'Close session');
  tab.appendChild(closeBtn);
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); killSession(id); });
  tab.addEventListener('click', () => activateSession(id));
  $('#tabs').appendChild(tab);
  sess.tabEl = tab;

  term.onData(d => ccx.send('session:write', { id, data: d }));
  term.onResize(({ cols, rows }) => ccx.invoke('session:resize', { id, cols, rows }));
  term.attachCustomKeyEventHandler((ev) => {
    // Let our global copy/paste shortcuts work inside the terminal.
    if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'V' || ev.key === 'T' || ev.key === 'W')) return false;
    return true;
  });

  state.sessions.set(id, sess);
  tabRegistry.set(id, { kind: 'pty', pane, tabEl: tab, focus: () => { if (sess.alive) { sess.fit.fit(); sess.term.focus(); } } });
  updateSessionCount();
  activateSession(id);
  switchView('terminal');
  return id;
}

async function killSession(id) {
  const meta = tabRegistry.get(id);
  if (meta && meta.kind === 'chat') {
    // Remember it first: closing a chat is how you switch away, and being able
    // to bring the last one back is expected in every tabbed app.
    pushRecentlyClosed({ kind: 'chat', cwd: meta.cwd, sessionId: meta.sessionId || null });
    await Chat.closeChat(id);
    return;
  }
  const s = state.sessions.get(id);
  if (!s) return;
  pushRecentlyClosed({ kind: 'pty', cwd: s.cwd, command: s.command, args: s.args });
  if (s.alive) await ccx.invoke('session:kill', { id });
  s.term.dispose();
  s.pane.remove();
  s.tabEl && s.tabEl.remove();
  state.sessions.delete(id);
  tabRegistry.delete(id);
  updateSessionCount();
  if (state.activeId === id) {
    const next = [...tabRegistry.keys()].pop();
    if (next) activateSession(next);
    else { state.activeId = null; $('#st-provider').textContent = '—'; $('#st-cwd').textContent = ''; }
  }
}

/* ================= conversations navigation ================= */

// Closed tabs, newest last, so Ctrl+Shift+T-style reopening works the way every
// other tabbed app behaves. Capped — this is a convenience, not an archive.
const RECENT_MAX = 12;
let recentlyClosed = [];

/** Remember a closed tab so "↶ Closed tab" can bring it back. */
function pushRecentlyClosed(entry) {
  if (!entry || !entry.kind) return;
  recentlyClosed = recentlyClosed.filter((e) => e.kind + ':' + e.cwd !== entry.kind + ':' + entry.cwd);
  recentlyClosed.push(entry);
  if (recentlyClosed.length > RECENT_MAX) recentlyClosed.shift();
  paintReopenButton();
}

function paintReopenButton() {
  const b = document.querySelector('#qa-reopen');
  if (!b) return;
  const last = recentlyClosed[recentlyClosed.length - 1];
  b.disabled = !last;
  if (last) {
    b.textContent = '↶ ' + (last.kind === 'pty' ? 'Terminal' : 'Chat') + (last.cwd ? ' · ' + basenameOf(last.cwd) : '');
    b.title = 'Reopen ' + (last.kind === 'pty' ? 'terminal' : 'chat') + ' in ' + (last.cwd || '~');
  }
}

async function reopenLastClosed() {
  const last = recentlyClosed.pop();
  paintReopenButton();
  if (!last) return;
  if (last.kind === 'pty') await createSession({ cwd: last.cwd, command: last.command, args: last.args });
  else await Chat.createSession({ cwd: last.cwd, resume: last.sessionId || undefined });
}

/**
 * Resume the newest conversation for the active folder. Cheaper than browsing
 * the list for the common "carry on where I left off".
 */
async function resumeLatest() {
  const btn = document.querySelector('#qa-resume');
  if (btn) { btn.disabled = true; btn.textContent = '↻ looking…'; }
  try {
    const active = tabRegistry.get(state.activeId);
    const cwd = (active && active.cwd) || (state.settings && state.settings.defaultCwd) || '';
    const r = await ccx.invoke('chat:history', { cwd });
    const rows = (r && r.sessions) || [];
    const mine = rows.filter((s) => s.sessionId && !tabRegistryHas(s.sessionId));
    if (!mine.length) {
      toast(rows.length ? 'That conversation is already open' : 'No past conversation in this folder yet', '');
      return;
    }
    await Chat.createSession({ cwd, resume: mine[0].sessionId });
  } catch (err) {
    toast(String((err && err.message) || err), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Resume latest'; }
  }
}

const tabRegistryHas = (sessionId) => [...tabRegistry.values()].some((m) => m.sessionId === sessionId);

/**
 * The sidebar badge stops being a plain count: it says whether any tab is
 * waiting on you (a permission prompt), working, or just open. That is the
 * distinction users of the newer agent desktops rely on to know where to look.
 */
function updateSessionCount() {
  const badge = $('#sess-count');
  if (!badge) return;
  const nav = badge.closest('.nav-btn');
  const metas = [...tabRegistry.values()];
  const chatMetas = metas.filter((m) => m.kind === 'chat');
  const needsYou = chatMetas.filter((m) => m.needsYou).length;
  const busy = chatMetas.filter((m) => m.busy).length;
  badge.textContent = String(tabRegistry.size);
  badge.classList.toggle('attn', needsYou > 0);
  badge.classList.toggle('busy', needsYou === 0 && busy > 0);
  if (nav) {
    nav.classList.toggle('needs-you', needsYou > 0);
    nav.classList.toggle('busy-dot', needsYou === 0 && busy > 0);
    nav.title = needsYou > 0
      ? needsYou + ' tab' + (needsYou === 1 ? '' : 's') + ' waiting on you'
      : busy > 0 ? busy + ' tab' + (busy === 1 ? '' : 's') + ' working' : '';
  }
}
window.updateTabCount = updateSessionCount;
/** Chat.js raises this when a tab needs the user, or stops needing them. */
window.updateNavState = updateSessionCount;

function updateStatusbar(sess) {
  const p = sess.provider;
  $('#st-provider').innerHTML = '';
  const dot = el('span', 'dot', sess.alive ? '● ' : '○ ');
  $('#st-provider').appendChild(dot);
  $('#st-provider').appendChild(document.createTextNode(p ? p.name : 'default env'));
  if (p && p.model) {
    $('#st-provider').appendChild(el('span', '', `  ·  ${p.model}`));
  }
  $('#st-cwd').textContent = sess.cwd || '';
  const right = $('#st-right');
  right.innerHTML = '';
  if (state.info) {
    right.appendChild(el('span', '', [
      state.info.claude && state.info.claude.found ? `claude ${state.info.claude.version.replace(/^.*?(\d[\d.]+\d).*/, '$1') || state.info.claude.version}` : 'claude: not found',
      `  ·  CCE v${state.info.appVersion}`,
    ].join('')));
  }
}

/* ================= new-session modal ================= */

function openNewSessionModal() {
  const overlay = el('div', 'modal-overlay');
  // A dialog must say so: role + aria-modal, or a screen reader treats the
  // backdrop as ordinary content and keeps reading the page behind it. #53
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', 'New session'));

  const grid = el('div', 'form-grid');

  // project dir
  const dirLabel = el('label', 'fld wide');
  dirLabel.appendChild(el('span', '', 'Project directory'));
  const dirRow = el('div', 'inline');
  const dirInput = el('input');
  dirInput.type = 'text';
  dirInput.value = state.settings.defaultCwd || '';
  const browseBtn = el('button', 'btn', 'Browse…');
  browseBtn.addEventListener('click', async () => {
    const r = await ccx.invoke('dialog:pickDir', { defaultPath: dirInput.value });
    if (r.ok && r.path) dirInput.value = r.path;
  });
  dirRow.appendChild(dirInput); dirRow.appendChild(browseBtn);
  dirLabel.appendChild(dirRow);
  grid.appendChild(dirLabel);

  // type
  const typeLabel = el('label', 'fld');
  typeLabel.appendChild(el('span', '', 'Type'));
  const typeSel = el('select');
  [['chat', 'Chat — desktop-style (Agent SDK)'], ['claude', 'Terminal — claude TUI'], ['shell', 'Terminal — shell']].forEach(([v, n]) => {
    const o = el('option', '', n); o.value = v; typeSel.appendChild(o);
  });
  typeSel.value = 'chat';
  typeLabel.appendChild(typeSel);
  grid.appendChild(typeLabel);

  // provider
  const provLabel = el('label', 'fld');
  provLabel.appendChild(el('span', '', 'Provider'));
  const provSel = el('select');
  state.providers.instances.forEach(p => {
    const o = el('option', '', (p.uid === state.providers.defaultUid ? '★ ' : '') + p.name);
    o.value = p.uid;
    provSel.appendChild(o);
  });
  if (state.providers.defaultUid) provSel.value = state.providers.defaultUid;
  provLabel.appendChild(provSel);
  grid.appendChild(provLabel);

  // options
  const optRow = el('div', 'wide');
  optRow.style.display = 'flex';
  optRow.style.flexDirection = 'column';
  optRow.style.gap = '8px';

  // permission mode (chat)
  const modeRow = el('div', 'inline');
  modeRow.appendChild(el('span', 'hint', 'Permission mode'));
  const modeSel = el('select');
  modeSel.style.width = '200px';
  const provOf = () => state.providers.instances.find(p => p.uid === provSel.value) || null;
  fillModeSelect(modeSel, provOf());
  modeSel.value = 'acceptEdits';
  provSel.addEventListener('change', () => fillModeSelect(modeSel, provOf()));
  modeRow.appendChild(modeSel);
  optRow.appendChild(modeRow);

  const contCheck = el('input'); contCheck.type = 'checkbox'; contCheck.id = 'opt-continue';
  const contLabel = el('label', 'check');
  contLabel.appendChild(contCheck);
  contLabel.appendChild(el('span', '', 'Terminal: continue most recent conversation (--continue)'));
  optRow.appendChild(contLabel);

  const resumeCheck = el('input'); resumeCheck.type = 'checkbox'; resumeCheck.id = 'opt-resume';
  const resumeLabel = el('label', 'check');
  resumeLabel.appendChild(resumeCheck);
  resumeLabel.appendChild(el('span', '', 'Chat: resume this folder\u2019s previous conversation'));
  optRow.appendChild(resumeLabel);

  const wtCheck = el('input'); wtCheck.type = 'checkbox'; wtCheck.id = 'opt-worktree';
  const wtLabel = el('label', 'check');
  wtLabel.appendChild(wtCheck);
  wtLabel.appendChild(el('span', '', 'Chat: isolated git worktree (new branch under .claude/worktrees)'));
  optRow.appendChild(wtLabel);

  const yoloCheck = el('input'); yoloCheck.type = 'checkbox'; yoloCheck.id = 'opt-yolo';
  const yoloLabel = el('label', 'check');
  yoloLabel.appendChild(yoloCheck);
  yoloLabel.appendChild(el('span', '', 'Skip ALL permission prompts (--dangerously-skip-permissions)'));
  optRow.appendChild(yoloLabel);

  const loginCheck = el('input'); loginCheck.type = 'checkbox'; loginCheck.id = 'opt-login';
  const loginLabel = el('label', 'check');
  loginLabel.appendChild(loginCheck);
  loginLabel.appendChild(el('span', '', 'Terminal: send /login after launch (first-time OAuth)'));
  optRow.appendChild(loginLabel);

  const warn = el('div', 'warn-box hidden');
  yoloCheck.addEventListener('change', () => warn.classList.toggle('hidden', !yoloCheck.checked));
  warn.textContent = 'YOLO mode lets the agent run any command without asking — use only in disposable environments.';
  optRow.appendChild(warn);
  grid.appendChild(optRow);

  modal.appendChild(grid);
  const actions = el('div', 'actions');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  const launch = el('button', 'btn primary', 'Launch');
  launch.addEventListener('click', () => {
    const opts = {
      cwd: dirInput.value.trim(),
      providerUid: provSel.value || null,
      yolo: yoloCheck.checked,
    };
    overlay.remove();
    if (typeSel.value === 'chat') {
      Chat.createSession({
        ...opts,
        permissionMode: modeSel.value,
        resume: resumeCheck.checked ? 'last' : null,
        worktree: wtCheck.checked,
      });
    } else {
      createSession({
        ...opts,
        type: typeSel.value,
        continueLast: contCheck.checked,
        initText: loginCheck.checked ? '/login\r' : '',
      });
    }
  });
  actions.appendChild(cancel); actions.appendChild(launch);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  $('#modal-root').appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  dirInput.focus();
}

/* ================= providers view ================= */

function renderProviders() {
  // The whole providers surface (Connect picker, detail tabs, local manager)
  // lives in providers.js; this stays as the nav entry point.
  if (window.ProvidersUI) return ProvidersUI.render();
  const grid = $('#provider-grid');
  if (grid) grid.innerHTML = '';
}

  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function openOllamaManager(p) {    const overlay = el('div', 'modal-overlay');
  // A dialog must say so: role + aria-modal, or a screen reader treats the
  // backdrop as ordinary content and keeps reading the page behind it. #53
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
    const modal = el('div', 'modal');
    modal.appendChild(elIcon('h3', '', CCEIcons.svg('gear', 14) + ' Model manager — ' + p.name));
    modal.appendChild(el('div', 'hint', 'Load models into memory with a context size, or unload them to free VRAM. The context size applies while the model stays loaded — chats use it automatically.'));

    const loadedBox = el('div', 'settings-card');
    loadedBox.appendChild(el('h4', '', 'Loaded now'));
    const loadedList = el('div', 'skills-list');
    loadedBox.appendChild(loadedList);

    const allBox = el('div', 'settings-card');
    allBox.appendChild(el('h4', '', 'All models on the server'));
    const allList = el('div', 'skills-list');
    allBox.appendChild(allList);

    const ctxSel = el('select'); ctxSel.style.width = '140px';
    [['4096', '4K ctx'], ['8192', '8K ctx'], ['16384', '16K ctx'], ['32768', '32K ctx'], ['65536', '64K ctx'], ['131072', '128K ctx'], ['262144', '256K ctx']].forEach(([v, n]) => {
      const o = el('option', '', n); o.value = v; ctxSel.appendChild(o);
    });
    ctxSel.value = '32768';
    const kaSel = el('select'); kaSel.style.width = '140px';
    [['5m', 'keep 5m'], ['30m', 'keep 30m'], ['1h', 'keep 1h'], ['-1', 'keep forever']].forEach(([v, n]) => {
      const o = el('option', '', n); o.value = v; kaSel.appendChild(o);
    });
    kaSel.value = '30m';
    const controls = el('div', 'inline');
    controls.appendChild(el('span', 'hint', 'load with:'));
    controls.appendChild(ctxSel);
    controls.appendChild(kaSel);
    modal.appendChild(controls);
    modal.appendChild(loadedBox);
    modal.appendChild(allBox);

    let loadedNames = new Set();
    const refresh = async () => {
      const [ps, tags] = await Promise.all([
        ccx.invoke('ollama:ps', { uid: p.uid }),
        ccx.invoke('ollama:tags', { uid: p.uid }),
      ]);
      loadedList.innerHTML = '';
      allList.innerHTML = '';
      loadedNames = new Set(ps.ok ? (ps.models || []).map(m => m.name) : []);
      if (!ps.ok) loadedList.appendChild(el('div', 'hint', 'Not an Ollama server (or unreachable): ' + (ps.error || '')));
      (ps.models || []).forEach(m => {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', m.name));
        row.appendChild(el('span', 'skill-desc', fmtBytes(m.sizeVram) + ' in memory' + (m.expires ? ' · expires ' + new Date(m.expires).toLocaleTimeString() : '')));
        row.appendChild(el('span', 'chip', 'loaded'));
        const unload = el('button', 'btn small danger', 'unload');
        unload.addEventListener('click', async () => {
          unload.disabled = true; unload.textContent = '…';
          await ccx.invoke('ollama:manage', { uid: p.uid, model: m.name, action: 'unload' });
          refresh();
        });
        row.appendChild(unload);
        loadedList.appendChild(row);
      });
      if (ps.ok && !(ps.models || []).length) loadedList.appendChild(el('div', 'hint', 'Nothing loaded — models load on demand or via “load” below.'));
      (tags.ok ? tags.models : []).forEach(m => {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', m.name));
        row.appendChild(el('span', 'skill-desc', [m.paramSize, m.quant, fmtBytes(m.size)].filter(Boolean).join(' · ')));
        if (loadedNames.has(m.name)) {
          row.appendChild(el('span', 'chip', 'loaded'));
        } else {
          const load = el('button', 'btn small primary', 'load');
          load.title = 'Load with ' + ctxSel.options[ctxSel.selectedIndex].text + ', ' + kaSel.options[kaSel.selectedIndex].text;
          load.addEventListener('click', async () => {
            load.disabled = true; load.textContent = 'loading…';
            const r = await ccx.invoke('ollama:manage', {
              uid: p.uid, model: m.name, action: 'load',
              numCtx: ctxSel.value, keepAlive: kaSel.value === '-1' ? -1 : kaSel.value,
            });
            if (!r.ok || r.status >= 400) toast('Load failed (' + (r.status || r.error) + ')', 'err');
            refresh();
          });
          row.appendChild(load);
        }
        allList.appendChild(row);
      });
      if (!tags.ok || !(tags.models || []).length) allList.appendChild(el('div', 'hint', 'No models found: ' + (tags.error || 'is the server running?')));
    };
    ctxSel.addEventListener('change', refresh);
    kaSel.addEventListener('change', refresh);
    refresh();

    const actions = el('div', 'actions');
    const close = el('button', 'btn primary', 'Close');
    close.addEventListener('click', () => overlay.remove());
    actions.appendChild(close);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    $('#modal-root').appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  }
  window.openOllamaManager = openOllamaManager;


  function openProviderEditor(instance) {  const editing = !!instance;
  const presetId = instance ? instance.presetId : 'anthropic-oauth';
  const preset = state.providers.presets.find(p => p.id === presetId) || state.providers.presets[0];

  const overlay = el('div', 'modal-overlay');
  // A dialog must say so: role + aria-modal, or a screen reader treats the
  // backdrop as ordinary content and keeps reading the page behind it. #53
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', editing ? 'Edit provider' : 'Add provider'));

  const grid = el('div', 'form-grid');

  // preset picker
  const pLabel = el('label', 'fld wide');
  pLabel.appendChild(el('span', '', 'Preset'));
  const pSel = el('select');
  state.providers.presets.forEach(p => {
    const o = el('option', '', p.name); o.value = p.id; pSel.appendChild(o);
  });
  pSel.value = presetId;
  pLabel.appendChild(pSel);
  const blurb = el('div', 'hint', preset.blurb);
  let currentProtocol = (instance && instance.protocol) || preset.protocol || 'anthropic';
  let baseUrlInputEl = null;
  const presetDisplay = (p) => p.display || (p.name.includes('·') ? p.name.split('·')[1].trim() : p.name);
  // openai-protocol presets are key-only: the auth-token field is hidden and the
  // base URL is preset-managed unless the preset flags it editable (Cloudflare's
  // ACCOUNT_ID placeholder, NaraRouter's user-confirmed URL).
  const syncFields = () => {
    const ps = state.providers.presets.find(p => p.id === pSel.value) || preset;
    tokenField.style.display = currentProtocol === 'openai' ? 'none' : '';
    if (baseUrlInputEl) {
      const managed = currentProtocol === 'openai' && !!baseUrlInputEl.value && !ps.editableBaseUrl;
      baseUrlInputEl.readOnly = managed;
      baseUrlInputEl.style.opacity = managed ? '0.75' : '1';
      const lbl = baseUrlField.querySelector('span');
      if (lbl) lbl.textContent = managed
        ? 'Base URL (managed by preset — API key only)'
        : (currentProtocol === 'openai' ? 'Base URL (preset default — edit if your provider differs)' : 'Base URL (empty = official Anthropic API)');
    }
    if (curCard) curCard.style.display = currentProtocol === 'openai' ? '' : 'none';
  };
  pSel.addEventListener('change', () => {
    const np = state.providers.presets.find(p => p.id === pSel.value);
    if (!np) return;
    blurb.textContent = np.blurb;
    currentProtocol = np.protocol || 'anthropic';
    // Adopt the preset's template values. The previous code assigned .value on
    // the `let` string variables instead of these inputs, so switching preset
    // never populated anything.
    baseUrlInputEl.value = np.baseUrl || '';
    modelField.querySelector('input').value = np.model || '';
    smallField.querySelector('input').value = np.smallFastModel || '';
    const cur = nameInput.value.trim();
    if (!cur || state.providers.presets.some(p => presetDisplay(p) === cur)) nameInput.value = presetDisplay(np);
    if (curCard) { curList.innerHTML = ''; if (currentProtocol === 'openai' && baseUrlInputEl.value) loadCur(); }
    syncFields();
  });
  pLabel.appendChild(blurb);
  grid.appendChild(pLabel);

  // name
  const nLabel = el('label', 'fld wide');
  nLabel.appendChild(el('span', '', 'Display name'));
  const nameInput = el('input');
  nameInput.value = instance ? instance.name : (preset.name.includes('·') ? preset.name.split('·')[1].trim() : preset.name);
  nLabel.appendChild(nameInput);
  grid.appendChild(nLabel);

  const mkField = (labelText, id, value, type = 'text') => {
    const l = el('label', 'fld');
    l.appendChild(el('span', '', labelText));
    const inp = el('input'); inp.type = type; inp.id = id;
    if (value) inp.value = value;
    l.appendChild(inp);
    return l;
  };

  let baseUrl = instance ? instance.baseUrl : (preset.baseUrl || '');
  let model = instance ? instance.model : (preset.model || '');
  let smallFast = instance ? instance.smallFastModel : (preset.smallFastModel || '');

  let curatedSel = new Set((instance && instance.models) || []);
  let leanSel = null;
  let leanCustomWrap = null;
  let leanCustomBoxes = [];
  if (state.leanPresets && state.leanPresets.length) {
    const lf = el('label', 'fld');
    lf.appendChild(el('span', '', 'Lean tools — cut the tool list for small local models (smaller base prompt)'));
    leanSel = el('select');
    const off = el('option', '', 'full tool set (default)'); off.value = ''; leanSel.appendChild(off);
    for (const pr of state.leanPresets) {
      const o = el('option', '', pr.label + ' — ' + pr.tools.join(', ')); o.value = pr.id; leanSel.appendChild(o);
    }
    const custom = el('option', '', 'custom — pick tools below'); custom.value = 'custom'; leanSel.appendChild(custom);
    // A hand-picked list matches no preset; show it as custom with its boxes ticked. #12
    const current = (instance && instance.leanTools) || [];
    const matched = current.length
      ? (state.leanPresets.find(p => p.tools.length === current.length && p.tools.every(t => current.includes(t))) || {}).id
      : '';
    leanSel.value = matched || (current.length ? 'custom' : '');
    lf.appendChild(leanSel);
    grid.appendChild(lf);
    // Per-tool checklist, visible only for the custom preset. #12
    leanCustomWrap = el('div', 'lean-custom');
    const tools = (state.leanAllTools && state.leanAllTools.length) ? state.leanAllTools : [];
    for (const t of tools) {
      const cb = el('input'); cb.type = 'checkbox'; cb.value = t;
      cb.checked = current.includes(t);
      if (!current.length) cb.checked = ['Read', 'Grep', 'Glob', 'Bash', 'TodoWrite'].includes(t);
      const l = el('label', 'check lean-tool');
      l.appendChild(cb); l.appendChild(el('span', 'mono', t));
      leanCustomWrap.appendChild(l);
      leanCustomBoxes.push(cb);
    }
    leanCustomWrap.appendChild(el('div', 'hint', 'MCP tools (mcp__*) are dynamic per session and always stay on. Unticking the tools a model needs will break it — when in doubt, keep Read, Bash and TodoWrite.'));
    leanCustomWrap.style.display = leanSel.value === 'custom' ? '' : 'none';
    leanSel.addEventListener('change', () => {
      leanCustomWrap.style.display = leanSel.value === 'custom' ? '' : 'none';
    });
    grid.appendChild(leanCustomWrap);
  }
  const baseUrlField = mkField('Base URL (empty = official Anthropic API)', 'f-base', baseUrl, 'text');
  baseUrlInputEl = baseUrlField.querySelector('input');
  grid.appendChild(baseUrlField);

  const tokenField = mkField(
    'Auth token (ANTHROPIC_AUTH_TOKEN)' + (instance && instance.hasAuthToken ? ' — leave blank to keep' : ''),
    'f-token', '', 'password');
  grid.appendChild(tokenField);

  const keyField = mkField(
    'API key (ANTHROPIC_API_KEY)' + (instance && instance.hasApiKey ? ' — leave blank to keep' : ''),
    'f-key', '', 'password');
  grid.appendChild(keyField);

  const modelField = mkField('Model — ONE slug (switch models anytime via the in-chat dropdown)', 'f-model', model);
  grid.appendChild(modelField);

  const smallField = mkField('Small/fast model (ANTHROPIC_SMALL_FAST_MODEL)', 'f-small', smallFast);
  grid.appendChild(smallField);

  // model curation (openai-protocol providers): choose what appears in the chat
  // dropdown. Always created so switching protocol mid-dialog can reveal it.
  let curCard = null, curList = null, loadCur = null;
  {
    curCard = el('label', 'fld wide');
    curCard.appendChild(el('span', '', 'Model selection — tick the models that appear in the chat dropdown (optional; empty = show all)'));
    const loadBtn = el('button', 'btn small', '↻ load model list');
    loadBtn.style.margin = '4px 0';
    curCard.appendChild(loadBtn);
    curList = el('div', 'skills-list');
    curList.style.maxHeight = '200px';
    curList.style.overflow = 'auto';
    curCard.appendChild(curList);
    grid.appendChild(curCard);
    loadCur = async () => {
      loadBtn.disabled = true; loadBtn.textContent = 'loading…';
      const r = await ccx.invoke('provider:listModels', {
        baseUrl: baseUrlInputEl.value.trim(),
        apiKey: keyField.querySelector('input').value.trim() || tokenField.querySelector('input').value.trim(),
        protocol: currentProtocol,
      });
      loadBtn.disabled = false; loadBtn.textContent = '↻ load model list';
      curList.innerHTML = '';
      if (!r.ok) { curList.appendChild(el('div', 'hint', 'Failed: ' + (r.error || 'no models'))); return; }
      const entries = (r.models || []).map(m => typeof m === 'string' ? { id: m, ctx: null } : m).slice(0, 300);
      if (!entries.length) { curList.appendChild(el('div', 'hint', 'No models returned by the provider.')); return; }
      for (const m of entries) {
        const row = el('label', 'check');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = curatedSel.has(m.id);
        cb.addEventListener('change', () => { cb.checked ? curatedSel.add(m.id) : curatedSel.delete(m.id); });
        row.appendChild(cb);
        row.appendChild(el('span', '', m.id + (m.ctx ? '  · ' + Number(m.ctx).toLocaleString() + ' ctx' : '')));
        curList.appendChild(row);
      }
      if (!curList.childElementCount) curList.appendChild(el('div', 'hint', 'No models returned.'));
    };
    loadBtn.addEventListener('click', loadCur);
    if (currentProtocol === 'openai' && baseUrlInputEl.value) loadCur();
  }
  syncFields();

  const xLabel = el('label', 'fld wide');
  xLabel.appendChild(el('span', '', 'Extra environment variables (JSON, optional) — e.g. {"ANTHROPIC_CUSTOM_HEADERS":"…"}'));
  const xInput = el('textarea');
  xInput.value = instance && instance.envExtras ? JSON.stringify(instance.envExtras, null, 2) : '{}';
  xLabel.appendChild(xInput);
  grid.appendChild(xLabel);

  modal.appendChild(grid);

  const actions = el('div', 'actions');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  const save = el('button', 'btn primary', 'Save');
  save.addEventListener('click', async () => {
    let envExtras = {};
    try { envExtras = JSON.parse(xInput.value || '{}'); }
    catch { return toast('Extra env vars must be valid JSON', 'err'); }
    const payload = {
      uid: instance ? instance.uid : undefined,
      presetId: pSel.value,
      protocol: currentProtocol,
      models: [...curatedSel],
      // Per-provider lean tool allowlist, for small local models. #41 #12
      leanToolsPreset: leanSel ? leanSel.value : (instance && instance.leanTools ? '__keep' : ''),
      leanToolsCustom: leanSel && leanSel.value === 'custom'
        ? leanCustomBoxes.filter(cb => cb.checked).map(cb => cb.value)
        : undefined,
      name: nameInput.value.trim() || 'Provider',
      baseUrl: baseUrlField.querySelector('input').value.trim(),
      model: modelField.querySelector('input').value.trim(),
      smallFastModel: smallField.querySelector('input').value.trim(),
      envExtras,
    };
    const tok = tokenField.querySelector('input').value;
    const key = keyField.querySelector('input').value;
    if (tok) payload.authToken = tok; else if (instance && instance.hasAuthToken) payload.keepAuthToken = true;
    if (key) payload.apiKey = key; else if (instance && instance.hasApiKey) payload.keepApiKey = true;

    const r = await ccx.invoke('providers:save', { instance: payload });
    if (r.ok) {
      overlay.remove();
      await refreshProviders();
      toast('Provider saved', 'ok');
    } else toast(r.error, 'err');
  });
  actions.appendChild(cancel); actions.appendChild(save);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  $('#modal-root').appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  nameInput.focus();
}

async function refreshProviders() {
  const r = await ccx.invoke('providers:all');
  if (r.ok) {
    state.providers = { presets: r.presets, catalog: r.catalog || state.providers.catalog || [], modelsdev: r.modelsdev || state.providers.modelsdev, instances: r.instances, defaultUid: r.defaultUid };
    if (r.leanPresets) state.leanPresets = r.leanPresets;
    if (r.leanAllTools) state.leanAllTools = r.leanAllTools;
    if (state.view === 'providers') renderProviders();
  }
}

/* ================= permission modes ================= */

// The four modes of the Claude Code desktop picker. The tooltip text is the plain-language
// difference between them. (Manual/"normal" is not offered; it maps to accept edits.)
const MODE_CHOICES = [
  ['auto', 'auto', 'Safe actions run without asking: file edits in this folder, read-only commands and the project’s own test / lint / build. Anything else still asks you. On Anthropic’s API a second model reviews each action; on other providers CCE applies the same safe-action rules itself.'],
  ['acceptEdits', 'accept edits', 'File edits and simple file commands (mkdir, mv, cp…) run without asking. Shell commands and anything else still ask you.'],
  ['plan', 'plan', 'Read-only: the agent explores and proposes a plan, and changes nothing until you approve it.'],
  ['bypassPermissions', 'yolo', 'Nothing is asked or checked. Only for throwaway folders or containers.'],
];
/**
 * Any mode value the engine or an old session reports → one of the four on offer.
 * `auto` is CCE's own policy on providers that are not Anthropic's API: the
 * engine then reports accept-edits, and `auto` (the flag the main process
 * sends back) says the user picked auto.
 */
function uiMode(mode, provider, auto) {
  if (auto && (mode === 'acceptEdits' || mode === 'auto')) return 'auto';
  return MODE_CHOICES.some(c => c[0] === mode) ? mode : 'acceptEdits';
}
function fillModeSelect(sel, provider) {
  const keep = sel.value;
  sel.innerHTML = '';
  MODE_CHOICES.forEach(([value, label, tip]) => {
    const o = el('option', '', label);
    o.value = value; o.title = tip;
    sel.appendChild(o);
  });
  sel.title = MODE_CHOICES.map(c => c[1] + ' — ' + c[2]).join('\n\n');
  if (keep) sel.value = uiMode(keep, provider);
}

/* ================= connectors view ================= */

// name -> {state, detail, target, kind} from the last health check; connectorCards
// holds each preset card's live bits so a refresh can repaint them without a rebuild.
const connectorStatus = new Map();
const connectorCards = new Map();
let connectorCheckedAt = 0;
let connectorChecking = false;

function connectorChip(s) {
  switch (s && s.state) {
    case 'connected': return ['● connected', 'mcp-ok'];
    case 'auth': return ['● sign-in needed', 'mcp-warn'];
    case 'degraded': return ['● connected, slow', 'mcp-warn'];
    case 'failed': return ['● failed', 'mcp-err'];
    case 'unknown': return ['● added', 'mcp-off'];
    default: return ['not added', 'mcp-off'];
  }
}

/** Repaint every preset card from connectorStatus: chip, Add/Remove button, hint. */
function applyConnectorStatus() {
  state.connectorPresets.forEach(preset => {
    const ref = connectorCards.get(preset.id);
    if (!ref) return;
    const s = connectorStatus.get(preset.id);
    const [txt, cls] = connectorChip(s);
    ref.stat.textContent = txt;
    ref.stat.className = 'chip ' + cls;
    ref.stat.title = s ? (s.detail || '') : '';
    ref.add.textContent = s ? 'Remove' : 'Add connector';
    ref.add.className = s ? 'btn small danger' : 'btn small primary';
    ref.hint.textContent = !s ? ''
      : s.state === 'auth' ? 'Not signed in yet: open a terminal session, run /mcp, pick this server and choose Authenticate.'
      : s.state === 'failed' ? (s.detail || 'The server did not answer.')
      : s.state === 'degraded' ? 'Reachable, but its tool list timed out. Usually fine — try Refresh when fewer things are loading.'
      : '';
  });
}

function mcpRow(s, removable, { quiet = false } = {}) {
  const row = el('div', 'mcp-row');
  const [txt, cls] = connectorChip(s);
  const chip = el('span', 'chip ' + cls, txt);
  if (s.detail) chip.title = s.detail;
  row.appendChild(chip);
  row.appendChild(el('b', '', s.name));
  row.appendChild(el('span', 'meta', s.target));
  if ((s.state === 'failed' || s.state === 'degraded') && s.detail) row.appendChild(el('span', 'meta mcp-why', s.detail));
  // In the sign-in group the summary already says how; one line per row was noise.
  if (s.state === 'auth' && !quiet) row.appendChild(el('span', 'meta mcp-why', 'run /mcp in a session → Authenticate'));
  if (removable) {
    const rm = el('button', 'btn small danger', 'Remove');
    rm.addEventListener('click', async () => {
      rm.disabled = true;
      const r = await ccx.invoke('connectors:remove', { name: s.name });
      if (r.ok) { toast('Removed ' + s.name, 'ok'); refreshMcpList(); }
      else { rm.disabled = false; toast(r.error || 'Failed', 'err'); }
    });
    row.appendChild(rm);
  }
  return row;
}

// Groups the user opened on the Connectors list; a refresh redraws the list
// (and shows "Checking…" in between), which used to snap them shut.
let mcpOpenGroups = new Set();
function rememberMcpOpen() {
  const shown = [...$('#mcp-list').querySelectorAll('details')];
  if (shown.length) mcpOpenGroups = new Set(shown.filter(d => d.open).map(d => d.className));
}

function renderMcpRows(servers) {
  const box = $('#mcp-list');
  rememberMcpOpen();
  const wasOpen = mcpOpenGroups;
  box.innerHTML = '';
  const own = servers.filter(s => s.kind === 'own');
  const managed = servers.filter(s => s.kind === 'managed' && s.state !== 'off');
  if (!own.length) box.appendChild(el('div', 'meta', 'No connectors added yet — pick one above.'));
  own.forEach(s => box.appendChild(mcpRow(s, true)));
  if (managed.length) {
    // Plugins bring dozens of services that only need a sign-in to be used.
    // They are not faults, so they fold into one line under the ones that are
    // connected or failing.
    const signIn = managed.filter(s => s.state === 'auth');
    const rest = managed.filter(s => s.state !== 'auth');
    const counts = [];
    const n = (st) => rest.filter(s => s.state === st).length;
    if (n('connected')) counts.push(n('connected') + ' connected');
    if (n('failed') + n('degraded')) counts.push((n('failed') + n('degraded')) + ' failing');
    if (signIn.length) counts.push(signIn.length + ' need sign-in');
    const d = el('details', 'mcp-managed');
    d.appendChild(el('summary', '', 'Plugin and claude.ai servers — ' + counts.join(', ') + '. Managed by their plugins, not removable here.'));
    rest.forEach(s => d.appendChild(mcpRow(s, false)));
    if (signIn.length) {
      const g = el('details', 'mcp-signins');
      g.appendChild(el('summary', '', signIn.length + (signIn.length === 1 ? ' service needs' : ' services need')
        + ' a sign-in before use — only sign in to the ones you want: run /mcp in a session → pick it → Authenticate'));
      signIn.forEach(s => g.appendChild(mcpRow(s, false, { quiet: true })));
      if (wasOpen.has('mcp-signins')) g.open = true;
      d.appendChild(g);
    }
    if (wasOpen.has('mcp-managed')) d.open = true;
    box.appendChild(d);
  }
}

async function renderConnectors() {
  const grid = $('#connector-grid');
  if (grid.childElementCount) return; // rendered once; refresh button updates list
  state.connectorPresets.forEach(preset => {
    const card = el('div', 'card');
    const head = el('h4');
    head.appendChild(el('span', '', preset.name));
    head.appendChild(el('span', 'chip ' + (preset.kind === 'stdio' ? 'kind-stdio' : 'kind-oauth'), preset.kind === 'stdio' ? 'local' : 'OAuth'));
    const stat = el('span', 'chip mcp-off', 'checking…');
    head.appendChild(stat);
    card.appendChild(head);
    card.appendChild(el('div', 'blurb', preset.blurb));
    if (preset.url) card.appendChild(el('div', 'meta', preset.url));

    if (preset.supportsHeader) {
      const l = el('label', 'fld');
      l.appendChild(el('span', '', 'Optional: PAT header instead of OAuth'));
      const inp = el('input');
      inp.type = 'password';
      inp.placeholder = 'Paste a token (ghp_… / github_pat_…) — or leave empty for OAuth';
      inp.dataset.connectorHeader = preset.id;
      l.appendChild(inp);
      card.appendChild(l);
    }

    const row = el('div', 'row');
    const add = el('button', 'btn small primary', 'Add connector');
    const hint = el('div', 'meta conn-hint');
    add.addEventListener('click', async () => {
      add.disabled = true;
      if (connectorStatus.has(preset.id)) { // already added → this button is "Remove"
        add.textContent = 'Removing…';
        const r = await ccx.invoke('connectors:remove', { name: preset.id });
        add.disabled = false;
        if (r.ok) { toast('Removed ' + preset.name, 'ok'); refreshMcpList(); }
        else { toast(r.error || r.output || 'Failed', 'err'); applyConnectorStatus(); }
        return;
      }
      add.textContent = 'Adding…';
      const header = card.querySelector(`[data-connector-header="${preset.id}"]`);
      const r = await ccx.invoke('connectors:add', {
        presetId: preset.id,
        scope: $('#connector-scope').value,
        header: header ? header.value.trim() : '',
      });
      add.disabled = false;
      applyConnectorStatus();
      if (r.ok && r.output) { toast(r.output.trim().split('\n')[0] || 'Added', 'ok'); refreshMcpList(); }
      else toast(r.error || r.output || 'Failed', 'err');
    });
    row.appendChild(add);
    card.appendChild(hint);
    card.appendChild(row);
    connectorCards.set(preset.id, { stat, add, hint });
    grid.appendChild(card);
  });

  // GitHub — another account. Each account is its own server name holding its own
  // token, so several accounts can be connected side by side (github, github-work…).
  const ghPreset = state.connectorPresets.find(p => p.id === 'github');
  if (ghPreset) {
    const gh = el('div', 'card');
    const ghHead = el('h4');
    ghHead.appendChild(el('span', '', 'GitHub — another account'));
    ghHead.appendChild(el('span', 'chip kind-oauth', 'token'));
    gh.appendChild(ghHead);
    gh.appendChild(el('div', 'blurb',
      'Connect a second or third GitHub account next to the main one. Pick a short name for it and paste that account’s personal access token — it is kept in the claude CLI config, one server per account.'));
    const ghName = el('input'); ghName.type = 'text'; ghName.value = 'github-work'; ghName.placeholder = 'account name, e.g. github-work';
    const ghTok = el('input'); ghTok.type = 'password'; ghTok.placeholder = 'that account’s token (ghp_… / github_pat_…)';
    gh.appendChild(ghName); gh.appendChild(ghTok);
    const ghRow = el('div', 'row');
    const ghAdd = el('button', 'btn small primary', 'Add GitHub account');
    ghAdd.addEventListener('click', async () => {
      const name = ghName.value.trim();
      const tok = ghTok.value.trim();
      if (!name) return toast('Give the account a name', 'err');
      if (!tok) return toast('Paste that account’s token', 'err');
      if (connectorStatus.has(name)) return toast(name + ' already exists — remove it below first, or pick another name', 'err');
      ghAdd.disabled = true; ghAdd.textContent = 'Adding…';
      const r = await ccx.invoke('connectors:addCustom', { name, url: ghPreset.url, header: tok, scope: $('#connector-scope').value });
      ghAdd.disabled = false; ghAdd.textContent = 'Add GitHub account';
      if (r.ok) { ghTok.value = ''; toast('Added ' + name, 'ok'); refreshMcpList(); }
      else toast(r.error || r.output || 'Failed', 'err');
    });
    ghRow.appendChild(ghAdd);
    gh.appendChild(ghRow);
    grid.appendChild(gh);
  }

  // Custom connector — e.g. a second GitHub account under a different name.
  const custom = el('div', 'card');
  const chead = el('h4');
  chead.appendChild(el('span', '', 'Custom connector'));
  chead.appendChild(el('span', 'chip kind-oauth', 'OAuth / PAT'));
  custom.appendChild(chead);
  custom.appendChild(el('div', 'blurb',
    'Add any other HTTP MCP server by name + URL. Optional header: a full "Header: value" line, or just a token (sent as "Authorization: Bearer …"). For another GitHub account use the "GitHub — another account" card instead.'));
  const mkInput = (placeholder, value, type = 'text') => {
    const i = el('input'); i.type = type; if (value) i.value = value; i.placeholder = placeholder;
    return i;
  };
  const cName = mkInput('name, e.g. github-work');
  const cUrl = mkInput('https://server.example/mcp', '');
  const cHeader = mkInput('optional: token, or "Header: value"', '', 'password');
  custom.appendChild(cName); custom.appendChild(cUrl); custom.appendChild(cHeader);
  const crow = el('div', 'row');
  const cadd = el('button', 'btn small primary', 'Add custom connector');
  cadd.addEventListener('click', async () => {
    const name = cName.value.trim();
    const url = cUrl.value.trim();
    if (!name || !url) return toast('Name and URL are required', 'err');
    cadd.disabled = true; cadd.textContent = 'Adding…';
    const r = await ccx.invoke('connectors:addCustom', {
      name, url, header: cHeader.value.trim(), scope: $('#connector-scope').value,
    });
    cadd.disabled = false; cadd.textContent = 'Add custom connector';
    if (r.ok && r.output) { toast((r.output.trim().split('\n')[0] || 'Added') + ' — added ' + name, 'ok'); refreshMcpList(); }
    else toast(r.error || r.output || 'Failed', 'err');
  });
  crow.appendChild(cadd);
  custom.appendChild(crow);
  grid.appendChild(custom);
}

async function refreshMcpList() {
  if (connectorChecking) return;
  connectorChecking = true;
  const box = $('#mcp-list');
  const btn = $('#btn-mcp-refresh');
  btn.disabled = true; btn.textContent = '↻ Checking…';
  rememberMcpOpen();
  box.textContent = 'Checking every server — a health check can take up to a minute…';
  connectorCards.forEach(ref => { ref.stat.textContent = 'checking…'; ref.stat.className = 'chip mcp-off'; });
  let r;
  try { r = await ccx.invoke('connectors:status'); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  connectorChecking = false;
  btn.disabled = false; btn.textContent = '↻ Refresh';
  if (!r || !r.ok) {
    box.textContent = 'Could not run `claude mcp list`: ' + ((r && r.error) || 'unknown error');
    applyConnectorStatus();
    return;
  }
  const servers = Array.isArray(r.servers) ? r.servers : [];
  connectorCheckedAt = Date.now();
  connectorStatus.clear();
  servers.forEach(s => connectorStatus.set(s.name, s));
  applyConnectorStatus();
  renderMcpRows(servers);
}

/* ================= settings view ================= */

/** Parse the `model=number` per-line force-context box into {model: ctx}. */
function parseForceCtx(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(.+?)\s*=\s*(\d+)\s*$/);
    if (!m) continue;
    const ctx = Number(m[2]);
    if (ctx >= 4096 && ctx <= 4000000) out[m[1].trim().toLowerCase()] = ctx;
  }
  return out;
}

function renderSettings() {
  const body = $('#settings-body');
  if (body.childElementCount) return;
  body.innerHTML = '';
  const s = state.settings;

  // claude binary
  const c1 = el('div', 'settings-card');
  c1.appendChild(el('h4', '', 'Claude CLI'));
  const claudePathRow = el('div', 'inline');
  const pathInput = el('input'); pathInput.type = 'text'; pathInput.value = s.claudePath || '';
  pathInput.placeholder = 'auto-detect (~/.local/bin/claude, /usr/local/bin/claude …)';
  const redetect = el('button', 'btn', 'Auto-detect');
  redetect.addEventListener('click', async () => { pathInput.value = ''; await saveSettings({ claudePath: '' }); });
  claudePathRow.appendChild(pathInput); claudePathRow.appendChild(redetect);
  c1.appendChild(claudePathRow);
  const claudeStatus = el('div', 'hint');
  const ci = state.info && state.info.claude;
  claudeStatus.textContent = ci && ci.found ? `Detected: ${ci.path} (${ci.version})` : 'claude CLI not found — install it with: curl -fsSL https://claude.ai/install.sh | bash';
  c1.appendChild(claudeStatus);
  body.appendChild(c1);

  // terminal
  const c2 = el('div', 'settings-card');
  c2.appendChild(el('h4', '', 'Terminal'));
  const fontRow = el('div', 'inline');
  fontRow.appendChild(el('span', 'hint', 'Font size'));
  const fontInput = el('input'); fontInput.type = 'text'; fontInput.value = String(s.fontSize); fontInput.style.width = '70px';
  fontRow.appendChild(fontInput);
  fontRow.appendChild(el('span', 'hint', 'Scrollback lines'));
  const sbInput = el('input'); sbInput.type = 'text'; sbInput.value = String(s.scrollback); sbInput.style.width = '90px';
  fontRow.appendChild(sbInput);
  c2.appendChild(fontRow);
  c2.appendChild(el('div', 'hint', 'Font size applies to new sessions; scrollback to new sessions. Copy: Ctrl+Shift+C · Paste: Ctrl+Shift+V · New tab: Ctrl+Shift+T'));
  const pathRow = el('div', 'inline');
  pathRow.appendChild(el('span', 'hint', 'Agent PATH'));
  const pathState = el('span', 'hint mono', (s.loginEnv && s.loginEnv.PATH ? s.loginEnv.PATH.split(':').length + ' dirs' : 'from login shell'));
  pathState.title = (s.loginEnv && s.loginEnv.PATH) || '';
  const pathBtn = el('button', 'btn small', 'Refresh PATH');
  pathBtn.title = 'Re-read your login shell (picks up tools installed while the app is running). Applies to new sessions.';
  pathBtn.addEventListener('click', async () => {
    pathBtn.disabled = true;
    const r = await ccx.invoke('env:refresh');
    pathBtn.disabled = false;
    if (r.ok) {
      state.settings.loginEnv = { PATH: r.PATH };
      pathState.textContent = r.PATH.split(':').length + ' dirs';
      pathState.title = r.PATH;
      toast('PATH refreshed — new sessions see newly installed tools', 'ok');
    } else toast(r.error, 'err');
  });
  pathRow.appendChild(pathState); pathRow.appendChild(pathBtn);
  c2.appendChild(pathRow);
  body.appendChild(c2);

  // privacy
  const c3 = el('div', 'settings-card');
  c3.appendChild(el('h4', '', 'Privacy'));
  const telCheck = el('input'); telCheck.type = 'checkbox'; telCheck.checked = !!s.disableTelemetry;
  const telLabel = el('label', 'check');
  telLabel.appendChild(telCheck);
  telLabel.appendChild(el('span', '', 'Disable claude telemetry, error reporting and auto-updates in launched sessions'));
  c3.appendChild(telLabel);
  body.appendChild(c3);

  // chat behaviour
  const c3b = el('div', 'settings-card');
  c3b.appendChild(el('h4', '', 'Chat behaviour'));
  const nudgeCheck = el('input'); nudgeCheck.type = 'checkbox'; nudgeCheck.id = 'opt-autonudge';
  nudgeCheck.checked = s.autoNudge !== false;
  nudgeCheck.addEventListener('change', () => saveSettings({ autoNudge: nudgeCheck.checked }));
  const nudgeLabel = el('label', 'check');
  nudgeLabel.appendChild(nudgeCheck);
  nudgeLabel.appendChild(el('span', '', 'Auto-continue when a model stops after saying what it will do next'));
  c3b.appendChild(nudgeLabel);
  c3b.appendChild(el('div', 'hint', 'Some models end a turn on “Let me …” without making the tool call, so the chat just goes quiet. When this is on, cce sends one automatic reminder per prompt; the ▶ continue button is always available.'));
  const cmRow = el('label', 'check');
  cmRow.appendChild(el('span', '', 'context-mode plugin in chats'));
  const cmSel = el('select', 'skills-search');
  cmSel.id = 'opt-contextmode';
  for (const [v, t] of [['auto', 'Claude models only'], ['on', 'Every model'], ['off', 'Never']]) {
    const o = el('option', '', t); o.value = v; cmSel.appendChild(o);
  }
  cmSel.value = s.contextMode || 'auto';
  cmSel.addEventListener('change', () => saveSettings({ contextMode: cmSel.value }));
  cmRow.appendChild(cmSel);
  c3b.appendChild(cmRow);
  c3b.appendChild(el('div', 'hint', 'context-mode hides command output behind a search index. Claude searches it; other models usually re-run the same command over and over. Applies to new chats.'));
  // Shell-output filter: the main process compacts big command output before
  // it is handed to the model, so a noisy build log stops costing tokens.
  const ofRow = el('label', 'check');
  ofRow.appendChild(el('span', '', 'compact shell output sent to the model'));
  const ofSel = el('select', 'skills-search');
  ofSel.id = 'opt-outputfilter';
  for (const [v, t] of [['on', 'Compacted — head + tail, repeated lines collapsed'], ['off', 'Full output (engine\'s own limit)']]) {
    const o = el('option', '', t); o.value = v; ofSel.appendChild(o);
  }
  ofSel.value = s.outputFilter || 'on';
  ofSel.style.maxWidth = '340px';
  ofSel.addEventListener('change', () => saveSettings({ outputFilter: ofSel.value }));
  ofRow.appendChild(ofSel);
  c3b.appendChild(ofRow);
  const ofMaxRow = el('label', 'fld');
  ofMaxRow.appendChild(el('span', '', 'characters of shell output the model may read'));
  const ofMax = el('input');
  ofMax.type = 'number';
  ofMax.id = 'opt-outputfilter-max';
  ofMax.min = '500';
  ofMax.max = '100000';
  ofMax.step = '500';
  ofMax.value = String(s.outputFilterMaxChars || 8000);
  // The stylesheet only dresses text/password inputs, so the number box gets
  // the same look inline.
  ofMax.style.width = '160px';
  ofMax.style.background = 'var(--bg2)';
  ofMax.style.color = 'var(--text)';
  ofMax.style.border = '1px solid var(--border)';
  ofMax.style.borderRadius = '8px';
  ofMax.style.padding = '8px 10px';
  ofMax.style.fontSize = '13px';
  ofMax.addEventListener('change', () => {
    const n = Math.max(500, Math.min(100000, Number(ofMax.value) || 8000));
    ofMax.value = String(n);
    saveSettings({ outputFilterMaxChars: n });
  });
  ofMaxRow.appendChild(ofMax);
  c3b.appendChild(ofMaxRow);
  c3b.appendChild(el('div', 'hint', 'The card in the chat still shows the full output — only what the model reads is compacted, so long build logs cost fewer tokens. The budget is how many characters of a command’s output the model may see. Applies to new chats.'));
  body.appendChild(c3b);

  // sandbox
  const c4 = el('div', 'settings-card');
  c4.appendChild(el('h4', '', 'Sandboxed command execution'));
  c4.appendChild(el('div', 'hint', 'Runs every Bash command in a Bubblewrap sandbox with restricted filesystem and network access (claude code sandbox). Requires: sudo apt install bubblewrap. Applies to new chats.'));
  const sbEnabled = el('input'); sbEnabled.type = 'checkbox'; sbEnabled.id = 'sb-enabled'; sbEnabled.checked = !!(s.sandbox && s.sandbox.enabled);
  const sbEnabledLabel = el('label', 'check');
  sbEnabledLabel.appendChild(sbEnabled);
  sbEnabledLabel.appendChild(el('span', '', 'Enable sandbox for new chats'));
  c4.appendChild(sbEnabledLabel);
  const sbAuto = el('input'); sbAuto.type = 'checkbox'; sbAuto.id = 'sb-auto'; sbAuto.checked = !(s.sandbox && s.sandbox.autoAllowBashIfSandboxed === false);
  const sbAutoLabel = el('label', 'check');
  sbAutoLabel.appendChild(sbAuto);
  sbAutoLabel.appendChild(el('span', '', 'Auto-approve sandboxed bash (safe: it is isolated)'));
  c4.appendChild(sbAutoLabel);
  const sbUnsand = el('input'); sbUnsand.type = 'checkbox'; sbUnsand.id = 'sb-unsand'; sbUnsand.checked = !!(s.sandbox && s.sandbox.allowUnsandboxedCommands);
  const sbUnsandLabel = el('label', 'check');
  sbUnsandLabel.appendChild(sbUnsand);
  sbUnsandLabel.appendChild(el('span', '', 'Allow commands to request escaping the sandbox (still asks you)'));
  c4.appendChild(sbUnsandLabel);
  const sbLocal = el('input'); sbLocal.type = 'checkbox'; sbLocal.id = 'sb-local'; sbLocal.checked = !(s.sandbox && s.sandbox.allowLocalBinding === false);
  const sbLocalLabel = el('label', 'check');
  sbLocalLabel.appendChild(sbLocal);
  sbLocalLabel.appendChild(el('span', '', 'Allow local port binding (dev servers, localhost tests)'));
  c4.appendChild(sbLocalLabel);
  const domLabel = el('label', 'fld');
  domLabel.appendChild(el('span', '', 'Network allowlist — domains the sandbox may reach (comma-separated, empty = ask per permission rules)'));
  const sbDomains = el('input'); sbDomains.type = 'text';
  sbDomains.value = (s.sandbox && Array.isArray(s.sandbox.allowedDomains) ? s.sandbox.allowedDomains.join(', ') : '');
  sbDomains.placeholder = 'registry.npmjs.org, github.com, pypi.org';
  domLabel.appendChild(sbDomains);
  c4.appendChild(domLabel);
  body.appendChild(c4);

  // session caps + model fallbacks (Agent SDK options)
  const c5 = el('div', 'settings-card');
  c5.appendChild(el('h4', '', 'Session caps & model'));
  c5.appendChild(el('div', 'hint', 'Applied to new chats. Leave blank for no cap.'));
  const mkFld = (labelText, value, placeholder) => {
    const l = el('label', 'fld');
    l.appendChild(el('span', '', labelText));
    const inp = el('input'); inp.type = 'text'; inp.value = value || ''; inp.placeholder = placeholder || '';
    l.appendChild(inp);
    c5.appendChild(l);
    return inp;
  };
  const budInput = mkFld('Max spend per session (USD)', s.maxBudgetUsd, 'e.g. 5');
  const turnsInput = mkFld('Max turns per session', s.maxTurns, 'e.g. 40');
  const fbInput = mkFld('Fallback model (used when the main model is overloaded)', s.fallbackModel, 'e.g. gpt-oss:120b-cloud');
  const tbInput = mkFld('Thinking budget (tokens, blank = model default)', s.thinkingBudget, 'e.g. 8192');
  const efInput = mkFld('Effort level (blank = model default)', s.effort, 'low / medium / high');
  const m1 = el('label', 'check');
  const m1c = el('input'); m1c.type = 'checkbox'; m1c.checked = !!s.context1m;
  m1.appendChild(m1c);
  m1.appendChild(el('span', '', '1M-token context window (models that support it)'));
  c5.appendChild(m1);
  body.appendChild(c5);

  // updates (release ping)
  const c7 = el('div', 'settings-card');
  c7.appendChild(el('h4', '', 'Updates'));
  const upRow = el('div', 'row');
  const upBtn = el('button', 'btn small', 'Check for updates');
  const upState = el('span', 'hint', 'installed: v' + ((state.info && state.info.appVersion) || '?'));
  upBtn.addEventListener('click', async () => {
    upBtn.disabled = true;
    const r = await ccx.invoke('update:check');
    upBtn.disabled = false;
    if (!r.ok) { upState.textContent = r.error; return; }
    if (!r.latest) { upState.textContent = 'v' + r.current + ' · ' + r.note; return; }
    const newer = r.latest !== r.current;
    upState.textContent = newer
      ? 'v' + r.current + ' → v' + r.latest + ' available'
      : 'v' + r.current + ' is the latest release';
    if (newer && r.url) {
      const a = el('a', '', ' open release page');
      a.href = '#';
      a.addEventListener('click', (e) => { e.preventDefault(); ccx.invoke('shell:openExternal', { url: r.url }); });
      upState.appendChild(a);
    }
  });
  upRow.appendChild(upBtn);
  upRow.appendChild(upState);
  c7.appendChild(upRow);
  const diagRow = el('div', 'row');
  const diagBtn = el('button', 'btn small ghost', 'Copy diagnostics');
  diagBtn.title = 'Copy a redacted diagnostics report to the clipboard (for bug reports)';
  diagBtn.addEventListener('click', async () => {
    const prov = await ccx.invoke('providers:all');
    const auth = await ccx.invoke('auth:status');
    const info = state.info || {};
    const s = state.settings || {};
    const lines = [
      'Claude Code Enhanced — diagnostics report',
      'version: ' + (info.appVersion || '?'),
      'electron: ' + (info.electron || '?'),
      'claude CLI: ' + JSON.stringify((info.claude || {})),
      'providers: ' + (prov && prov.instances ? prov.instances.length : 0),
      'defaultProviderUid: ' + (s.defaultProviderUid || 'none'),
      'closeToTray: ' + s.closeToTray,
      'outputFilter: ' + (s.outputFilter || 'off'),
      'outputFilterMaxChars: ' + (s.outputFilterMaxChars || 0),
      'localNumCtx: ' + (s.localNumCtx || 73728),
      'auth: ' + JSON.stringify(auth || {}),
      'timestamp: ' + new Date().toISOString(),
    ];
    try { await ccx.invoke('clipboard:write', { text: lines.join('\n') }); toast('Diagnostics copied to clipboard', 'ok'); }
    catch (e) { toast('Failed to copy diagnostics', 'err'); }
  });
  diagRow.appendChild(diagBtn);
  c7.appendChild(diagRow);
  body.appendChild(c7);

  // local models (Ollama)
  const c8 = el('div', 'settings-card');
  c8.appendChild(el('h4', '', 'Local models (Ollama)'));
  c8.appendChild(el('div', 'hint', 'Preferred context window when pre-warming local Ollama models for new chats. The claude engine base prompt needs ≥70K tokens. Sizes that do not fit in free RAM are stepped down automatically (a too-large cache kills the model runner) — 4GB-VRAM machines usually top out near 70K. Values below 70K make local models reject claude chats.'));
  const lctxRow = el('div', 'inline');
  lctxRow.appendChild(el('span', 'hint', 'num_ctx for new chats'));
  const localCtxSel = el('select'); localCtxSel.style.width = '220px';
  [['16384', '16K'], ['32768', '32K'], ['73728', '72K (recommended: fits the engine prompt)'], ['131072', '128K (needs ~14 GB RAM for a 4B model)'], ['262144', '256K']].forEach(([v, n]) => {
    const o = el('option', '', n); o.value = v; localCtxSel.appendChild(o);
  });
  localCtxSel.value = String(s.localNumCtx || 73728);
  lctxRow.appendChild(localCtxSel);
  c8.appendChild(lctxRow);
  // Per-model context override: skips the 70K floor for that model. Warn, don't
  // block — a small model may still serve simple turns, and it is the user's call. #11
  const forceLbl = el('label', 'fld');
  forceLbl.appendChild(el('span', '', 'Force context per model — one `model=number` per line. The engine usually rejects turns past the model\u2019s real context, so use this only for models you know.'));
  const forceInput = el('textarea', 'force-ctx');
  forceInput.rows = 2;
  forceInput.placeholder = 'qwen3-4b=32768';
  forceInput.value = Object.entries(s.forceCtx || {}).map(([k, v]) => k + '=' + v).join('\n');
  forceLbl.appendChild(forceInput);
  c8.appendChild(forceLbl);
  body.appendChild(c8);

  // appearance (#47) + window behaviour (#46) + notifications (#36)
  const c9 = el('div', 'settings-card');
  c9.appendChild(el('h4', '', 'Appearance & window'));
  const themeRow = el('div', 'inline');
  themeRow.appendChild(el('span', 'hint', 'Theme'));
  const themeSel = el('select'); themeSel.style.width = '160px';
  for (const [v, n] of [['dark', 'dark'], ['light', 'light']]) {
    const o = el('option', '', n); o.value = v; themeSel.appendChild(o);
  }
  themeSel.value = s.theme === 'light' ? 'light' : 'dark';
  applyTheme(themeSel.value);
  themeRow.appendChild(themeSel);
  c9.appendChild(themeRow);
  const trayCheck = el('input'); trayCheck.type = 'checkbox'; trayCheck.checked = !!s.closeToTray;
  const trayLabel = el('label', 'check');
  trayLabel.appendChild(trayCheck);
  trayLabel.appendChild(el('span', '', 'Close to tray — keep chats running when the window is closed'));
  c9.appendChild(trayLabel);
  const notifyCheck = el('input'); notifyCheck.type = 'checkbox'; notifyCheck.checked = s.notifyOnDone !== false;
  const notifyLabel = el('label', 'check');
  notifyLabel.appendChild(notifyCheck);
  notifyLabel.appendChild(el('span', '', 'Notify when a turn finishes while the window is in the background'));
  c9.appendChild(notifyLabel);
  body.appendChild(c9);

  // lean tools (#41) + provider failover chain (#42)
  const c10 = el('div', 'settings-card');
  c10.appendChild(el('h4', '', 'Small local models'));
  c10.appendChild(el('div', 'hint',
    'The claude engine ships a large base prompt (skills + plugins ≈ 68K tokens). Cutting the tool list is the only real way to make a 3-4B model fit — every tool schema is prompt. Per-provider overrides live in Providers → ⚙ on the provider card.'));
  const leanSel = el('select'); leanSel.style.width = '260px';
  const oOff = el('option', '', 'full tool set (default)'); oOff.value = ''; leanSel.appendChild(oOff);
  for (const p of (state.leanPresets || [])) {
    const o = el('option', '', p.label + ' — ' + p.tools.length + ' tools'); o.value = p.id; leanSel.appendChild(o);
  }
  leanSel.value = s.leanToolsPreset || '';
  c10.appendChild(leanSel);
  const preset = (state.leanPresets || []).find(p => p.id === leanSel.value);
  if (preset) c10.appendChild(el('div', 'hint', 'Allowed: ' + preset.tools.join(', ')));

  const fo = el('label', 'fld');
  fo.appendChild(el('span', '', 'Provider failover chain (retry a failed turn on the next provider)'));
  const chain = Array.isArray(s.failoverChain) ? s.failoverChain : [];
  const chainWrap = el('div', 'chain-wrap');
  state.providers.instances.forEach((p) => {
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = chain.includes(p.uid); cb.dataset.uid = p.uid;
    const l = el('label', 'check');
    l.appendChild(cb);
    l.appendChild(el('span', '', p.name));
    chainWrap.appendChild(l);
  });
  if (!state.providers.instances.length) chainWrap.appendChild(el('div', 'hint', 'no providers configured'));
  fo.appendChild(chainWrap);
  c10.appendChild(fo);
  body.appendChild(c10);

  // save
  const saveBtn = el('button', 'btn primary', 'Save settings');
  saveBtn.style.alignSelf = 'flex-start';
  saveBtn.addEventListener('click', async () => {
    await saveSettings({
      claudePath: pathInput.value.trim(),
      fontSize: Math.max(8, Math.min(24, parseInt(fontInput.value, 10) || 14)),
      scrollback: Math.max(500, Math.min(200000, parseInt(sbInput.value, 10) || 5000)),
      disableTelemetry: telCheck.checked,
      maxBudgetUsd: parseFloat(budInput.value) || 0,
      maxTurns: parseInt(turnsInput.value, 10) || 0,
      fallbackModel: fbInput.value.trim(),
      thinkingBudget: parseInt(tbInput.value, 10) || 0,
      effort: efInput.value.trim(),
      context1m: m1c.checked,
      localNumCtx: Number(localCtxSel.value) || 73728,
      forceCtx: parseForceCtx(forceInput.value),
      theme: themeSel.value,
      closeToTray: trayCheck.checked,
      notifyOnDone: notifyCheck.checked,
      // Store the preset id, resolved to a tool list in main so the renderer
      // never has to send a tool array it could get wrong.
      leanToolsPreset: leanSel.value,
      failoverChain: [...chainWrap.querySelectorAll('input[type=checkbox]')]
        .filter(cb => cb.checked).map(cb => cb.dataset.uid),
      sandbox: {
        enabled: sbEnabled.checked,
        autoAllowBashIfSandboxed: sbAuto.checked,
        allowUnsandboxedCommands: sbUnsand.checked,
        allowLocalBinding: sbLocal.checked,
        allowedDomains: sbDomains.value.split(',').map(x => x.trim()).filter(Boolean),
      },
    });
    for (const sess of state.sessions.values()) {
      sess.term.options.fontSize = state.settings.fontSize;
      sess.term.options.scrollback = state.settings.scrollback;
      sess.fit.fit();
    }
  });
  body.appendChild(saveBtn);
}

async function saveSettings(patch) {
  const r = await ccx.invoke('settings:set', { settings: patch });
  if (r.ok) {
    state.settings = r.settings;
    state.info = { ...state.info, claude: r.claude };
    renderClaudeBanner();
    updateStatusbar(state.sessions.get(state.activeId) || { provider: null, alive: true, cwd: '' });
    toast('Settings saved', 'ok');
  } else toast(r.error, 'err');
}

function renderClaudeBanner() {
  const banner = $('#claude-banner');
  const ci = state.info && state.info.claude;
  if (!ci || !ci.found) {
    banner.classList.remove('hidden');
    banner.textContent = 'claude CLI not found — ';
    const b = el('button', 'btn small primary', 'install it now');
    b.title = 'Opens a terminal tab running: curl -fsSL https://claude.ai/install.sh | bash';
    b.addEventListener('click', () => {
      window.createSession({ cwd: '~', type: 'shell', initText: 'curl -fsSL https://claude.ai/install.sh | bash\r' });
    });
    banner.appendChild(b);
    const re = el('button', 'btn small', 're-check');
    re.title = 'Probe for the claude CLI again (e.g. right after installing or updating it)';
    re.addEventListener('click', async () => {
      const r = await ccx.invoke('app:info', { refresh: true });
      if (r && r.ok) {
        state.info = { ...state.info, claude: r.claude };
        renderClaudeBanner();
        if (r.claude && r.claude.found) toast('claude found: ' + r.claude.version, 'ok');
      }
    });
    banner.appendChild(re);
    banner.appendChild(el('span', '', ' (or set the path in Settings)'));
  } else banner.classList.add('hidden');
}

/* ================= second window ================= */

// A second application window. Which chats and terminals belong to which
// window is the main process's business, so the renderer only has to ask.
async function openNewWindow() {
  // The preload throws for a channel it does not allow, so a missing handler
  // is a rejected promise, not a { ok: false } reply. Catch both.
  let r = null;
  try {
    r = await ccx.invoke('window:new', {});
  } catch (err) {
    toast('Could not open a new window: ' + String(err && err.message || err), 'err');
    return;
  }
  if (!r || !r.ok) toast((r && r.error) || 'Could not open a new window', 'err');
}

/* ================= boot ================= */

function wireChrome() {
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
  paintDeclaredIcons();
  $('#qa-new').addEventListener('click', openNewSessionModal);
  $('#btn-convo-drop').addEventListener('click', () => toggleConversations());
  $('#qa-resume').addEventListener('click', resumeLatest);
  $('#qa-browse').addEventListener('click', () => toggleConversations());
  $('#qa-reopen').addEventListener('click', reopenLastClosed);
  paintReopenButton();
  $('#btn-usage-refresh').addEventListener('click', () => renderUsage());
  $('#btn-add-provider').addEventListener('click', () => (window.ProvidersUI ? ProvidersUI.openConnect() : openProviderEditor(null)));
  $('#btn-mcp-refresh').addEventListener('click', refreshMcpList);
  // (The per-dropdown wiring — search/sort/filter/refresh/close — lives in
  // ensureConvoDrop, which builds that markup. Nothing to wire here.)
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
  $('#btn-overview-refresh')?.addEventListener('click', () => { window.__connCache = {}; renderOverview(); });
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
        const i = ids.indexOf(state.activeId);
        activateSession(ids[(i + (e.shiftKey ? ids.length - 1 : 1) + ids.length) % ids.length]);
      }
      return;
    }
    // Escape closes the Conversations dropdown before anything else claims it.
    if (e.key === 'Escape') {
      const drop = document.querySelector('#convo-drop');
      if (drop && !drop.classList.contains('hidden')) {
        e.preventDefault();
        toggleConversations(false);
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
    if (mod && k === 'k' && inChat && window.Chat && state.view === 'conversations') {
      const c = Chat.chats.get(state.activeId);
      // Only when focus is in the chat itself (or nowhere). The side-panel
      // shell, the diff editor, other views and dialogs keep their own keys.
      const t = e.target;
      const home = !t || t === document.body || t === document.documentElement
        || (c && c.pane.contains(t)) || !!(t.closest && t.closest('.palette-back'));
      const own = !!(t && t.closest && t.closest('.xterm, .monaco-editor'));
      if (c && home && !own) {
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

ccx.onPtyData(({ id, data }) => {
  // The right-rail terminal has its own PTY, so its output lands here.
  if (splitSession && splitSession.id === id) {
    if (splitTerm) splitTerm.write(data);
    return;
  }
  const s = state.sessions.get(id);
  if (s) s.term.write(data);
});
ccx.onPtyExit(({ id, exitCode }) => {
  if (splitSession && splitSession.id === id) {
    splitSession = null;
    if (splitTerm) splitTerm.write(`\r\n\x1b[2m[session exited · code ${exitCode}]\x1b[0m\r\n`);
    return;
  }
  const s = state.sessions.get(id);
  if (s) {
    s.alive = false;
    s.term.write(`\r\n\x1b[2m[session exited · code ${exitCode}]\x1b[0m\r\n`);
    s.tabEl && s.tabEl.classList.add('dead');
    if (id === state.activeId) updateStatusbar(s);
  }
});

// Usage view: daily spend parsed from stored transcripts (#35).
async function renderUsage() {
  const sum = $('#usage-summary');
  const box = $('#usage-days');
  if (!sum || !box) return;
  sum.textContent = 'loading…';
  box.innerHTML = '';
  const r = await ccx.invoke('usage:scan');
  // The view can be torn down while the (slow) transcript scan runs.
  if (!sum || !box || !sum.isConnected) return;
  if (!r.ok) { sum.textContent = 'failed: ' + r.error; return; }
  const days = r.days || [];
  const max = Math.max(...days.map(d => d.tokens), 1);
  const recent = days.reduce((a, d) => a + d.cost, 0);
  const tok = days.reduce((a, d) => a + d.tokens, 0);
  sum.innerHTML = '';
  const line = el('div', '',
    'sessions with activity: ' + (r.sessions || 0)
    + '  ·  tokens (last ' + days.length + ' active days): ' + tok.toLocaleString()
    + '  ·  cost reported by engine: $' + recent.toFixed(4)
    + '  (relay/local models often report no cost)');
  sum.appendChild(line);
  if (!days.length) { box.appendChild(el('div', 'hint', 'No sessions found on this machine.')); return; }
  for (const d of days) {
    const row = el('div', 'usage-row');
    row.appendChild(el('span', 'usage-day', d.day));
    const bar = el('span', 'usage-bar');
    const fill = el('i');
    fill.style.width = ((d.tokens / max) * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    row.appendChild(el('span', 'usage-val', fmtTokShort(d.tokens)));
    row.appendChild(el('span', 'usage-meta', d.sessions + ' sess · ' + d.turns + ' msgs'));
    row.title = d.day + '\ntokens ' + d.tokens.toLocaleString()
      + '\nsessions ' + d.sessions + '\nmessages ' + d.turns
      + '\ncost reported $' + d.cost.toFixed(4);
    box.appendChild(row);
  }
}

function fmtTokShort(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
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
  if (window.__CCE_SMOKE) {
    setTimeout(() => console.log('[monaco]', !!(window.monaco && window.monaco.editor)), 3000);
  }
  renderConnectors();
  renderSettings();
  switchView('terminal');

  // Welcome session — desktop-style chat on the real Agent SDK stream.
  await Chat.createSession({
    cwd: state.settings.defaultCwd || '~',
    providerUid: state.providers.defaultUid,
  });
})();
