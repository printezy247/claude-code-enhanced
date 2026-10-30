// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { basenameOf, el, elIcon, lsGet, lsSet, paintDeclaredIcons, state, toast } from './core.js';
import { activateSession, switchView, tabRegistry, toggleSidebar } from './tabs.js';
import { Chat } from '../chat/index.js';
import { dateCutoff, deepMatches } from './convosearch.js';
import { openFolder } from './home.js';
import { markManualTitle } from '../chat/titles.js';

/* ================= conversation list (#34) ================= */
/*
 * One list for everything: open chat/terminal tabs and every stored session.
 * Grouped by the folder the conversation ran in, with time buckets inside
 * each group. Clicking a row resumes that session live.
 */

export let convoSessions = [];

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
 * Search the stored transcripts for text the list previews do not show, and
 * list the conversations that mention it under the normal rows. The main
 * process does the scan on a worker thread; typing is debounced so a big
 * history is not rescanned on every key.
 */
let convoSearchTimer = null;
function searchTranscripts(query, foot, root) {
  clearTimeout(convoSearchTimer);
  const token = ++convoSearchToken;
  convoSearchTimer = setTimeout(async () => {
    try {
      const res = await ccx.invoke('chats:search', { query, limit: 400 });
      // A newer search started, or the list was re-rendered: drop this answer.
      if (token !== convoSearchToken || !root.isConnected) return;
      const since = dateCutoff((document.querySelector('#convo-drop .convo-date') || {}).value, Date.now());
      const folder = (document.querySelector('#convo-drop .convo-filter') || {}).value || '';
      const shown = new Set([...root.querySelectorAll('[data-sid]')].map((n) => n.dataset.sid));
      const hits = deepMatches(res && res.matches, convoSessions, query, (s) =>
        !shown.has(s.sessionId) && (!since || s.mtime >= since)
        && (!folder || String(s.cwd || s.folder || '~') === folder));
      if (!hits.length) return;
      const sec = el('div', 'convo-group convo-deep');
      const head = el('div', 'convo-sec');
      head.appendChild(el('span', 'cs-name', 'Mentioned inside'));
      head.appendChild(el('span', 'cs-count', String(hits.length)));
      sec.appendChild(head);
      const rows = el('div', 'convo-rows');
      for (const h of hits.slice(0, 30)) {
        const row = convoRow(h.session, String(h.session.cwd || h.session.folder || '~'));
        row.querySelector('.convo-main').appendChild(el('div', 'convo-meta convo-snip', h.snippet + ' (' + h.count + ')'));
        rows.appendChild(row);
      }
      sec.appendChild(rows);
      root.appendChild(sec);
    } catch { /* the list stays as it is */ }
  }, 300);
}

export function renderConversationList() {  // Async data can land after the window is gone; bail out instead of throwing.
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
    // Open conversations are listed above, under Open: no second copy here.
    if (view === 'all' && !q && openIds.has(s.sessionId)) return false;
    return !q || String(s.preview || '').toLowerCase().includes(q)
      || String(s.cwd || s.folder || '').toLowerCase().includes(q)
      || String(s.branch || '').toLowerCase().includes(q);
  });
  if (folder) items = items.filter((s) => String(s.cwd || s.folder || '~') === folder);
  const since = dateCutoff((document.querySelector('#convo-drop .convo-date') || {}).value, Date.now());
  if (since) items = items.filter((s) => s.mtime >= since);
  paintConvoTabs(pinned, openIds);

  // Sort first, then bucket: the bucket pass preserves this order inside groups.
  if (sort === 'new') items.sort((a, b) => b.mtime - a.mtime);
  else if (sort === 'old') items.sort((a, b) => a.mtime - b.mtime);
  else items.sort((a, b) => String(a.preview || '').localeCompare(String(b.preview || '')));

  root.innerHTML = '';
  if (q && q.length >= 3) searchTranscripts(q, foot, root);
  else { clearTimeout(convoSearchTimer); convoSearchToken++; }
  // Every stored conversation is already open in the list above: showing
  // "No conversations yet" under it (with a "0 of 3" counter) read as a bug.
  const allOpen = convoSessions.length > 0 && !q && !folder
    && view === 'all' && convoSessions.every((s) => openIds.has(s.sessionId));
  if (foot) {
    foot.textContent = items.length === convoSessions.length || allOpen
      ? convoSessions.length + ' conversation' + (convoSessions.length === 1 ? '' : 's')
        + (allOpen && items.length !== convoSessions.length ? ' — all open above' : '')
      : items.length + ' of ' + convoSessions.length + ' conversations';
  }
  if (!items.length) {
    const empty = { pinned: 'Nothing pinned — use ▾ → Pin on a conversation you come back to.',
      open: 'No open conversations.', archived: 'Nothing archived.' }[view];
    if (!q && !folder && !allOpen && !empty && !convoSessions.length) {
      // First run, nothing stored yet: say how to start instead of a bare line.
      const box = el('div', 'convo-empty convo-empty-illus');
      box.appendChild(elIcon('div', 'convo-empty-icon', CCEIcons.svg('folder', 28)));
      box.appendChild(el('div', 'convo-empty-title', 'No conversations yet'));
      box.appendChild(el('div', 'hint', 'Open a folder to start one. Past chats appear here.'));
      const open = el('button', 'btn small', 'Open folder…');
      open.type = 'button';
      open.addEventListener('click', () => openFolder());
      box.appendChild(open);
      root.appendChild(box);
      return;
    }
    root.appendChild(el('div', 'convo-empty hint', q || folder ? 'Nothing matches.'
      : (allOpen ? 'Every conversation is open in the list above.' : (empty || 'No conversations yet.'))));
    // The list only knows the previews. When a search finds nothing there,
    // the stored transcripts are searched too — on a worker thread in the
    // main process, so a big history does not freeze the window. #t0-workers
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
    // Rows are built when the folder is open, and only once: a collapsed
    // folder in a long list costs nothing until it is expanded.
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      let bi = 0;
      while (bi < CONVO_BUCKETS.length) {
        const [label, within] = CONVO_BUCKETS[bi];
        const prev = bi === 0 ? 0 : CONVO_BUCKETS[bi - 1][1];
        const inBucket = rows.filter((s) => now - s.mtime <= within && now - s.mtime > prev);
        if (inBucket.length) {
          listEl.appendChild(el('div', 'convo-bucket', label));
          for (const s of inBucket) listEl.appendChild(convoRow(s, cwd));
        }
        bi++;
      }
    };
    head.addEventListener('click', () => {
      const set = collapsedFolders();
      const nowCollapsed = !set.has(cwd);
      if (nowCollapsed) set.add(cwd); else set.delete(cwd);
      lsSet('cce.convoCollapsed', [...set]);
      if (!nowCollapsed) build();
      listEl.classList.toggle('hidden', nowCollapsed);
      sec.classList.toggle('collapsed', nowCollapsed);
      head.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
    });
    sec.appendChild(listEl);
    if (!isCollapsed) build();
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
  row.dataset.sid = s.sessionId;
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
  add('Open in new window', 'its own window', async () => {
    // Open here → /detach in that chat instead (it must close first); otherwise just hand it over.
    if (focusIfOpen(s.sessionId)) { toast('This conversation is open here. Use /detach in that chat to move it.', ''); return; }
    const r = await ccx.invoke('window:detach', { sessionId: s.sessionId, cwd });
    if (!r || !r.ok) toast((r && r.error) || 'Could not open a new window', 'err');
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
    for (const c of Chat.chats.values()) if (c.sessionId === s.sessionId) markManualTitle(c, title);
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
    Chat.createSession({ cwd, cliDefault: true });
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

export async function loadConversationList() {
  const r = await ccx.invoke('chats:index');
  if (r.ok) convoSessions = r.sessions || [];
  refreshConvoFolderFilter();
  renderConversationList();
}

let convoRenderTimer = null;
let convoDiskTimer = null;
/**
 * Keep the sidebar honest while the session runs. `fromDisk` asks for a reload
 * of the stored transcripts (a chat was opened or a turn finished); without it
 * the list kept its boot-time contents and said "No conversations yet" until
 * the user pressed Reload.
 */
export function scheduleConvoRefresh(fromDisk = false) {
  if (!convoRenderTimer) {
    convoRenderTimer = setTimeout(() => { convoRenderTimer = null; renderConversationList(); }, 400);
  }
  if (!fromDisk || convoDiskTimer) return;
  convoDiskTimer = setTimeout(() => { convoDiskTimer = null; loadConversationList().catch(() => {}); }, 1500);
}

// Reaching it from the chat modules without importing them (they import this
// file): the codebase already crosses module boundaries through window.
window.scheduleConvoRefresh = scheduleConvoRefresh;

/**
 * The conversation list lives in the left sidebar for good, so there is nothing
 * to open or close. This (Ctrl+B) reveals the sidebar, reloads the list from
 * disk and puts the cursor in the search box.
 */
export function toggleConversations(force) {
  const drop = ensureConvoDrop();
  if (force === false) return;
  toggleSidebar(false);
  loadConversationList();
  drop.querySelector('.convo-search')?.focus();
}

window.toggleConversations = toggleConversations;

/** Build the sidebar's conversation list once; all list markup lives here, not in index.html. */
export function ensureConvoDrop() {
  let drop = document.querySelector('#convo-drop');
  if (drop) return drop;
  drop = el('div', '');
  drop.id = 'convo-drop';
  drop.innerHTML = `
    <div class="convo-head">
      <input class="convo-search" type="text" placeholder="Search conversations…" aria-label="Search conversations" />
      <button class="icon-btn" id="btn-convo-filters" title="Group, sort and filter" aria-label="Group, sort and filter" aria-expanded="false"><span data-icon="list"></span></button>
      <button class="icon-btn" id="btn-convo-refresh" title="Reload from disk" aria-label="Reload"><span data-icon="refresh"></span></button>
    </div>
    <div class="convo-filters hidden">
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
      <select class="convo-date" title="Filter by date" aria-label="Filter by date">
        <option value="">any time</option>
        <option value="day">last 24 hours</option>
        <option value="week">last 7 days</option>
        <option value="month">last 30 days</option>
      </select>
    </div>
    <div class="convo-tabs" role="tablist" aria-label="Conversation categories">
      <button class="convo-tab active" role="tab" data-view="all">All <span class="ct-n">0</span></button>
      <button class="convo-tab" role="tab" data-view="open">Open <span class="ct-n">0</span></button>
      <button class="convo-tab" role="tab" data-view="pinned">Pinned <span class="ct-n">0</span></button>
      <button class="convo-tab" role="tab" data-view="archived">Archived <span class="ct-n">0</span></button>
    </div>
    <div class="convo-list" id="convo-list"></div>
    <div class="convo-foot">
      <span id="convo-foot"></span>
      <label class="convo-archived-wrap" title="Also list archived conversations under All">
        <input class="convo-archived" type="checkbox" /> archived
      </label>
    </div>`;
  document.querySelector('#sb-convos').appendChild(drop);
  paintDeclaredIcons(drop);
  drop.querySelector('#btn-convo-refresh').addEventListener('click', () => loadConversationList());
  const filtersBtn = drop.querySelector('#btn-convo-filters');
  filtersBtn.addEventListener('click', () => {
    const box = drop.querySelector('.convo-filters');
    const open = box.classList.toggle('hidden') === false;
    filtersBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  for (const t of drop.querySelectorAll('.convo-tab')) {
    t.addEventListener('click', () => { convoView = t.dataset.view; renderConversationList(); });
  }
  drop.querySelector('.convo-groupby').value = lsGet('cce.convoGroupBy', 'folder');
  drop.querySelector('.convo-groupby').addEventListener('change', (e) => { lsSet('cce.convoGroupBy', e.target.value); renderConversationList(); });
  drop.querySelector('.convo-search').addEventListener('input', () => renderConversationList());
  drop.querySelector('.convo-sort').addEventListener('change', () => renderConversationList());
  drop.querySelector('.convo-filter').addEventListener('change', () => renderConversationList());
  drop.querySelector('.convo-date').addEventListener('change', () => renderConversationList());
  drop.querySelector('.convo-archived').addEventListener('change', () => renderConversationList());
  return drop;
}

/* ---- open chats and terminals: what the tab bar used to show ---- */
let openTabsTimer = null;

/** Repaint the sidebar's Open list (coalesced: a busy chat flips state often). */
export function renderOpenTabs() {
  if (openTabsTimer) return;
  openTabsTimer = setTimeout(() => { openTabsTimer = null; paintOpenTabs(); }, 0);
}

window.onTabsChanged = renderOpenTabs;

function paintOpenTabs() {
  const box = document.querySelector('#sb-open');
  if (!box) return;
  // Open tabs changed, so the All/Open counters next to them are stale too.
  scheduleConvoRefresh(false);
  const entries = [...tabRegistry.entries()].filter(([, m]) => m.tabEl);
  box.innerHTML = '';
  box.classList.toggle('hidden', !entries.length);
  if (!entries.length) return;
  box.appendChild(el('div', 'sb-open-head', 'Open'));
  for (const [id, meta] of entries) {
    const chat = meta.kind === 'chat' ? Chat.chats.get(id) : null;
    const row = el('div', 'sb-open-row' + (id === state.activeId ? ' active' : '')
      + (meta.tabEl.classList.contains('dead') ? ' dead' : ''));
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    const label = String((meta.tabEl.firstChild && meta.tabEl.firstChild.textContent) || '').replace(/^⌘\s*/, '') || 'session';
    const state0 = meta.needsYou ? 'attn' : (meta.busy || (chat && chat.busy)) ? 'busy' : 'idle';
    const dot = el('span', 'sb-dot ' + state0);
    dot.title = state0 === 'attn' ? 'waiting on you' : state0 === 'busy' ? 'working' : 'idle';
    row.appendChild(dot);
    if (meta.kind !== 'chat') row.appendChild(elIcon('span', 'sb-kind', CCEIcons.svg('terminal', 12)));
    const txt = el('span', 'sb-open-label', label);
    txt.title = label + (meta.cwd ? '\n' + meta.cwd : '');
    row.appendChild(txt);
    const x = elIcon('button', 'sb-open-close', CCEIcons.svg('close', 12));
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close ' + label);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const close = meta.tabEl.querySelector('.close');
      if (close) close.click();
    });
    row.appendChild(x);
    const open = () => { meta.tabEl.click(); switchView('conversations'); };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    box.appendChild(row);
  }
}

window.paintOpenTabs = paintOpenTabs;
