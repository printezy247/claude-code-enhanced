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
function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => t.remove(), 4000);
}
// Real HTML escaping: several call sites interpolate provider- and
// server-supplied strings into innerHTML, and MCP server names are untrusted. #7
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const state = {
  info: null,
  settings: null,
  providers: { presets: [], instances: [], defaultUid: null },
  leanPresets: [],
  theme: 'dark',
  connectorPresets: [],
  sessions: new Map(),   // id -> { term, fit, tabEl, pane, alive, label, cwd, provider }
  activeId: null,
  view: 'terminal',
  booting: true,
};

const TERM_THEME = {
  background: '#0f0f15',
  foreground: '#e9e9f0',
  cursor: '#d97757',
  cursorAccent: '#0f0f15',
  selectionBackground: 'rgba(217,119,87,0.30)',
  black: '#101017', red: '#d2626a', green: '#7dc98f', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c8c8d4',
  brightBlack: '#61627a', brightRed: '#e8878d', brightGreen: '#9ddba7',
  brightYellow: '#eecb8b', brightBlue: '#9cc2ff', brightMagenta: '#cdb4fc',
  brightCyan: '#a8dcff', brightWhite: '#e9e9f0',
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
    // The list belongs to this tab, so it is always present here.
    const box = document.querySelector('#convos');
    if (box) box.classList.add('open');
    const s = state.sessions.get(state.activeId);
    if (s) { s.fit && s.fit.fit(); s.term && s.term.focus(); }
    if (convoSessions.length) renderConversationList(); else loadConversationList();
  }
  if (view === 'usage') renderUsage();
  if (view === 'providers') renderProviders();
  if (view === 'connectors') renderConnectors();
  if (view === 'settings') renderSettings();
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

function renderConversationList() {
  const root = document.querySelector('#convo-list');
  if (!root) return;
  const foot = document.querySelector('#convo-foot');
  const q = String((document.querySelector('.convo-search') || {}).value || '').trim().toLowerCase();
  const folder = (document.querySelector('.convo-filter') || {}).value || '';
  const sort = (document.querySelector('.convo-sort') || {}).value || 'new';

  let items = convoSessions.filter((s) => !q
    || String(s.preview || '').toLowerCase().includes(q)
    || String(s.cwd || s.folder || '').toLowerCase().includes(q));
  if (folder) items = items.filter((s) => String(s.cwd || s.folder || '~') === folder);

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
    root.appendChild(el('div', 'hint', q || folder ? 'Nothing matches.' : 'No conversations yet.'));
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
  for (const [cwd, rows] of ordered) {
    const sec = el('div', 'convo-group');
    const head = el('div', 'convo-sec');
    head.appendChild(el('span', 'cs-name', basenameOf(cwd)));
    head.appendChild(el('span', 'cs-path', cwd === '~' ? '~' : cwd));
    head.appendChild(el('span', 'cs-count', String(rows.length)));
    head.title = cwd;
    sec.appendChild(head);
    const listEl = el('div', 'convo-rows');
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
function convoRow(s, cwd) {
  const row = el('div', 'convo-row');
  row.title = (s.preview || '(empty session)') + '\n' + cwd;
  const main = el('div', 'convo-main');
  main.appendChild(el('div', 'convo-preview', s.preview || '(empty session)'));
  main.appendChild(el('div', 'convo-meta', basenameOf(cwd) + ' · ' + convoAge(s.mtime)));
  row.appendChild(main);

  // Live tab state, so the row shows which conversations are already open.
  const openTab = [...tabRegistry.entries()].find(([, meta]) =>
    meta.sessionId === s.sessionId);
  if (openTab) {
    row.classList.add('is-open');
    row.appendChild(el('span', 'chip open-chip', 'open'));
  }

  const menu = el('button', 'convo-more', '▾');
  menu.title = 'Conversation actions';
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    openConvoMenu(menu, s, cwd);
  });
  row.appendChild(menu);

  row.addEventListener('click', () => {
    Chat.createSession({ cwd, resume: s.sessionId });
    switchView('conversations');
  });
  return row;
}

/** The ▾ dropdown for one conversation. */
function openConvoMenu(anchor, s, cwd) {
  document.querySelectorAll('.convo-menu').forEach(m => m.remove());
  const menu = el('div', 'convo-menu');
  const add = (label, hint, run) => {
    const b = el('button', 'convo-menu-item');
    b.appendChild(el('span', 'cm-label', label));
    if (hint) b.appendChild(el('span', 'cm-hint', hint));
    b.addEventListener('click', () => { menu.remove(); run(); });
    menu.appendChild(b);
    return b;
  };
  add('Open', 'resume live', () => {
    Chat.createSession({ cwd, resume: s.sessionId });
    switchView('conversations');
  });
  add('Fork', 'branch a copy', () => {
    Chat.createSession({ cwd, resume: s.sessionId, fork: true });
    switchView('conversations');
  });
  add('Transcript', 'read it first', () => showTranscript(s, cwd));
  add('Export', 'markdown file', async () => {
    const r = await ccx.invoke('chat:export', { cwd, sessionId: s.sessionId });
    if (r.ok && r.saved) toast('Saved ' + r.path, 'ok');
    else if (!r.ok) toast(r.error, 'err');
  });
  add('New chat in this folder', basenameOf(cwd), () => {
    Chat.createSession({ cwd });
    switchView('conversations');
  });
  const del = add('Delete', 'removes from disk', async () => {
    const r = await ccx.invoke('chat:delete', { cwd, sessionId: s.sessionId });
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
  const modal = el('div', 'modal wide');
  modal.appendChild(el('h3', '', (s.preview || 'Conversation').slice(0, 90)));
  modal.appendChild(el('div', 'hint', cwd + ' · ' + new Date(s.mtime).toLocaleString()));
  const body = el('pre', 'transcript-pre', 'loading…');
  modal.appendChild(body);
  const r = await ccx.invoke('chat:transcript', { cwd, sessionId: s.sessionId });
  if (r && r.ok && r.items) {
    body.textContent = r.items.map((it) => {
      if (it.t === 'user') return '## You\n' + it.text;
      if (it.t === 'assistant') return '## Claude\n' + it.text;
      if (it.t === 'thinking') return '(thinking) ' + it.text.slice(0, 400);
      return '[' + it.name + '] ' + JSON.stringify(it.input || {}).slice(0, 300);
    }).join('\n\n') || '(empty)';
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
    switchView('conversations');
  });
  const fork = el('button', 'btn', 'Fork');
  fork.addEventListener('click', () => {
    overlay.remove();
    Chat.createSession({ cwd, resume: s.sessionId, fork: true });
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
  const sel = document.querySelector('.convo-filter');
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

/** Show or hide the list. It is open by default in the Conversations view. */
function toggleConversations(force) {
  const box = document.querySelector('#convos');
  if (!box) return;
  const open = force !== undefined ? force : !box.classList.contains('open');
  box.classList.toggle('open', open);
  if (open) loadConversationList();
}

const basenameOf = (p) => String(p || '~').replace(/\/+$/, '').split('/').pop() || String(p || '');

/* ================= split view (#44) ================= */

let splitTerm = null;

function toggleSplit(force) {
  const main = document.querySelector('#main');
  const pane = document.querySelector('#splitpane');
  if (!main || !pane) return;
  const open = force !== undefined ? force : !main.classList.contains('split');
  main.classList.toggle('split', open);
  pane.style.width = open ? '38%' : '0';
  if (open) renderSplit();
}

function renderSplit() {
  const kind = document.querySelector('#split-kind')?.value || 'terminal';
  const body = document.querySelector('#split-body');
  if (!body) return;
  if (kind === 'terminal') {
    const active = state.sessions.get(state.activeId);
    const cwd = active ? active.cwd : (state.settings && state.settings.defaultCwd) || '';
    if (!splitTerm) {
      splitTerm = new TermCtor({
        fontSize: 12, scrollback: 2000, cursorBlink: true, theme: TERM_THEME,
        fontFamily: "'JetBrains Mono','Fira Code','DejaVu Sans Mono',monospace",
      });
      const fit = new FitCtor();
      splitTerm.loadAddon(fit);
      body.innerHTML = '';
      body.appendChild(splitTerm);
      splitTerm.open(body);
      splitTerm._fit = fit;
    }
    try { splitTerm._fit.fit(); } catch { /* hidden */ }
    return;
  }
  body.innerHTML = '';
  const active = state.sessions.get(state.activeId);
  const cwd = active ? active.cwd : (state.settings && state.settings.defaultCwd) || '';
  if (kind === 'changes') {
    ccx.invoke('git:info', { cwd }).then((r) => {
      const info = r.ok ? r : {};
      const line = el('div', 'hint',
        (info.repo ? '⎇ ' + info.repo : 'not a git repository')
        + (info.branch ? ' · ' + info.branch : '')
        + (info.dirty ? ' · ' + info.dirty + ' uncommitted file(s)' : ' · clean'));
      body.appendChild(line);
      body.appendChild(el('div', 'hint', 'Open a chat and ask for a diff, or use ▶ run here.'));
    });
    return;
  }
  const chat = Chat.chats.get(state.activeId);
  const card = chat && chat.msgs ? chat.msgs.querySelector('.monaco-diff') : null;
  if (card) {
    const clone = card.cloneNode(true);
    body.appendChild(clone);
    if (card.__init) card.__init();
    body.appendChild(el('div', 'hint', 'Diff of the most recent file edit in this chat.'));
  } else {
    body.appendChild(el('div', 'hint', 'No edit diff yet in this chat.'));
  }
}
window.toggleSplit = toggleSplit;
window.renderSplit = renderSplit;

/** Chat.js calls this when a tab learns its engine session id. */
window.onConvoSessionsChanged = () => {
  if (state.view === 'conversations' && convoSessions.length) renderConversationList();
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
  const closeBtn = el('button', 'close', '✕');
  closeBtn.title = 'Close session';
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
  if (meta && meta.kind === 'chat') { await Chat.closeChat(id); return; }
  const s = state.sessions.get(id);
  if (!s) return;
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

function updateSessionCount() {
  $('#sess-count').textContent = String(tabRegistry.size);
}
window.updateTabCount = updateSessionCount;

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
  [['default', 'normal — ask for each tool'], ['acceptEdits', 'accept edits — auto-approve files'], ['plan', 'plan — read-only planning'], ['auto', 'auto — classifier decides'], ['bypassPermissions', 'yolo — no prompts']].forEach(([v, n]) => {
    const o = el('option', '', n); o.value = v; modeSel.appendChild(o);
  });
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
  const grid = $('#provider-grid');
  grid.innerHTML = '';
  $('#provider-banner').innerHTML = '';
  const banner = $('#provider-banner');
  banner.appendChild(el('span', '', 'Providers inject environment variables into new sessions: '));
  for (const v of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
    banner.appendChild(el('code', '', v));
    banner.appendChild(el('span', '', ' '));
  }
  banner.appendChild(el('span', '', '— the claude CLI itself stays unmodified. Anthropic subscription users authenticate with /login (OAuth) instead of a key.'));

  state.providers.instances.forEach(p => {
    const card = el('div', 'card');
    const head = el('h4');
    head.appendChild(el('span', '', p.name));
    if (p.uid === state.providers.defaultUid) head.appendChild(el('span', 'chip default', 'default'));
    const preset = state.providers.presets.find(x => x.id === p.presetId);
    if (preset) head.appendChild(el('span', 'chip kind-' + preset.kind, preset.kind === 'oauth' ? 'OAuth' : preset.kind === 'stdio' ? 'local' : 'API key'));
    card.appendChild(head);

    if (preset) card.appendChild(el('div', 'blurb', preset.blurb));
    if (p.baseUrl) card.appendChild(el('div', 'meta', 'URL  ' + p.baseUrl));
    if (p.model) card.appendChild(el('div', 'meta', 'model  ' + p.model + (p.smallFastModel ? '  /  ' + p.smallFastModel : '')));
    if (p.authTokenHint) card.appendChild(el('div', 'meta', 'token  ' + p.authTokenHint));
    if (p.apiKeyHint) card.appendChild(el('div', 'meta', 'key  ' + p.apiKeyHint));
    if (p.leanTools) card.appendChild(el('div', 'meta', 'lean tools  ' + p.leanTools.join(', ')));

    // Failover chain position, so the order is visible where it is configured.
    const chain = (state.settings && state.settings.failoverChain) || [];
    if (chain.includes(p.uid)) {
      const pos = el('span', 'chip default', 'failover #' + (chain.indexOf(p.uid) + 1));
      pos.title = 'A failed turn retries on the next provider in the chain (Settings → Small local models)';
      card.appendChild(pos);
    }

    const row = el('div', 'row');
    if (p.baseUrl) {
      const manage = el('button', 'btn small', '⚙ models');
      manage.title = 'Load / unload models, context size, keep-alive';
      manage.addEventListener('click', () => openOllamaManager(p));
      row.appendChild(manage);
    }
    const star = el('button', 'btn small ghost', p.uid === state.providers.defaultUid ? '★ default' : '☆ set default');
    star.addEventListener('click', async () => {
      const r = await ccx.invoke('providers:default', { uid: p.uid });
      if (r.ok) { await refreshProviders(); toast('Default provider updated', 'ok'); }
      else toast(r.error, 'err');
    });
    const edit = el('button', 'btn small', 'Edit');
    edit.addEventListener('click', () => openProviderEditor(p));
    const foBtn = el('button', 'btn small ghost', '⤺ failover');
    foBtn.title = 'Retry this turn on the next provider in your chain';
    foBtn.addEventListener('click', async () => {
      const active = [...tabRegistry.keys()].find((k) => (tabRegistry.get(k) || {}).kind === 'chat' && state.activeId === k)
        || state.activeId;
      if (!active) return toast('No chat tab open', 'err');
      const r = await ccx.invoke('provider:failover', { id: active });
      if (!r.ok) return toast(r.error || 'failover failed', 'err');
      toast('Switched to ' + (r.provider ? r.provider.name : r.to) + ' — conversation resumed', 'ok');
      await Chat.activateSession(r.newId);
    });
    const del = el('button', 'btn small danger', 'Delete');
    del.addEventListener('click', async () => {
      if (state.providers.instances.length <= 1) return toast('Keep at least one provider', 'err');
      const r = await ccx.invoke('providers:delete', { uid: p.uid });
      if (r.ok) { await refreshProviders(); toast('Provider removed', 'ok'); }
      else toast(r.error, 'err');
    });
    row.appendChild(star); row.appendChild(edit); row.appendChild(foBtn); row.appendChild(el('span', 'spacer')); row.appendChild(del);
    card.appendChild(row);
    grid.appendChild(card);
  });
}

  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function openOllamaManager(p) {    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', '', '⚙ Model manager — ' + p.name));
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
  if (state.leanPresets && state.leanPresets.length) {
    const lf = el('label', 'fld');
    lf.appendChild(el('span', '', 'Lean tools — cut the tool list for small local models (smaller base prompt)'));
    leanSel = el('select');
    const off = el('option', '', 'full tool set (default)'); off.value = ''; leanSel.appendChild(off);
    for (const pr of state.leanPresets) {
      const o = el('option', '', pr.label + ' — ' + pr.tools.join(', ')); o.value = pr.id; leanSel.appendChild(o);
    }
    leanSel.value = (instance && instance.leanTools && instance.leanTools[0])
      ? (state.leanPresets.find(p => p.tools[0] === instance.leanTools[0]) || {}).id || ''
      : '';
    lf.appendChild(leanSel);
    grid.appendChild(lf);
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
      // Per-provider lean tool allowlist, for small local models. #41
      leanToolsPreset: leanSel ? leanSel.value : (instance && instance.leanTools ? '__keep' : ''),
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
    state.providers = { presets: r.presets, instances: r.instances, defaultUid: r.defaultUid };
    if (r.leanPresets) state.leanPresets = r.leanPresets;
    if (state.view === 'providers') renderProviders();
  }
}

/* ================= connectors view ================= */

function parseMcpNames(output) {
  return [...new Set([...output.matchAll(/^([a-zA-Z0-9_.-]+):\s/m)].map(m => m[1]))];
}

async function renderConnectors() {
  const grid = $('#connector-grid');
  if (grid.childElementCount) return; // rendered once; refresh button updates list
  state.connectorPresets.forEach(preset => {
    const card = el('div', 'card');
    const head = el('h4');
    head.appendChild(el('span', '', preset.name));
    head.appendChild(el('span', 'chip ' + (preset.kind === 'stdio' ? 'kind-stdio' : 'kind-oauth'), preset.kind === 'stdio' ? 'local' : 'OAuth'));
    card.appendChild(head);
    card.appendChild(el('div', 'blurb', preset.blurb));
    if (preset.url) card.appendChild(el('div', 'meta', preset.url));

    if (preset.supportsHeader) {
      const l = el('label', 'fld');
      l.appendChild(el('span', '', 'Optional: PAT header instead of OAuth'));
      const inp = el('input');
      inp.type = 'password';
      inp.placeholder = preset.headerHint || 'Authorization: Bearer …';
      inp.dataset.connectorHeader = preset.id;
      l.appendChild(inp);
      card.appendChild(l);
    }

    const row = el('div', 'row');
    const add = el('button', 'btn small primary', 'Add connector');
    add.addEventListener('click', async () => {
      add.disabled = true; add.textContent = 'Adding…';
      const header = card.querySelector(`[data-connector-header="${preset.id}"]`);
      const r = await ccx.invoke('connectors:add', {
        presetId: preset.id,
        scope: $('#connector-scope').value,
        header: header ? header.value.trim() : '',
      });
      add.disabled = false; add.textContent = 'Add connector';
      if (r.ok && r.output) { toast(r.output.trim().split('\n')[0] || 'Added', 'ok'); refreshMcpList(); }
      else toast(r.error || r.output || 'Failed', 'err');
    });
    row.appendChild(add);
    card.appendChild(row);
    grid.appendChild(card);
  });

  // Custom connector — e.g. a second GitHub account under a different name.
  const custom = el('div', 'card');
  const chead = el('h4');
  chead.appendChild(el('span', '', 'Custom connector'));
  chead.appendChild(el('span', 'chip kind-oauth', 'OAuth / PAT'));
  custom.appendChild(chead);
  custom.appendChild(el('div', 'blurb',
    'Add any HTTP MCP server by name + URL. For a second GitHub account: name it github-work (or similar), keep the default URL, and paste that account\u2019s PAT as the header — each server name holds its own account.'));
  const mkInput = (placeholder, value, type = 'text') => {
    const i = el('input'); i.type = type; if (value) i.value = value; i.placeholder = placeholder;
    return i;
  };
  const cName = mkInput('name, e.g. github-work');
  const cUrl = mkInput('https://server.example/mcp', 'https://api.githubcopilot.com/mcp/');
  const cHeader = mkInput('Authorization: Bearer <that account\u2019s PAT>', '', 'password');
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
  const pre = $('#mcp-list');
  pre.textContent = 'running `claude mcp list` (health checks can take a moment)…';
  const r = await ccx.invoke('connectors:list');
  if (!r.ok) { pre.textContent = 'failed: ' + (r.error || ''); return; }
  pre.textContent = r.output.trim() || '(no MCP servers configured)';
  const sel = $('#mcp-remove-name');
  sel.innerHTML = '';
  const blank = el('option', '', '— server to remove —'); blank.value = '';
  sel.appendChild(blank);
  parseMcpNames(r.output).forEach(n => {
    const o = el('option', '', n); o.value = n; sel.appendChild(o);
  });
}

/* ================= settings view ================= */

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
  body.appendChild(c7);

  // local models (Ollama)
  const c8 = el('div', 'settings-card');
  c8.appendChild(el('h4', '', 'Local models (Ollama)'));
  c8.appendChild(el('div', 'hint', 'Preferred context window when pre-warming local Ollama models for new chats. The claude engine base prompt needs ≥70K tokens. Sizes that do not fit in free RAM are stepped down automatically (a too-large cache kills the model runner) — 4GB-VRAM machines usually top out near 70K. Values below 70K make local models reject claude chats.'));
  const lctxRow = el('div', 'inline');
  lctxRow.appendChild(el('span', 'hint', 'num_ctx for new chats'));
  const localCtxSel = el('select'); localCtxSel.style.width = '220px';
  [['16384', '16K'], ['32768', '32K'], ['65536', '64K'], ['131072', '128K (recommended)'], ['262144', '256K']].forEach(([v, n]) => {
    const o = el('option', '', n); o.value = v; localCtxSel.appendChild(o);
  });
  localCtxSel.value = String(s.localNumCtx || 131072);
  lctxRow.appendChild(localCtxSel);
  c8.appendChild(lctxRow);
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
      localNumCtx: Number(localCtxSel.value) || 131072,
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
    banner.appendChild(el('span', '', ' (or set the path in Settings)'));
  } else banner.classList.add('hidden');
}

/* ================= boot ================= */

function wireChrome() {
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#btn-new-session').addEventListener('click', openNewSessionModal);
  $('#btn-usage-refresh').addEventListener('click', () => renderUsage());
  $('#btn-add-provider').addEventListener('click', () => openProviderEditor(null));
  $('#btn-mcp-refresh').addEventListener('click', refreshMcpList);
  $('#btn-convo-refresh').addEventListener('click', () => loadConversationList());
  $('#btn-convo-hide').addEventListener('click', () => toggleConversations(false));
  document.querySelector('.convo-search')?.addEventListener('input', () => renderConversationList());
  document.querySelector('.convo-sort')?.addEventListener('change', () => renderConversationList());
  document.querySelector('.convo-filter')?.addEventListener('change', () => renderConversationList());
  $('#btn-split-close').addEventListener('click', () => toggleSplit(false));
  $('#split-kind')?.addEventListener('change', renderSplit);

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
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  })();
  $('#btn-mcp-remove').addEventListener('click', async () => {
    const name = $('#mcp-remove-name').value;
    if (!name) return toast('Pick a server to remove', 'err');
    const r = await ccx.invoke('connectors:remove', { name });
    if (r.ok) { toast('Removed ' + name, 'ok'); refreshMcpList(); }
    else toast(r.error || 'Failed', 'err');
  });

  // global shortcuts
  document.addEventListener('keydown', (e) => {
    // The active tab decides what copy/paste and Tab mean: a chat composer must
    // not have Ctrl+Shift+V hijacked by the PTY. #17
    const meta = tabRegistry.get(state.activeId);
    const inChat = !!(meta && meta.kind === 'chat');
    if (e.ctrlKey && e.shiftKey) {
      if (e.key === 'T') { e.preventDefault(); openNewSessionModal(); }
      else if (e.key === 'W') { e.preventDefault(); if (state.activeId) killSession(state.activeId); }
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
    if (e.ctrlKey && String(e.key).toLowerCase() === 'b') {   // conversation list #34
      e.preventDefault();
      toggleConversations();
    }
    if (e.altKey && String(e.key).toLowerCase() === 'v') {   // split view #44
      e.preventDefault();
      toggleSplit();
    }
  });

  // keep active terminal fitted
  new ResizeObserver(() => {
    const s = state.sessions.get(state.activeId);
    if (s && s.alive) { try { s.fit.fit(); } catch { /* hidden */ } }
  }).observe($('#terminals'));
}

ccx.onPtyData(({ id, data }) => {
  const s = state.sessions.get(id);
  if (s) s.term.write(data);
});
ccx.onPtyExit(({ id, exitCode }) => {
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
  state.providers = { presets: provAll.presets, instances: provAll.instances, defaultUid: provAll.defaultUid };
  state.leanPresets = (provAll.leanPresets || (settingsRes.leanPresets || []));
  state.settings = settingsRes.settings;
  applyTheme(state.settings.theme);   // #47
  state.connectorPresets = connPresets.presets;
  state.booting = false;

  $('#foot-info').textContent = (state.info.claude && state.info.claude.found)
    ? `claude ${state.info.claude.version}\nCCE v${state.info.appVersion} · Electron ${state.info.electron}`
    : `CCE v${state.info.appVersion} · Electron ${state.info.electron}`;

  renderClaudeBanner();
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
