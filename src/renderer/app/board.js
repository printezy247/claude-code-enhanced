// The Board: one screen for every live chat, what it is doing, and whether it
// needs you. Plus the background jobs and the runs that were cut short by the
// last stop. Split from app.js with the rest of the views. #feat-board
import { $, el, state, toast } from './core.js';
import { Chat } from '../chat/index.js';
import { switchView } from './tabs.js';
import { holdText, summary } from '../chat/queue.js';
import { setQueuePaused } from '../chat/qpanel.js';
import { chatTitle } from '../chat/mentions-live.js';
import { t, tf } from '../i18n.js';

function rowCard(r) {
  const card = el('div', 'card');
  const head = el('h4');
  head.appendChild(el('span', '', r.cwd || r.id));
  const chip = r.needsYou > 0 ? ['chip mcp-warn', 'needs you']
    : r.busy ? ['chip mcp-ok', 'working'] : ['chip mcp-off', 'idle'];
  head.appendChild(el('span', chip[0], chip[1]));
  card.appendChild(head);
  const meta = el('div', 'meta');
  meta.textContent = [r.model, r.sessionId ? 'session ' + r.sessionId : ''].filter(Boolean).join(' · ');
  card.appendChild(meta);
  // Open this chat as a tab in the Conversations view.
  const open = el('button', 'btn small', 'Open');
  open.addEventListener('click', async () => {
    // Create a tab for the live chat (resume by session when we know it).
    try {
      await Chat.createSession({ cwd: r.cwd, resume: r.sessionId || undefined, providerUid: state.providers && state.providers.defaultUid });
      switchView('conversations');
    } catch (e) { toast(String(e && e.message || e), 'err'); }
  });
  card.appendChild(open);
  return card;
}

function jobRow(j) {
  const row = el('div', 'mcp-row');
  row.appendChild(el('span', 'chip ' + (j.state === 'done' ? 'mcp-ok' : j.state === 'failed' ? 'mcp-err' : j.state === 'running' ? 'mcp-warn' : 'mcp-off'), j.state));
  row.appendChild(el('b', '', j.label));
  if (j.error) row.appendChild(el('span', 'meta mcp-why', j.error));
  if (j.state === 'queued' || j.state === 'running') {
    const cancel = el('button', 'btn small danger', 'Cancel');
    cancel.addEventListener('click', async () => {
      const r = await ccx.invoke('jobs:cancel', { id: j.id });
      if (r.ok) toast(r.canceled ? 'Cancelled' : 'Job already finished', r.canceled ? 'ok' : '');
      renderBoard();
    });
    row.appendChild(cancel);
  }
  return row;
}

function runRow(run) {
  const row = el('div', 'mcp-row');
  row.appendChild(el('span', 'chip mcp-warn', 'interrupted'));
  row.appendChild(el('b', '', run.cwd || run.id));
  row.appendChild(el('span', 'meta', run.model || ''));
  if (run.engine && !run.sessionId) row.appendChild(el('span', 'meta', 'no session id saved: starts fresh'));
  // Resume the cut-short run: same folder, same session.
  const resume = el('button', 'btn small primary', 'Resume');
  resume.addEventListener('click', async () => {
    resume.disabled = true;
    try {
      if (run.engine) {
        // An engine chat starts the same CLI again on the same thread and provider.
        await Chat.createSession({
          cwd: run.cwd, engine: run.engine, resume: run.sessionId || undefined, yolo: !!run.yolo,
          ...(run.providerUid ? { providerUid: run.providerUid, model: run.model || undefined } : {}),
        });
      } else {
        await Chat.createSession({ cwd: run.cwd, resume: run.sessionId || undefined, providerUid: state.providers && state.providers.defaultUid });
      }
      await ccx.invoke('runs:ack', { id: run.id });
      switchView('conversations');
    } catch (e) { toast(String(e && e.message || e), 'err'); resume.disabled = false; }
  });
  row.appendChild(resume);
  // Not interested: just forget it.
  const ack = el('button', 'btn small ghost', 'Dismiss');
  ack.addEventListener('click', async () => { await ccx.invoke('runs:ack', { id: run.id }); renderBoard(); });
  row.appendChild(ack);
  return row;
}

// Engine tabs (item 11): Codex / Antigravity / OpenCode as chats or terminal tabs. Only
// engines found on PATH get a button; a missing one shows its install hint.
function engineRow(e) {
  const row = el('div', 'mcp-row');
  row.appendChild(el('span', 'chip ' + (e.found ? 'mcp-ok' : 'mcp-off'), e.found ? 'installed' : 'missing'));
  row.appendChild(el('b', '', e.label));
  if (e.found && e.version) row.appendChild(el('span', 'meta', e.version));
  if (e.found) {
    // The same CLI in the chat view, run headless one message at a time. #feat-engine-chat
    const chatBtn = el('button', 'btn small', 'Open chat');
    chatBtn.addEventListener('click', async () => {
      chatBtn.disabled = true;
      try { await Chat.createSession({ cwd: state.settings && state.settings.defaultCwd, engine: e.id }); }
      catch (err) { toast(String(err && err.message || err), 'err'); }
      chatBtn.disabled = false;
    });
    row.appendChild(chatBtn);
    const open = el('button', 'btn small', 'Open tab');
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        await window.createSession({ cwd: state.settings && state.settings.defaultCwd, type: e.id });
      } catch (err) { toast(String(err && err.message || err), 'err'); open.disabled = false; }
    });
    row.appendChild(open);
  } else {
    row.appendChild(el('span', 'meta', e.hint || ''));
  }
  return row;
}

/** Chats that have messages waiting, with what holds them. */
function queuedChats() {
  return [...Chat.chats.values()].filter((c) => c && c.alive && (c.pendingMsgs || []).length);
}

function queueCard(chat) {
  const card = el('div', 'card board-queue');
  const head = el('h4');
  head.appendChild(el('span', '', chatTitle(chat)));
  const hold = chat.queuePaused ? 'paused' : chat.queueHeld;
  head.appendChild(el('span', 'chip ' + (hold ? 'mcp-warn' : chat.busy ? 'mcp-ok' : 'mcp-off'), hold ? holdText(hold) : (chat.busy ? t('board.queues.running') : t('board.queues.idle'))));
  card.appendChild(head);
  card.appendChild(el('div', 'meta', (chat.cwd || '') + ' · ' + tf('queue.title', { n: chat.pendingMsgs.length })));
  const list = el('ol', 'board-queue-list');
  chat.pendingMsgs.slice(0, 3).forEach((it) => {
    const li = el('li', '', (it.label ? it.label + ': ' : '') + (it.text || '(image)').slice(0, 90));
    for (const bit of summary(it)) li.appendChild(el('span', 'q-chip', bit));
    list.appendChild(li);
  });
  card.appendChild(list);
  if (chat.pendingMsgs.length > 3) card.appendChild(el('div', 'meta', tf('board.queues.more', { n: chat.pendingMsgs.length - 3 })));
  const pause = el('button', 'btn small', chat.queuePaused ? t('queue.resume') : t('queue.pause'));
  pause.addEventListener('click', () => setQueuePaused(chat, !chat.queuePaused));
  const jump = el('button', 'btn small', t('board.queues.jump'));
  jump.addEventListener('click', () => { switchView('conversations'); if (window.__activate) window.__activate(chat.id); });
  card.appendChild(pause);
  card.appendChild(jump);
  return card;
}

/** The Queues section: every open chat's waiting messages, pausable from one place. */
export function renderBoardQueues() {
  const wrap = $('#board-queues-wrap');
  const box = $('#board-queues');
  if (!wrap || !box) return;
  const list = queuedChats();
  wrap.classList.toggle('hidden', !list.length);
  box.textContent = '';
  const title = $('#board-queues-title');
  if (title) title.textContent = t('board.queues');
  const all = $('#btn-queues-pause'); const res = $('#btn-queues-resume');
  if (all) all.textContent = t('board.queues.pauseAll');
  if (res) res.textContent = t('board.queues.resumeAll');
  if (!list.length) return;
  box.appendChild(el('div', 'meta', t('board.queues.intro')));
  list.forEach((c) => box.appendChild(queueCard(c)));
}
window.__renderBoardQueues = renderBoardQueues;

function setAllQueues(paused) {
  for (const c of queuedChats()) setQueuePaused(c, paused);
}

export async function renderBoard() {
  const [board, jobs, runs, engineList] = await Promise.all([
    ccx.invoke('chats:board'),
    ccx.invoke('jobs:list'),
    ccx.invoke('runs:interrupted'),
    ccx.invoke('engines:list'),
  ]);
  const chatsBox = $('#board-chats');
  const jobsBox = $('#board-jobs');
  const runsBox = $('#board-runs');
  const enginesBox = $('#board-engines');
  if (!chatsBox) return;

  if (enginesBox) {
    enginesBox.textContent = '';
    const list = (engineList && engineList.ok && engineList.engines) || [];
    list.forEach((e) => enginesBox.appendChild(engineRow(e)));
  }

  renderBoardQueues();
  chatsBox.textContent = '';
  const rows = (board && board.ok && board.rows) || [];
  if (!rows.length) chatsBox.appendChild(el('div', 'meta', 'No live chats yet — start one from Conversations.'));
  // Needs-you first, then working, then idle.
  rows.sort((a, b) => (b.needsYou > 0) - (a.needsYou > 0) || (b.busy) - (a.busy));
  rows.forEach(r => chatsBox.appendChild(rowCard(r)));

  jobsBox.textContent = '';
  const jobList = (jobs && jobs.ok && jobs.jobs) || [];
  if (!jobList.length) jobsBox.appendChild(el('div', 'meta', 'No background jobs.'));
  jobList.forEach(j => jobsBox.appendChild(jobRow(j)));

  runsBox.textContent = '';
  const runList = (runs && runs.ok && runs.runs) || [];
  runsBox.parentElement.classList.toggle('hidden', !runList.length);
  if (runList.length) {
    runsBox.appendChild(el('div', 'meta', 'These runs were going when CCE last stopped. Resume picks up the same conversation.'));
    runList.forEach(r => runsBox.appendChild(runRow(r)));
  }
}

document.addEventListener('click', (e) => {
  const id = e.target && e.target.id;
  if (id === 'btn-queues-pause') setAllQueues(true);
  else if (id === 'btn-queues-resume') setAllQueues(false);
});
