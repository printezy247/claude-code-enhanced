// Side chat: a small multi-turn card branched from one turn, in its own
// read-only engine session. What is said there never enters the main thread.
import { el } from './util.js';
import { btwChildren } from './btw.js';

export async function openSideChat(chat, uuid) {
  chat.pane.querySelectorAll('.side-card').forEach((c) => c.__close && c.__close());
  const card = el('div', 'side-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Side chat');
  const head = el('div', 'side-head');
  head.appendChild(el('b', '', 'Side chat'));
  head.appendChild(el('span', 'hint', ' branched from this turn · read-only'));
  const closeBtn = el('button', 'btn tiny side-close', 'Close');
  closeBtn.type = 'button';
  head.appendChild(closeBtn);
  const log = el('div', 'side-log');
  const row = el('div', 'side-row');
  const input = el('input', 'side-input');
  input.type = 'text';
  input.placeholder = 'Ask about this turn…';
  input.setAttribute('aria-label', 'Side chat message');
  const send = el('button', 'btn small side-send', 'Send');
  send.type = 'button';
  row.appendChild(input); row.appendChild(send);
  card.appendChild(head); card.appendChild(log); card.appendChild(row);
  (chat.pane.querySelector('.chat-body') || chat.pane).appendChild(card);

  let id = null;
  let live = null;
  let closed = false;
  const say = (cls, text) => { const m = el('div', 'side-msg ' + cls, text); log.appendChild(m); log.scrollTop = log.scrollHeight; return m; };
  const close = () => {
    if (closed) return;
    closed = true;
    if (id) { btwChildren.delete(id); ccx.invoke('chat:close', { id }).catch(() => {}); }
    card.remove();
  };
  card.__close = close;
  closeBtn.addEventListener('click', close);
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); chat.composer.focus(); } });

  const start = ccx.invoke('chat:create', {
    cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '',
    permissionMode: 'plan', resume: chat.sessionId, fork: true, resumeAt: uuid, btw: true,
  }).then((r) => {
    if (closed) { if (r && r.ok) ccx.invoke('chat:close', { id: r.id }).catch(() => {}); return false; }
    if (!r || !r.ok) { say('side-err', 'Could not start a side chat: ' + ((r && r.error) || 'unknown')); return false; }
    id = r.id;
    btwChildren.set(id, (evt) => {
      if (evt.kind !== 'message' || !evt.msg) return;
      const m = evt.msg;
      if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
        const t = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (t) { if (!live) live = say('side-a', ''); live.textContent += t; log.scrollTop = log.scrollHeight; }
      } else if (m.type === 'result') {
        if (m.is_error) say('side-err', 'Could not answer: ' + (m.result || m.subtype || 'error'));
        live = null;
        send.disabled = false;
      }
    });
    return true;
  });

  const ask = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    if (!(await start)) return;
    input.value = '';
    say('side-q', text);
    send.disabled = true;
    const r = await ccx.invoke('chat:send', { id, text });
    if (!r || !r.ok) { say('side-err', 'Could not ask: ' + ((r && r.error) || 'unknown')); send.disabled = false; }
  };
  send.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });
  input.focus();
  return card;
}
