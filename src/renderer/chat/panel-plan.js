// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { elIcon } from '../app/core.js';
import { el, esc, md } from './util.js';

/* ---------------- plan viewer (claude-desktop style) ---------------- */

export function openPlanViewer(chat) {
  if (chat.planViewer) return chat.planViewer.body;
  const wrap = el('div', 'chat-plan-viewer');
  const head = el('div', 'plan-head');
  head.appendChild(elIcon('h4', '', CCEIcons.svg('map', 14) + ' Plan'));
  const close = el('button', 'close', '✕');
  close.title = 'Hide plan panel';
  close.setAttribute('aria-label', 'Hide plan panel');
  close.addEventListener('click', () => { wrap.remove(); chat.planViewer = null; });
  head.appendChild(close);
  const body = el('div', 'plan-body md');
  body.innerHTML = '<p class="hint">waiting for the plan…</p>';
  wrap.appendChild(head);
  wrap.appendChild(body);
  chat.planViewer = { wrap, body };
  chat.pane.querySelector('.chat-body').appendChild(wrap);
  return body;
}

export function updatePlanViewer(chat, jsonStr) {
  const body = chat.planViewer ? chat.planViewer.body : null;
  if (!body || !jsonStr) return;
  try {
    const j = JSON.parse(jsonStr);
    if (j && j.plan) body.innerHTML = md(j.plan);
  } catch { /* partial JSON — wait for more */ }
}

/* ---------------- find in transcript (#feat-find) ----------------
   Uses the engine's native window.find (Chromium find-in-page) so matches
   highlight across the whole rendered transcript, plus a naive occurrence
   count from the text. */
export function showFind(chat) {
  let bar = chat.pane.querySelector('.chat-find');
  if (!bar) {
    bar = el('div', 'chat-find');
    const inp = el('input');
    inp.type = 'text';
    inp.placeholder = 'find in transcript';
    inp.setAttribute('aria-label', 'Find in transcript');
    const prev = el('button', 'btn small', '◀');
    prev.setAttribute('aria-label', 'Previous match');
    const next = el('button', 'btn small', '▶');
    next.setAttribute('aria-label', 'Next match');
    const count = el('span', 'hint chat-find-count', '');
    const close = el('button', 'btn small', '✕');
    close.setAttribute('aria-label', 'Close find bar');
    const step = (back) => {
      const q = inp.value;
      if (!q) return;
      try { window.find(q, !!back, false, true); } catch { /* empty */ }
      paintCount();
    };
    const paintCount = () => {
      const q = inp.value;
      if (!q) { count.textContent = ''; return; }
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let n = 0;
      try { n = (chat.msgs.textContent.match(new RegExp(esc, 'gi')) || []).length; } catch { /* bad regex */ }
      count.textContent = n ? n + ' match' + (n === 1 ? '' : 'es') : 'no matches';
    };
    const hide = () => { bar.classList.add('hidden'); inp.value = ''; paintCount(); };
    inp.addEventListener('input', () => { try { window.find(inp.value, false, false, false); } catch { /* empty */ } paintCount(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { step(e.shiftKey); e.preventDefault(); }
      else if (e.key === 'Escape') { hide(); chat.composer.focus(); e.preventDefault(); e.stopPropagation(); }
    });
    [prev, next].forEach((b, i) => b.addEventListener('click', () => step(i === 0)));
    close.addEventListener('click', hide);
    bar.appendChild(inp); bar.appendChild(prev); bar.appendChild(next); bar.appendChild(count); bar.appendChild(close);
    chat.pane.appendChild(bar);
  }
  bar.classList.remove('hidden');
  const inp = bar.querySelector('input');
  inp.focus();
  inp.select();
}
