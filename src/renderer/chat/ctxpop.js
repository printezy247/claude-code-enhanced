// The popover above the footbar's context ring: usage, a bar per category,
// Compact now and Toggle Overview. Click the ring again or press Escape to close.
import { el, fmtTok } from './util.js';
import { doCompact } from './slash.js';

export function closeCtxPop(chat) {
  if (chat.ctxPop) { chat.ctxPop.remove(); chat.ctxPop = null; }
  if (chat.ctxPopKey) { document.removeEventListener('keydown', chat.ctxPopKey, true); chat.ctxPopKey = null; }
}

export function toggleCtxPop(chat) {
  if (chat.ctxPop) { closeCtxPop(chat); return; }
  const pop = el('div', 'ctx-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Context usage');
  fill(chat, pop);
  const host = chat.compactBtn.closest('.chat-foot, .chat-footbar, .chat-input-wrap') || chat.pane;
  host.style.position = host.style.position || 'relative';
  host.appendChild(pop);
  chat.ctxPop = pop;
  chat.ctxPopKey = (e) => { if (e.key === 'Escape') closeCtxPop(chat); };
  document.addEventListener('keydown', chat.ctxPopKey, true);
  // Fresh numbers: the background poll only runs now and then.
  ccx.invoke('chat:context', { id: chat.id }).then((r) => {
    if (r && r.ok && r.usage && chat.ctxPop === pop) { chat.ctxUsage = r.usage; fill(chat, pop); }
  }).catch(() => {});
}

function fill(chat, pop) {
  pop.textContent = '';
  const u = chat.ctxUsage || {};
  const max = Math.max(1, Number(u.maxTokens) || 1);
  const head = el('div', 'ctx-pop-head');
  head.appendChild(el('span', '', Math.round(Number(u.percentage) || 0) + '% used'));
  head.appendChild(el('span', '', fmtTok(Number(u.totalTokens) || 0) + ' / ' + fmtTok(max)));
  pop.appendChild(head);
  for (const c of (u.categories || []).filter((x) => x && x.kind !== 'free' && x.kind !== 'deferred' && Number(x.tokens) > 0).slice(0, 6)) {
    const row = el('div', 'ctx-pop-row');
    row.appendChild(el('span', '', c.name || 'other'));
    const bar = el('span', 'ctx-pop-bar');
    const fill = el('i');
    fill.style.width = Math.min(100, Number(c.tokens) / max * 100).toFixed(1) + '%';
    if (c.color) fill.style.background = c.color;
    bar.appendChild(fill);
    row.appendChild(bar);
    pop.appendChild(row);
  }
  const acts = el('div', 'ctx-pop-acts');
  const compact = el('button', 'btn small ctx-pop-compact', 'Compact now');
  compact.addEventListener('click', () => { closeCtxPop(chat); doCompact(chat); });
  const ov = el('button', 'btn small', 'Toggle Overview');
  ov.addEventListener('click', () => { closeCtxPop(chat); if (window.toggleOverview) window.toggleOverview(); });
  acts.appendChild(compact);
  acts.appendChild(ov);
  pop.appendChild(acts);
}
