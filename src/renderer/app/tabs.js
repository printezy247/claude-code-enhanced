// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { connectorCheckedAt, connectorChecking, refreshMcpList, renderConnectors } from './connectors.js';
import { renderOpenTabs } from './conversations.js';
import { $, FitCtor, LinksCtor, TERM_THEME, TermCtor, el, elIcon, state, toast } from './core.js';
import { renderOverview, renderSplit } from './overview.js';
import { renderProviders } from './provider-forms.js';
import { renderSettings } from './settings.js';
import { renderUsage } from './usage.js';
import { Chat } from '../chat/index.js';

/* ================= view switching ================= */

export function switchView(view) {
  // 'terminal' is the old name for the Conversations workspace; keep it working
  // for any caller that has not been updated.
  if (view === 'terminal') view = 'conversations';
  state.view = view;
  document.body.dataset.view = view;
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

export function toggleSidebar(force) {
  sidebarHidden = force !== undefined ? force : !sidebarHidden;
  document.body.classList.toggle('sb-hidden', sidebarHidden);
  try { localStorage.setItem('cce.sidebarHidden', sidebarHidden ? '1' : '0'); } catch { /* private mode */ }
}

/* ================= tabs & terminals ================= */

// Unified tab registry so chat tabs (Agent SDK) and terminal tabs (PTY) coexist.
export const tabRegistry = new Map();

 // id -> { kind: 'pty'|'chat', pane, tabEl, focus }
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
  renderOpenTabs();
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

function fitSize(s) {
  try { s.fit.fit(); } catch { /* hidden */ }
  return { cols: s.term.cols, rows: s.term.rows };
}

export function activateSession(id) {
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

export async function createSession(opts) {
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

export async function killSession(id) {
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
export const recentlyClosedCount = () => recentlyClosed.length;

/** Remember a closed tab so "↶ Closed tab" can bring it back. */
function pushRecentlyClosed(entry) {
  if (!entry || !entry.kind) return;
  recentlyClosed = recentlyClosed.filter((e) => e.kind + ':' + e.cwd !== entry.kind + ':' + entry.cwd);
  recentlyClosed.push(entry);
  if (recentlyClosed.length > RECENT_MAX) recentlyClosed.shift();
  paintReopenButton();
}

export function paintReopenButton() {
  const b = document.querySelector('#qa-reopen');
  if (!b) return;
  const last = recentlyClosed[recentlyClosed.length - 1];
  b.disabled = !last;
  b.title = last
    ? 'Reopen ' + (last.kind === 'pty' ? 'terminal' : 'chat') + ' in ' + (last.cwd || '~')
    : 'Reopen the last closed tab';
}

export async function reopenLastClosed() {
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
export async function resumeLatest() {
  const btn = document.querySelector('#qa-resume');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
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
    if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}

const tabRegistryHas = (sessionId) => [...tabRegistry.values()].some((m) => m.sessionId === sessionId);

/**
 * The sidebar badge stops being a plain count: it says whether any tab is
 * waiting on you (a permission prompt), working, or just open. That is the
 * distinction users of the newer agent desktops rely on to know where to look.
 */
function updateSessionCount() {
  renderOpenTabs();
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

export function updateStatusbar(sess) {
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
