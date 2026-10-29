// The queue panel above the composer: edit, reorder, pause, per-item actions.
// The data rules live in queue.js; this file draws them and saves them.
import { elIcon, toast } from '../app/core.js';
import { autosize, renderImageChips } from './composer.js';
import { HOLD_TEXT, DEFAULT_RULES, deserialize, duplicate, edit, imageKey, makeItem, move, nextAction, remove, runNext, serialize, setOverrides, summary } from './queue.js';
import { el } from './util.js';

const pendKey = (chat) => 'cce:pending:' + (chat.cwd || '');
const RULES_KEY = 'cce.queueRules';

export function queueRules() {
  try { return { ...DEFAULT_RULES, ...JSON.parse(localStorage.getItem(RULES_KEY) || '{}') }; } catch { return { ...DEFAULT_RULES }; }
}
export function saveQueueRules(rules) {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); } catch { /* not kept */ }
}

/** Every change to the list goes through here: store, redraw, save. */
export function setQueue(chat, list) {
  chat.pendingMsgs = list;
  persistPending(chat);
  renderQueued(chat);
  if (window.refreshOverview) window.refreshOverview(chat.id, 300);
}

/**
 * Remember the queue across a crash. Text goes to localStorage. Images go to
 * the main process as 0600 files (one per item), never to localStorage.
 */
export function persistPending(chat) {
  const list = chat.pendingMsgs || [];
  try { localStorage.setItem(pendKey(chat), JSON.stringify(serialize(list))); } catch { /* quota: not remembered */ }
  const saved = chat.queueImgSaved || (chat.queueImgSaved = new Set());
  const now = new Set();
  for (const it of list) {
    if (!it.blocks || !it.blocks.length) continue;
    now.add(it.id);
    if (saved.has(it.id)) continue;
    saved.add(it.id);
    const images = it.blocks.filter((b) => b && b.source && b.source.data).map((b) => ({ media_type: b.source.media_type, data: b.source.data }));
    ccx.invoke('draft:images', { op: 'save', key: imageKey(chat.cwd, it.id), images }).catch(() => {});
  }
  for (const id of [...saved]) {
    if (now.has(id)) continue;
    saved.delete(id);
    ccx.invoke('draft:images', { op: 'save', key: imageKey(chat.cwd, id), images: [] }).catch(() => {});
  }
}

/** Put the saved queue back, images included. */
export async function restoreQueue(chat) {
  let items;
  try { items = deserialize(localStorage.getItem(pendKey(chat)) || '[]'); } catch { return; }
  if (!items.length) return;
  for (const it of items) {
    if (!it.imgCount) continue;
    try {
      const r = await ccx.invoke('draft:images', { op: 'load', key: imageKey(chat.cwd, it.id) });
      const imgs = (r && r.images) || [];
      if (imgs.length) it.blocks = imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }));
    } catch { /* the text still comes back */ }
    delete it.imgCount;
  }
  if (!chat.alive) return;
  chat.queueImgSaved = new Set(items.filter((i) => i.blocks).map((i) => i.id));
  chat.pendingMsgs = items.concat(chat.pendingMsgs || []);
  renderQueued(chat);
}

/** Take an item back into the composer (text and images). */
function toComposer(chat, i) {
  const it = chat.pendingMsgs[i];
  if (!it) return;
  const cur = chat.composer.value;
  chat.composer.value = cur ? cur + '\n' + it.text : it.text;
  if (it.blocks) {
    for (const b of it.blocks) {
      if (b && b.source && b.source.data) chat.pendingImages.push({ media_type: b.source.media_type, data: b.source.data });
    }
    renderImageChips(chat);
  }
  autosize(chat.composer);
  chat.composer.focus();
  setQueue(chat, remove(chat.pendingMsgs, i));
}

function steerNow(chat, i) {
  const it = chat.pendingMsgs[i];
  if (!it) return;
  setQueue(chat, remove(chat.pendingMsgs, i));
  chat.msgs.appendChild(el('div', 'sys-note', '↯ steered from the queue — Claude will read this after its current step'));
  ccx.invoke('chat:steer', { id: chat.id, text: it.text, blocks: it.blocks }).then((r) => {
    if (!r || !r.ok) { toast('Not sent: ' + ((r && r.error) || 'session not running'), 'err'); setQueue(chat, [it].concat(chat.pendingMsgs)); }
  }).catch(() => setQueue(chat, [it].concat(chat.pendingMsgs)));
}

async function pickTime(chat, i) {
  const cur = chat.pendingMsgs[i];
  const v = await window.askText('Run at (24 h, HH:MM). Empty clears.', cur.runAt ? new Date(cur.runAt).toTimeString().slice(0, 5) : '', { okLabel: 'Set' });
  if (v === null) return;
  let runAt;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (m && +m[1] < 24 && +m[2] < 60) {
    const d = new Date(); d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    runAt = d.getTime();
  } else if (String(v).trim()) { toast('Use HH:MM, for example 14:30', 'err'); return; }
  setQueue(chat, chat.pendingMsgs.map((x, k) => {
    if (k !== i) return x;
    const y = { ...x };
    if (runAt) y.runAt = runAt; else delete y.runAt;
    return y;
  }));
  scheduleWake(chat);
}

/** Wake the drain when a scheduled head item is due. */
export function scheduleWake(chat) {
  clearTimeout(chat.queueWake);
  const head = (chat.pendingMsgs || [])[0];
  if (!head || !head.runAt) return;
  chat.queueWake = setTimeout(() => { if (chat.drainQueue) chat.drainQueue(); }, Math.max(0, head.runAt - Date.now()) + 50);
}

function openRowMenu(chat, i, anchor) {
  document.querySelectorAll('.q-menu').forEach((m) => m.remove());
  const it = chat.pendingMsgs[i];
  const menu = el('div', 'q-menu');
  menu.setAttribute('role', 'menu');
  const add = (label, fn) => {
    const b = el('button', 'q-menu-item', label);
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { menu.remove(); fn(); });
    menu.appendChild(b);
  };
  add('Send now as steer', () => steerNow(chat, i));
  if (i > 0) add('Run next', () => setQueue(chat, runNext(chat.pendingMsgs, i)));
  add('Duplicate', () => setQueue(chat, duplicate(chat.pendingMsgs, i)));
  add('Move back to the message box', () => toComposer(chat, i));
  add(it.ask ? 'Do not ask before running' : 'Ask before running', () => setQueue(chat, chat.pendingMsgs.map((x, k) => {
    if (k !== i) return x;
    const y = { ...x, ask: !x.ask };
    delete y.approved;
    if (!y.ask) delete y.ask;
    return y;
  })));
  add(it.runAt ? 'Change run time…' : 'Run at a time…', () => pickTime(chat, i));
  add('Model and effort…', () => editModelEffort(chat, i, anchor));
  add('Remove', () => setQueue(chat, remove(chat.pendingMsgs, i)));
  anchor.parentNode.appendChild(menu);
  const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', away, true); } };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); menu.remove(); anchor.focus(); } });
  const first = menu.querySelector('button');
  if (first) first.focus();
}

/** The models this chat can switch to without changing provider, from its picker. */
function queueModelChoices(chat) {
  const out = [];
  for (const o of (chat.modelSel ? [...chat.modelSel.options] : [])) {
    if (!o.value || o.value.startsWith('__pm:') || out.some((x) => x.value === o.value)) continue;
    out.push({ value: o.value, label: o.textContent || o.value });
  }
  return out;
}

/** A small popover on a queued row: pick the model and the reasoning effort that item runs with. */
function editModelEffort(chat, i, anchor) {
  document.querySelectorAll('.q-pop').forEach((m) => m.remove());
  const it = chat.pendingMsgs[i];
  if (!it) return;
  const pop = el('div', 'q-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Model and effort for this queued message');
  const field = (label, options, current) => {
    const l = el('label', 'q-pop-fld');
    l.appendChild(el('span', '', label));
    const sel = el('select');
    for (const [v, t] of options) { const o = el('option', '', t); o.value = v; sel.appendChild(o); }
    if (current && !options.some(([v]) => v === current)) { const o = el('option', '', current); o.value = current; sel.appendChild(o); }
    sel.value = current || '';
    l.appendChild(sel);
    pop.appendChild(l);
    return sel;
  };
  const models = [['', 'this chat’s model' + (chat.model ? ' (' + chat.model + ')' : '')], ...queueModelChoices(chat).map((m) => [m.value, m.label])];
  const efforts = [['', 'this chat’s effort'], ...((chat.effortLevels && chat.effortLevels.length ? chat.effortLevels : ['low', 'medium', 'high']).map((e) => [e, e]))];
  const modelSel = field('Model', models, it.model || '');
  const effortSel = field('Effort', efforts, it.effort || '');
  const row = el('div', 'q-pop-actions');
  const save = el('button', 'q-btn', 'Set');
  save.addEventListener('click', () => { pop.remove(); setQueue(chat, setOverrides(chat.pendingMsgs, i, { model: modelSel.value, effort: effortSel.value })); });
  const cancel = el('button', 'q-btn', 'Cancel');
  cancel.addEventListener('click', () => { pop.remove(); anchor.focus(); });
  row.appendChild(save); row.appendChild(cancel);
  pop.appendChild(row);
  anchor.parentNode.appendChild(pop);
  const away = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', away, true); } };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); pop.remove(); anchor.focus(); } });
  modelSel.focus();
}

function editInline(chat, i, textEl) {
  const it = chat.pendingMsgs[i];
  const ta = el('textarea', 'q-edit');
  ta.value = it.text;
  ta.rows = Math.min(6, it.text.split('\n').length + 1);
  ta.setAttribute('aria-label', 'Edit queued message');
  textEl.replaceWith(ta);
  ta.focus();
  const done = (save) => {
    if (ta.dataset.done) return;
    ta.dataset.done = '1';
    if (save) setQueue(chat, edit(chat.pendingMsgs, i, ta.value)); else renderQueued(chat);
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  ta.addEventListener('blur', () => done(true));
}

function clearAll(chat) {
  const old = chat.pendingMsgs.slice();
  if (!old.length) return;
  setQueue(chat, []);
  toast('Queue cleared. ', '', { label: 'Undo', onClick: () => { if (!chat.pendingMsgs.length) setQueue(chat, old); } });
}

/** The panel: header, hold banner, rows. */
export function renderQueued(chat) {
  if (!chat.queuedEl) return;
  const host = chat.queuedEl;
  host.textContent = '';
  const list = chat.pendingMsgs || [];
  host.classList.toggle('hidden', !list.length);
  if (!list.length) { chat.queuePaused = false; return; }

  const head = el('div', 'q-head');
  const fold = elIcon('button', 'q-fold', CCEIcons.svg('chevron', 12));
  fold.title = chat.queueCollapsed ? 'Show the queue' : 'Hide the queue';
  fold.setAttribute('aria-expanded', String(!chat.queueCollapsed));
  fold.addEventListener('click', () => { chat.queueCollapsed = !chat.queueCollapsed; renderQueued(chat); });
  head.appendChild(fold);
  head.appendChild(el('b', 'q-title', 'Queue (' + list.length + ')'));
  const pause = el('button', 'q-btn', chat.queuePaused ? 'Resume' : 'Pause');
  pause.title = chat.queuePaused ? 'Run the queue again' : 'Hold the queue after the current turn';
  pause.addEventListener('click', () => {
    chat.queuePaused = !chat.queuePaused;
    if (!chat.queuePaused) { chat.queueHeld = null; if (chat.drainQueue) chat.drainQueue(); }
    renderQueued(chat);
  });
  head.appendChild(pause);
  const clear = el('button', 'q-btn', 'Clear');
  clear.addEventListener('click', () => clearAll(chat));
  head.appendChild(clear);
  host.appendChild(head);

  const hold = chat.queuePaused ? 'paused' : chat.queueHeld;
  if (hold) {
    const banner = el('div', 'q-banner', HOLD_TEXT[hold] || 'Queue held');
    if (hold === 'ask' || hold === 'error' || hold === 'permission' || hold === 'spend' || hold === 'tests') {
      const run = el('button', 'q-btn', hold === 'ask' ? 'Run' : 'Run anyway');
      run.addEventListener('click', () => {
        if (hold === 'ask') chat.pendingMsgs[0] = { ...chat.pendingMsgs[0], approved: true };
        chat.queueOverride = true;
        chat.queueHeld = null;
        if (chat.drainQueue) chat.drainQueue();
        renderQueued(chat);
      });
      banner.appendChild(run);
      if (hold === 'ask') {
        const skip = el('button', 'q-btn', 'Skip');
        skip.addEventListener('click', () => { chat.queueHeld = null; setQueue(chat, remove(chat.pendingMsgs, 0)); if (chat.drainQueue) chat.drainQueue(); });
        banner.appendChild(skip);
      }
    }
    host.appendChild(banner);
  }
  if (chat.queueCollapsed) return;

  const rows = el('div', 'q-rows');
  rows.setAttribute('role', 'list');
  list.forEach((it, i) => {
    const row = el('div', 'q-row');
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    row.draggable = true;
    row.addEventListener('dragstart', (e) => { chat.queueDrag = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ } });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); chat.queueDrag = null; });
    row.addEventListener('dragover', (e) => { if (chat.queueDrag != null) { e.preventDefault(); row.classList.add('drop'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); row.classList.remove('drop');
      if (chat.queueDrag != null && chat.queueDrag !== i) setQueue(chat, move(chat.pendingMsgs, chat.queueDrag, i));
      chat.queueDrag = null;
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const to = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (to < 0 || to >= list.length) return;
        setQueue(chat, move(chat.pendingMsgs, i, to));
        const r = chat.queuedEl.querySelectorAll('.q-row')[to];
        if (r) r.focus();
      } else if (e.key === 'Delete') { e.preventDefault(); setQueue(chat, remove(chat.pendingMsgs, i)); }
      else if (e.key === 'Enter') { e.preventDefault(); const t = row.querySelector('.q-text'); if (t) editInline(chat, i, t); }
    });
    row.appendChild(el('span', 'q-grip', '⋮⋮'));
    row.appendChild(el('span', 'q-idx', String(i + 1)));
    const text = el('span', 'q-text', it.label ? it.label + ': ' + it.text : it.text || '(image)');
    text.title = 'Click to edit';
    text.addEventListener('click', () => editInline(chat, i, text));
    row.appendChild(text);
    for (const bit of summary(it)) row.appendChild(el('span', 'q-chip', bit));
    const more = el('button', 'q-more', '⋯');
    more.title = 'Actions';
    more.setAttribute('aria-label', 'Queue item actions');
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', () => openRowMenu(chat, i, more));
    row.appendChild(more);
    rows.appendChild(row);
  });
  host.appendChild(rows);
}

/** Add a message to the end of the queue. */
export function enqueue(chat, input, extra) {
  const item = makeItem(input, extra);
  setQueue(chat, (chat.pendingMsgs || []).concat(item));
  scheduleWake(chat);
  return item;
}

export { nextAction };
