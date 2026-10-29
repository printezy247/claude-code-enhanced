// "@" mentions of other open conversations. Typing @ lists the chats open in
// other tabs; picking one inserts @chat:"Title". What the model gets is the
// message plus a short summary of that conversation; what the user sees is
// the message with the token as a link that jumps to that tab. The text rules
// are pure so they can be tested without a page.

const TOKEN = /@chat:"([^"\n]{1,80})"/g;
const SUMMARY_MAX = 1500;

/** The token for a chat title (quotes in the title would end the token early). */
export function chatToken(title) {
  return '@chat:"' + String(title || 'conversation').replace(/["\n]/g, ' ').trim().slice(0, 80) + '"';
}

/** The titles mentioned in a message, once each, in order. */
export function mentionedTitles(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TOKEN)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** A message cut into plain text and mentions: [{ text } | { chat }]. */
export function splitMentions(text) {
  const s = String(text || '');
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index) });
    parts.push({ chat: m[1], token: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  return parts.length ? parts : [{ text: s }];
}

/** Keep the end of a long reply: the conclusion is what another chat needs. */
function tailChars(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? '…' + t.slice(t.length - n) : t;
}

/**
 * The context block for one mentioned conversation, from its last turns
 * ([{ role: 'user' | 'assistant', text }]). Empty when the chat has nothing yet.
 */
export function conversationContext(title, turns, max = SUMMARY_MAX) {
  const use = (turns || []).filter((t) => t && String(t.text || '').trim()).slice(-4);
  if (!use.length) return '';
  const per = Math.floor(max / use.length);
  const body = use.map((t) => (t.role === 'user' ? 'User: ' : 'Assistant: ') + tailChars(t.text, per)).join('\n\n');
  return '<conversation title="' + chatToken(title).slice(7, -1) + '">\n' + body + '\n</conversation>';
}

/**
 * The text to send: the message, then a context block per mentioned open
 * conversation. `turnsFor(title)` returns that chat's turns, or null when no
 * open chat has the title (the token then stays as plain text).
 */
export function expandMentions(text, turnsFor) {
  const blocks = [];
  for (const title of mentionedTitles(text)) {
    const turns = turnsFor(title);
    if (!turns) continue;
    const b = conversationContext(title, turns);
    if (b) blocks.push(b);
  }
  return blocks.length ? String(text) + '\n\nContext from other conversations I mentioned:\n\n' + blocks.join('\n\n') : String(text);
}

/** Fill a bubble with the message; each mention becomes a link calling onOpen(title). */
export function renderMentions(host, text, onOpen, doc = globalThis.document) {
  host.textContent = '';
  for (const p of splitMentions(text)) {
    if (p.chat === undefined) { host.appendChild(doc.createTextNode(p.text)); continue; }
    const a = doc.createElement('a');
    a.className = 'chat-mention';
    a.href = '#';
    a.textContent = '@' + p.chat;
    a.title = 'Jump to this conversation';
    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onOpen(p.chat); });
    host.appendChild(a);
  }
}
