// The part of "@ a conversation" that needs the page: which chats are open,
// what they said last, and jumping to one. The text rules are in mentions.js.
import { toast } from '../app/core.js';
import { chats } from './util.js';

const base = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || '';

/** Titles are what the user sees on the tab; two chats with one title are told apart by folder. */
export function chatTitle(c) {
  return ((c.titleEl && c.titleEl.textContent) || '').trim() || base(c.cwd) || 'conversation';
}

/** Other chats that are open now. */
export function openChats(excludeId) {
  return [...chats.values()].filter((c) => c && c.alive && c.id !== excludeId).map((c) => ({ id: c.id, title: chatTitle(c), folder: base(c.cwd), chat: c }));
}

/** The last turns of a chat, as the model would read them. */
export function chatTurns(c) {
  const nodes = c._allNodes && c._allNodes.length ? c._allNodes : [...c.msgs.children];
  const turns = [];
  for (const n of nodes) {
    if (!n.classList) continue;
    if (n.classList.contains('user-msg')) turns.push({ role: 'user', text: n.dataset.text || '' });
    else if (n.classList.contains('assistant-msg')) turns.push({ role: 'assistant', text: (n.querySelector('.md') || n).textContent || '' });
  }
  return turns;
}

/** Turns for the chat with this title, or null (not open). */
export function turnsForTitle(title, excludeId) {
  const hit = openChats(excludeId).find((x) => x.title === title);
  return hit ? chatTurns(hit.chat) : null;
}

export function jumpToChat(title) {
  const hit = openChats().find((x) => x.title === title);
  if (hit && window.__activate) window.__activate(hit.id);
  else toast('That conversation is not open any more', '');
}
