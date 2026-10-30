// /btw <question>: a side question asked in a throwaway, read-only session so
// the main turn is not interrupted. The answer arrives as its own card.
import { toast } from '../app/core.js';
import { chats, el } from './util.js';
import { scrollDownSoft } from './transcript.js';
import { parseBtw } from './loopgoal.js';

export { parseBtw };

/** Child session id -> function that takes its events. Read by handleEvent before it looks up a chat. */
export const btwChildren = new Map();

export async function askBtw(chat, question) {
  const card = el('div', 'btw-card');
  card.appendChild(el('div', 'btw-q', 'btw: ' + question));
  const ans = el('div', 'btw-a hint', 'thinking…');
  card.appendChild(ans);
  chat.msgs.appendChild(card);
  scrollDownSoft(chat);
  let id = null;
  const done = (text, failed) => {
    ans.textContent = text;
    ans.classList.toggle('hint', !!failed);
    ans.classList.toggle('btw-err', !!failed);
    if (id) { btwChildren.delete(id); ccx.invoke('chat:close', { id }).catch(() => {}); }
    scrollDownSoft(chat);
  };
  try {
    const r = await ccx.invoke('chat:create', {
      cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '',
      permissionMode: 'plan', btw: true,
    });
    if (!r || !r.ok) { done('Could not start a side session: ' + ((r && r.error) || 'unknown'), true); return; }
    id = r.id;
    let text = '';
    btwChildren.set(id, (evt) => {
      if (evt.kind !== 'message' || !evt.msg) return;
      const m = evt.msg;
      if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
        text += m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      } else if (m.type === 'result') {
        if (m.is_error) done('Could not answer: ' + (m.result || m.subtype || 'error'), true);
        else done(text.trim() || String(m.result || '(no answer)'), false);
      }
    });
    const s = await ccx.invoke('chat:send', { id, text: question });
    if (!s || !s.ok) done('Could not ask: ' + ((s && s.error) || 'unknown'), true);
  } catch (e) {
    done('Could not answer: ' + ((e && e.message) || e), true);
  }
  void chats; void toast;
}
