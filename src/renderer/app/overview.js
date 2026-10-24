// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { convoSessions, renderConversationList } from './conversations.js';
import { FitCtor, TERM_THEME, TermCtor, el, elIcon, fmtTokShort, lsGet, lsSet, state } from './core.js';
import { tabRegistry, updateStatusbar } from './tabs.js';
import { Chat } from '../chat/index.js';

/* ================= split view (#44) ================= */

export let splitTerm = null;

let splitSession = null;

  // { id } — the PTY behind the right-rail terminal
let tasksTimer = null;

   // auto-refresh while the tasks panel is visible

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

export function toggleSplit(force) {
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
export function renderOverview() {
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
    }, 60000);   // safety net only: the chat tells the Overview when something changed
  }
}

window.renderOverview = renderOverview;

// Event-driven refresh: the chat calls this when a turn ends, a session starts, the
// model changes or a file-changing tool finishes. Coalesced, and deferred while hidden.
let ovTimer = null, ovDirty = false;

window.refreshOverview = (chatId, delay = 500) => {
  if (chatId && chatId !== state.activeId) return;
  clearTimeout(ovTimer);
  ovTimer = setTimeout(() => { if (document.hidden) ovDirty = true; else renderOverview(); }, delay);
};

document.addEventListener('visibilitychange', () => { if (!document.hidden && ovDirty) { ovDirty = false; renderOverview(); } });

export function renderSplit() {
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
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
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

export function initSplitTabMenu() {
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

/** Which Overview cards are folded away. Connectors start folded: it is the longest card. */
function ovClosedMap() {
  const v = lsGet('cce.ovClosed', null);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : { connectors: true };
}

/** Fold or unfold every Overview card at once. */
export function setAllOverviewCards(closed) {
  const m = ovClosedMap();
  document.querySelectorAll('#overview-body .task-card').forEach((c) => {
    c.classList.toggle('closed', closed);
    const h = c.querySelector('.task-card-head');
    if (h) h.setAttribute('aria-expanded', closed ? 'false' : 'true');
    m[c.dataset.card] = closed;
  });
  for (const k of ['environment', 'context', 'connectors', 'changes', 'tasks', 'background']) m[k] = closed;
  lsSet('cce.ovClosed', m);
  const body = document.querySelector('#overview-body');
  if (body) body.__taskHtml = null;
}

/** Show or hide the whole Overview column (remembered). */
export function toggleOverview(force) {
  const hide = force !== undefined ? !force : !document.body.classList.contains('ov-hidden');
  document.body.classList.toggle('ov-hidden', hide);
  document.querySelector('#btn-overview')?.setAttribute('aria-pressed', hide ? 'false' : 'true');
  lsSet('cce.ovHidden', hide);
}

window.toggleOverview = toggleOverview;

function renderTasks(target, cwd, only) {
  const chat = Chat.chats.get(state.activeId);
  // Build off-screen and swap once every async card has filled in: clearing
  // the live panel and refilling it piecemeal made it blink on each refresh.
  const body = document.createElement('div');
  const pending = [];
  // A single-card update must not cancel a full render that is still in flight.
  const seq = only ? -1 : (target.__taskSeq = (target.__taskSeq || 0) + 1);
  // Overview cards float on the right; each header folds its card away (and the
  // choice is remembered). The badge on the right summarises a folded card.
  const closedMap = ovClosedMap();
  const card = (key, title, icon) => {
    const c = el('section', 'task-card');
    c.dataset.card = key;
    const closed = closedMap[key] === true;
    if (closed) c.classList.add('closed');
    const head = el('button', 'task-card-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', closed ? 'false' : 'true');
    head.title = 'Show or hide the details of this card';
    head.appendChild(elIcon('span', 'tc-ico', CCEIcons.svg(icon, 12)));
    const h = el('h4', '', title);
    head.appendChild(h);
    const badge = el('span', 'tc-badge', '');
    head.appendChild(badge);
    head.appendChild(elIcon('span', 'tc-caret', CCEIcons.svg('chevron', 12)));
    head.addEventListener('click', () => {
      const now = c.classList.toggle('closed');
      head.setAttribute('aria-expanded', now ? 'false' : 'true');
      const m = ovClosedMap();
      m[key] = now;
      lsSet('cce.ovClosed', m);
      target.__taskHtml = null;   // the next refresh compares afresh
    });
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
      // Click to mark a step done (or undo it); the model's next TodoWrite overwrites it.
      row.tabIndex = 0;
      row.setAttribute('role', 'checkbox');
      row.setAttribute('aria-checked', st === 'done' ? 'true' : 'false');
      row.title = st === 'done' ? 'Mark as not done' : 'Mark as done';
      const flip = () => {
        t.status = t.status === 'completed' ? 'pending' : 'completed';
        renderTasks(target, cwd, 'tasks');
      };
      row.addEventListener('click', flip);
      row.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
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
    if (r.usage && r.usage.cache_read_input_tokens) bits.push('⚡ ' + fmtTokShort(r.usage.cache_read_input_tokens).replace(/\.0(?=[kMB]$)/, '') + ' cached');
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
        extra.forEach((r) => r.classList.add('ctx-extra'));
        const more = el('button', 'btn tiny ctx-more');
        more.type = 'button';
        more.dataset.n = String(extra.length);   // label comes from CSS, state from #overview-body.ctx-open
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
      // Notes are one-line summaries that open on demand: the full text used to
      // fill the whole card.
      const note = (summary, text) => {
        const d = document.createElement('details');
        d.className = 'conn-note';
        const sm = document.createElement('summary');
        sm.textContent = summary;
        d.appendChild(sm);
        d.appendChild(el('div', 'hint', text));
        connRows.appendChild(d);
      };
      if (connected.length >= 5) {
        note(connected.length + ' connectors live', 'Each connector adds MCP preamble to every turn. Disconnect unused ones in Providers.');
      }
      // Warn about tool-name collisions across connectors (#wrong-tool-calls).
      const names = [];
      for (const s of connected) for (const t of (s.tools || [])) names.push(t.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      if (dupes.length) {
        const uniq = [...new Set(dupes)];
        note('⚠ ' + uniq.length + ' duplicate tool name' + (uniq.length === 1 ? '' : 's'),
          'Duplicate tool names across connectors: ' + uniq.join(', ') + '. Prefer the server matching the task.');
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
    // A button is mid-press: swapping now would eat the click. Try again shortly.
    if (target.querySelector('button:active')) { setTimeout(swap, 150); return; }
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
  if (document.querySelector('#convo-drop') && convoSessions.length) renderConversationList();
};

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
