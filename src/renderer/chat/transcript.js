// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { renderMentions } from './mentions.js';
import { jumpToChat } from './mentions-live.js';
import { toast } from '../app/core.js';
import { Chat } from './index.js';
import { addCopyBtn } from './markdown.js';
import { switchModel, switchProvider } from './picker.js';
import { renderDiff } from './tools.js';
import { el, md } from './util.js';

/* ---------------- message rendering ---------------- */

/** Output of a command the user ran (e.g. /model), shown as a quiet note. */
export function appendCommandNote(chat, text, uuid) {
  chat.msgs.querySelector('.chat-empty')?.remove();
  const full = String(text || '');
  let n;
  if (full.length > 160 || full.includes('\n')) {
    // Long output (hook dumps after /compact, command logs): one line, full text on demand.
    const hooks = (full.match(/completed successfully/g) || []).length;
    const label = /^Compacted\b/.test(full) && hooks
      ? 'Compacted · ' + hooks + ' hook' + (hooks === 1 ? '' : 's') + ' ran'
      : full.replace(/\s+/g, ' ').slice(0, 90) + '…';
    n = el('details', 'sys-note cmd-note');
    n.appendChild(el('summary', '', '↳ ' + label));
    n.appendChild(el('pre', 'cmd-note-full', full));
  } else {
    n = el('div', 'sys-note cmd-note', '↳ ' + full);
  }
  if (uuid) n.dataset.uuid = uuid;
  chat.msgs.appendChild(n);
  scrollDownSoft(chat);
}

/** The engine's compaction summary: folded, since it can run to pages. */
export function appendSummary(chat, text, uuid) {
  chat.msgs.querySelector('.chat-empty')?.remove();
  const d = el('details', 'compact-summary');
  if (uuid) d.dataset.uuid = uuid;
  d.appendChild(el('summary', '', 'Summary of the earlier conversation — what the model now remembers. Click to read.'));
  const body = el('div', 'md');
  body.innerHTML = md(String(text || '').replace(/^This session is being continued[^\n]*\n+/, ''));
  d.appendChild(body);
  chat.msgs.appendChild(d);
  scrollDownSoft(chat);
}

/** A thin rail of ticks on the left edge, one per request the user sent; hover to read it,
 *  click to jump there. Shown only while the left sidebar is hidden (CSS). */
/** One word on how a request ended: running, answered, error, no reply. */
export function replyStatus(chat, m, isLast) {
  let n = m.nextElementSibling;
  let answered = false;
  while (n && !n.classList.contains('user-msg')) {
    if (n.classList.contains('error-msg')) return 'error';
    if (n.classList.contains('assistant-msg')) answered = true;
    n = n.nextElementSibling;
  }
  if (isLast && chat.busy) return 'still running';
  return answered ? 'answered' : 'no reply yet';
}

export function setupRequestRail(chat) {
  const body = chat.pane.querySelector('.chat-body');
  if (!body || !chat.msgs) return;
  const rail = el('div', 'req-rail');
  rail.setAttribute('role', 'navigation');
  rail.setAttribute('aria-label', 'Jump to a request');
  const tip = el('div', 'req-tip hidden');
  body.appendChild(rail);
  body.appendChild(tip);
  let queued = false;
  let items = [];
  const textOf = (m) => (m.dataset.text || '').trim();
  const paint = () => {
    queued = false;
    if (!rail.isConnected) return;
    items = [...chat.msgs.querySelectorAll(':scope > .user-msg')];
    rail.classList.toggle('empty', !items.length);
    rail.textContent = '';
    items.forEach((m, i) => {
      const b = el('button', 'req-tick');
      b.type = 'button';
      b.dataset.i = String(i);
      b.setAttribute('aria-label', 'Request ' + (i + 1) + ': ' + textOf(m).slice(0, 80));
      rail.appendChild(b);
    });
  };
  const tickOf = (e) => e.target.closest && e.target.closest('.req-tick');
  const show = (e) => {
    const b = tickOf(e), m = b && items[Number(b.dataset.i)];
    if (!m) return;
    const text = textOf(m);
    const lines = text.split('\n');
    const head = lines.slice(0, 3).join('\n');
    tip.textContent = (head.length > 280 ? head.slice(0, 280) + '…' : head + (lines.length > 3 ? '\n…' : '')) + '\n— ' + replyStatus(chat, m, items[items.length - 1] === m) + (m.dataset.metrics ? ' · ' + m.dataset.metrics : '');
    tip.classList.remove('hidden');
    const br = b.getBoundingClientRect(), pr = body.getBoundingClientRect();
    tip.style.top = Math.max(4, Math.min(br.top - pr.top - 8, pr.height - tip.offsetHeight - 4)) + 'px';
  };
  const hide = () => tip.classList.add('hidden');
  rail.addEventListener('mouseover', show);
  rail.addEventListener('focusin', show);
  rail.addEventListener('mouseout', hide);
  rail.addEventListener('focusout', hide);
  rail.addEventListener('click', (e) => {
    const b = tickOf(e), m = b && items[Number(b.dataset.i)];
    if (!m) return;
    chat.follow = false;
    m.scrollIntoView({ block: 'start', behavior: 'smooth' });
    m.classList.add('req-flash');
    setTimeout(() => m.classList.remove('req-flash'), 1200);
  });
  // Only a request added or removed changes the rail; streamed blocks do not.
  const isReq = (n) => n.nodeType === 1 && n.classList.contains('user-msg');
  new MutationObserver((recs) => {
    if (queued || !recs.some((r) => [...r.addedNodes, ...r.removedNodes].some(isReq))) return;
    queued = true;
    requestAnimationFrame(paint);
  }).observe(chat.msgs, { childList: true });
  paint();
}

/** Dispose a Monaco diff editor and put its card back to the click-to-show state. */
function releaseDiff(d) {
  if (!d.__ed) return;
  try { d.__ed.dispose(); } catch { /* disposed */ }
  d.__ed = null;
  d.classList.add('pending');
  d.innerHTML = '<div class="hint">click the card header to show the diff</div>';
  if (d.__diffData) {
    d.__init = () => {
      const fresh = renderDiff(d.__diffData.name, d.__diffData.input, d.__diffData.source);
      d.replaceWith(fresh);
      if (fresh.__init) fresh.__init();
    };
  }
}

export function appendUser(chat, text, uuid) {
  chat.msgs.querySelector('.chat-empty')?.remove();
  const wrap = el('div', 'msg user-msg');
  wrap.dataset.uuid = uuid || '';
  wrap.dataset.text = String(text || '').trim();
  const bubble = el('div', 'user-bubble');
  // An @chat:"Title" mention is a link to that conversation's tab.
  renderMentions(bubble, text, jumpToChat);
  addCopyBtn(bubble, () => text);
  // Hover actions: re-ask from here, and rewind the files to this point. #30
  const acts = el('div', 'msg-actions');
  const edit = el('button', 'btn tiny', 'edit & resend');
  edit.title = 'Branch a new conversation from this message with an edited prompt';
  edit.addEventListener('click', () => resendFrom(chat, uuid, text));
  acts.appendChild(edit);
  const back = el('button', 'btn tiny', 'rewind here');
  back.title = 'Restore files to the state at this message (conversation keeps going)';
  back.addEventListener('click', async () => {
    const r = await ccx.invoke('chat:rewind', { id: chat.id, uuid, dryRun: true });
    if (!r.ok) return toast(r.error, 'err');
    const files = (r.filesChanged || []).length;
    if (!files) return toast('no tracked file changes at this point', '');
    const go = window.confirm(`Rewind ${files} file(s)? +${r.insertions || 0} −${r.deletions || 0}`);
    if (!go) return;
    const rw = await ccx.invoke('chat:rewind', { id: chat.id, uuid });
    toast(rw.ok ? 'files rewound' : rw.error, rw.ok ? 'ok' : 'err');
  });
  if (uuid) acts.appendChild(back);
  wrap.appendChild(bubble);
  wrap.appendChild(acts);
  chat.msgs.appendChild(wrap);
  scrollDownSoft(chat);
  return wrap;
}

/** Branch the conversation from a message with an edited prompt. #30 */
async function resendFrom(chat, uuid, originalText) {
  const edited = await window.askText('Re-ask from this message (the conversation branches)', originalText, { multiline: true, okLabel: 'Re-ask' });
  if (edited === null || !edited.trim() || edited === originalText) return;
  Chat.createSession({
    cwd: chat.cwd,
    providerUid: chat.provider ? chat.provider.uid : null,
    model: chat.model || '',
    permissionMode: chat.mode,
    resume: chat.sessionId,
    fork: true,
    resumeAt: uuid,
    initText: edited,
  });
}

/* ---------------- transcript virtualization (#C1) ---------------- */
// Keep only a bounded window of messages in the DOM so a 10k-message
// conversation does not create 10k nodes. Older nodes stay in chat._allNodes
// and come back when the user scrolls toward the top. #C1
const VIRT_WINDOW = 100;

const VIRT_PAGE = 100;

const VIRT_EST_HEIGHT = 60;

export function installVirtualization(chat) {
  chat._allNodes = [];
  chat._winStart = 0;
  chat._winEnd = 0;
  chat._renderedStart = 0;   // alias kept for older code / tests
  chat._renderedEnd = 0;
  chat._virtLoading = false;
  const msgs = chat.msgs;
  const spacer = document.createElement('div');
  spacer.className = 'virt-spacer';
  spacer.style.height = '0px';
  chat._topSpacer = spacer;
  const origAppend = msgs.appendChild.bind(msgs);
  const origRemove = msgs.removeChild.bind(msgs);
  chat._origAppend = origAppend;
  chat._origRemove = origRemove;

  function removeEmpty() {
    const empty = msgs.querySelector('.chat-empty');
    if (empty && empty.parentNode === msgs) try { origRemove(empty); } catch { /* ignore */ }
  }

  function rebuildWindow(start) {
    const total = chat._allNodes.length;
    if (total === 0) {
      for (const c of [...msgs.children]) if (c !== spacer) try { origRemove(c); } catch { /* ignore */ }
      if (spacer.parentNode === msgs) try { origRemove(spacer); } catch { /* ignore */ }
      spacer.style.height = '0px';
      try { origAppend(spacer); } catch { /* ignore */ }
      chat._winStart = 0; chat._winEnd = 0;
      chat._renderedStart = 0; chat._renderedEnd = 0;
      return;
    }
    let s = Math.max(0, Math.min(start, total - 1));
    let e = Math.min(total, s + VIRT_WINDOW);
    if (e - s < VIRT_WINDOW) s = Math.max(0, e - VIRT_WINDOW);
    e = Math.min(total, s + VIRT_WINDOW);
    if (total <= VIRT_WINDOW) { s = 0; e = total; }

    const keepScroll = msgs.scrollTop;
    for (const c of [...msgs.children]) if (c !== spacer) try { origRemove(c); } catch { /* ignore */ }
    if (spacer.parentNode === msgs) try { origRemove(spacer); } catch { /* ignore */ }
    spacer.style.height = (s * VIRT_EST_HEIGHT) + 'px';
    try { origAppend(spacer); } catch { /* ignore */ }
    for (let i = s; i < e; i++) {
      const n = chat._allNodes[i];
      if (n) try { origAppend(n); } catch { /* ignore */ }
    }
    chat._winStart = s;
    chat._winEnd = e;
    chat._renderedStart = s;
    chat._renderedEnd = e;
    try { msgs.scrollTop = keepScroll; } catch { /* read-only */ }
  }

  function evictTop() {
    while (chat._winEnd - chat._winStart > VIRT_WINDOW) {
      const node = chat._allNodes[chat._winStart];
      if (node && node.parentNode === msgs) try { origRemove(node); } catch { /* ignore */ }
      // An evicted card keeps no live Monaco editor; it rebuilds one when opened again.
      if (node && node.querySelectorAll) node.querySelectorAll('.monaco-diff').forEach(releaseDiff);
      chat._winStart++;
    }
    chat._renderedStart = chat._winStart;
    chat._renderedEnd = chat._winEnd;
    spacer.style.height = (chat._winStart * VIRT_EST_HEIGHT) + 'px';
    if (spacer.parentNode !== msgs) try { origAppend(spacer); } catch { /* ignore */ }
    try { msgs.insertBefore(spacer, msgs.firstChild); } catch { /* ignore */ }
  }

  msgs.appendChild = function(node) {
    if (node === spacer) return origAppend(node);
    removeEmpty();
    chat._allNodes.push(node);
    const total = chat._allNodes.length;
    const idx = total - 1;
    if (chat.follow !== false) {
      // Anchored at the bottom: paint the node and keep the tail window.
      if (chat._winEnd === total - 1 || chat._winEnd === 0) {
        if (spacer.parentNode !== msgs) try { origAppend(spacer); } catch { /* ignore */ }
        try { msgs.insertBefore(spacer, msgs.firstChild); } catch { /* ignore */ }
        origAppend(node);
        chat._winEnd = total;
        evictTop();
      } else {
        rebuildWindow(Math.max(0, total - VIRT_WINDOW));
      }
      try { msgs.scrollTop = msgs.scrollHeight; } catch { /* read-only */ }
    } else {
      // User is reading older messages: record the node, paint only if it
      // falls inside the current window (it normally does not, since it is
      // newer than the view).
      if (idx >= chat._winStart && idx < chat._winEnd) {
        rebuildWindow(chat._winStart);
      }
    }
    chat._renderedStart = chat._winStart;
    chat._renderedEnd = chat._winEnd;
    return node;
  };

  msgs.removeChild = function(node) {
    const idx = chat._allNodes.indexOf(node);
    if (idx !== -1) {
      chat._allNodes.splice(idx, 1);
      if (chat._winEnd > chat._allNodes.length) chat._winEnd = chat._allNodes.length;
      chat._renderedStart = chat._winStart;
      chat._renderedEnd = chat._winEnd;
    }
    return origRemove(node);
  };

  const onVirtScroll = () => {
    if (chat._allNodes.length === 0 || chat._virtLoading) return;
    const total = chat._allNodes.length;
    const s = chat._winStart;
    const e = chat._winEnd;
    if (msgs.scrollTop < 120 && s > 0) {
      chat._virtLoading = true;
      const newS = Math.max(0, s - VIRT_PAGE);
      const beforeH = msgs.scrollHeight;
      const beforeT = msgs.scrollTop;
      rebuildWindow(newS);
      try { msgs.scrollTop = beforeT + (msgs.scrollHeight - beforeH); } catch { /* read-only */ }
      chat._virtLoading = false;
      return;
    }
    if (e < total && (msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 120)) {
      chat._virtLoading = true;
      const newS = Math.max(0, total - VIRT_WINDOW);
      rebuildWindow(newS);
      if (msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 40) {
        try { msgs.scrollTop = msgs.scrollHeight; } catch { /* read-only */ }
      }
      chat._virtLoading = false;
    }
  };
  // At most one window check per frame: scroll fires far faster than that.
  let virtQueued = false;
  const raf = window.requestAnimationFrame ? (f) => window.requestAnimationFrame(f) : (f) => setTimeout(f, 16);
  msgs.addEventListener('scroll', () => {
    if (virtQueued) return;
    virtQueued = true;
    raf(() => { virtQueued = false; onVirtScroll(); });
  }, { passive: true });
}

export function nearBottom(chat) {
  return chat.msgs.scrollHeight - chat.msgs.scrollTop - chat.msgs.clientHeight < 40;
}

export function scrollDown(chat) { chat.msgs.scrollTop = chat.msgs.scrollHeight; }

// New output only pulls the view down while the user is at the bottom; once
// they scroll up to read, it stays put until they come back (or send).
export function scrollDownSoft(chat) {
  if (chat.follow !== false) scrollDown(chat);
  else updateLatestBtn(chat);
}

/**
 * Show the "jump to latest" button while the view is away from the live
 * end. Without it, scrolling up to read an earlier answer left no way back
 * to the newest response short of dragging the scrollbar.
 */
export function updateLatestBtn(chat) {
  const btn = chat.latestBtn;
  if (!btn) return;
  const away = !nearBottom(chat);
  btn.classList.toggle('hidden', !away);
}

export function appendError(chat, text) {
  const m = String(text || '');
  // Remember what was just shown so a second frame for the same failure (the
  // turn's terminal_reason carries the same detail) can be recognised instead
  // of printing the identical error twice.
  chat.lastErrorText = m;
  chat.lastErrorAt = Date.now();
  const ctx = m.match(/exceeds the available context size \((\d+)\s*tokens\)/i);
  const need = m.match(/request \((\d+)\s*tokens\)/i);
  const e = el('div', 'msg error-msg');
  e.appendChild(el('div', '', '⚠ ' + m.slice(0, 260)));
  if (ctx) {
    const g = el('div', 'ctx-guide');
    g.appendChild(el('div', 'hint', `This model serves only ${Number(ctx[1]).toLocaleString()} tokens of context, but the claude engine's base prompt (your skills + plugins) needs ${Number(need ? need[1] : 0).toLocaleString()}. Options: pick a ≥128K-context model (gpt-oss:120b-cloud / nemotron-3-*), load a bigger local model via the ⚙ manager, or disable some plugins to shrink the base prompt.`));
    const row = el('div', 'perm-actions');
    const sw = el('button', 'btn small primary', 'Switch to gpt-oss:120b-cloud');
    sw.addEventListener('click', () => {
      switchModel(chat, 'gpt-oss:120b-cloud').then(() => {
        if (![...chat.modelSel.options].some(o => o.value === 'gpt-oss:120b-cloud')) {
          const o = el('option', '', 'gpt-oss:120b-cloud'); o.value = 'gpt-oss:120b-cloud';
          chat.modelSel.insertBefore(o, chat.modelSel.querySelector('[value="__custom"]'));
        }
        chat.modelSel.value = 'gpt-oss:120b-cloud';
      }).catch((err) => toast(String(err && err.message || err), 'err'));
    });
    row.appendChild(sw);
    const mgr = el('button', 'btn small', '⚙ model manager');
    mgr.addEventListener('click', () => { if (window.openOllamaManager && chat.provider) window.openOllamaManager(chat.provider); });
    row.appendChild(mgr);
    g.appendChild(row);
    e.appendChild(g);
  }
  // The engine maps Opus/Sonnet/Haiku to whatever the Claude settings (or the
  // provider's small model) name; when that model is missing, say so and offer a way out.
  const gone = !ctx && m.match(/model_not_found|may not exist or you may not have access/i);
  if (gone) {
    const pick = (m.match(/selected model \(([^)]+)\)/i) || [])[1];
    const g = el('div', 'ctx-guide');
    g.appendChild(el('div', 'hint', (pick ? '"' + pick + '"' : 'That model') + ' is not available to this provider. Opus, Sonnet and Haiku are only names: the engine swaps in whatever your Claude settings map them to. Pick one of the provider\'s own models in the model menu, or go back to its default.'));
    const row = el('div', 'perm-actions');
    const def = el('button', 'btn small primary', 'Use the provider default');
    def.addEventListener('click', () => { switchModel(chat, '').then(() => { chat.modelSel.value = ''; }).catch((err) => toast(String(err && err.message || err), 'err')); });
    row.appendChild(def);
    g.appendChild(row);
    e.appendChild(g);
  }
  if (chat.switchedFrom && chat.switchedFrom.uid !== (chat.provider && chat.provider.uid)) {
    const back = chat.switchedFrom;
    const g = el('div', 'ctx-guide');
    g.appendChild(el('div', 'hint', 'This provider has not answered yet since you switched to it. The conversation is intact on ' + (back.name || 'the previous provider') + '.'));
    const row = el('div', 'perm-actions');
    const b = el('button', 'btn small primary', 'Switch back to ' + (back.name || 'previous provider'));
    b.addEventListener('click', () => { chat.switchedFrom = null; switchProvider(chat, back.uid, back.model); });
    row.appendChild(b);
    g.appendChild(row);
    e.appendChild(g);
  }
  chat.msgs.appendChild(e);
  scrollDownSoft(chat);
}
