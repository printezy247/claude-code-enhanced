// /btw <question>: a side question asked in a throwaway, read-only session so
// the main turn is not interrupted. The answer arrives as its own card.
import { el } from './util.js';
import { scrollDownSoft } from './transcript.js';
import { parseBtw } from './loopgoal.js';

export { parseBtw };

/** Child session id -> function that takes its events. Read by handleEvent before it looks up a chat. */
export const btwChildren = new Map();

/**
 * Ask one question in a throwaway read-only session. Resolves { ok, text }.
 * `onStart(id)` lets a caller see the child's id (tests, cleanup).
 */
export function runSide({ cwd, providerUid, model, question }) {
  return new Promise((resolve) => {
    let id = null;
    let settled = false;
    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      if (id) { btwChildren.delete(id); ccx.invoke('chat:close', { id }).catch(() => {}); }
      resolve({ ok, text });
    };
    (async () => {
      try {
        const r = await ccx.invoke('chat:create', { cwd, providerUid: providerUid || null, model: model || '', permissionMode: 'plan', btw: true });
        if (!r || !r.ok) return finish(false, 'Could not start a side session: ' + ((r && r.error) || 'unknown'));
        id = r.id;
        let text = '';
        btwChildren.set(id, (evt) => {
          if (evt.kind !== 'message' || !evt.msg) return;
          const m = evt.msg;
          if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
            text += m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          } else if (m.type === 'result') {
            if (m.is_error) finish(false, 'Could not answer: ' + (m.result || m.subtype || 'error'));
            else finish(true, text.trim() || String(m.result || '(no answer)'));
          }
        });
        const s = await ccx.invoke('chat:send', { id, text: question });
        if (!s || !s.ok) finish(false, 'Could not ask: ' + ((s && s.error) || 'unknown'));
      } catch (e) {
        finish(false, 'Could not answer: ' + ((e && e.message) || e));
      }
    })();
  });
}

export async function askBtw(chat, question) {
  const card = el('div', 'btw-card');
  card.appendChild(el('div', 'btw-q', 'btw: ' + question));
  const ans = el('div', 'btw-a hint', 'thinking…');
  card.appendChild(ans);
  chat.msgs.appendChild(card);
  scrollDownSoft(chat);
  const r = await runSide({ cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model, question });
  ans.textContent = r.text;
  ans.classList.toggle('hint', !r.ok);
  ans.classList.toggle('btw-err', !r.ok);
  scrollDownSoft(chat);
}
