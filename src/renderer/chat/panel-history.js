// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { closeChat, createSession } from './session.js';
import { scrollDownSoft } from './transcript.js';
import { basename, el, fmtAge } from './util.js';
import { makePanel, panelOpen } from './panels.js';

/* ---------------- rewind (file checkpoints) ---------------- */

export async function toggleRewindPanel(chat) {
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

/* ---------------- history panel (per-folder, inside a chat) ---------------- */
// The flat, all-projects conversation list now lives in app.js next to the
// workspace; this panel stays for the per-folder variant.


export async function toggleHistoryPanel(chat) {
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
