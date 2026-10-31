// A message with a pasted key in it goes to the model and into the saved transcript.
// Before sending, say so and offer to hide the key. What counts as a key is decided in
// src/shared/secrets.js (well-known shapes only).
import { el } from './util.js';
import { scrollDownSoft } from './transcript.js';
import CCESecrets from '../../shared/secrets.js';

/**
 * @returns {boolean} true when a card was shown and the send must wait.
 * `resend` is called again once the user has chosen; the composer then holds the text to send.
 */
export function guardSecrets(chat, text, resend) {
  if (chat._keyOk) { chat._keyOk = false; return false; }
  const hits = CCESecrets.findSecretLike(text);
  if (!hits.length) return false;
  if (chat.msgs.querySelector('.key-guard')) return true;   // one card at a time
  const kinds = [...new Set(hits.map((h) => h.kind.toLowerCase()))].join(', ');
  const card = el('div', 'sys-note warn multi key-guard');
  card.appendChild(el('div', '', '⚠ Your message looks like it has a ' + kinds + ' in it. Anything you send is kept in the chat history and read by the model. Keep keys in Providers or Connectors settings instead.'));
  const acts = el('div', 'perm-actions');
  const done = (fn) => () => { card.remove(); fn(); };
  const hide = el('button', 'btn small primary', 'Hide the key and send');
  hide.addEventListener('click', done(() => { chat.composer.value = CCESecrets.redactSecretLike(text); chat._keyOk = true; resend(); }));
  const anyway = el('button', 'btn small', 'Send anyway');
  anyway.addEventListener('click', done(() => { chat._keyOk = true; resend(); }));
  const no = el('button', 'btn small', 'Don\'t send');
  no.addEventListener('click', done(() => { chat.composer.focus(); }));
  for (const b of [hide, anyway, no]) acts.appendChild(b);
  card.appendChild(acts);
  chat.msgs.appendChild(card);
  scrollDownSoft(chat);
  return true;
}
