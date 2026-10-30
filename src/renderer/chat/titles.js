// Chat names. The first-turn text names a chat at once (session.js autoTitle);
// the CLI's own title replaces it one time, and a name the user typed wins.
const MAX = 40;

/** The title the CLI reports for a session ('' when it only has the first prompt). */
export function cliTitleOf(info) {
  if (!info) return '';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const t = clean(info.customTitle) || clean(info.summary);
  if (!t || t === clean(info.firstPrompt)) return '';
  return t.slice(0, MAX);
}

function paint(chat, t) {
  if (chat.tabEl && chat.tabEl.firstChild) chat.tabEl.firstChild.textContent = '⌘ ' + t;
  if (chat.titleEl) chat.titleEl.textContent = t;
}

/** Name the chat from the CLI. True when it changed; false when it must stay as it is. */
export function applyCliTitle(chat, info) {
  if (!chat || chat.titleManual || chat.cliTitled) return false;
  const t = cliTitleOf(info);
  if (!t) return false;
  chat.cliTitled = true;
  chat.titled = true;
  paint(chat, t);
  return true;
}

/** The user renamed this chat: nothing automatic touches the name again. */
export function markManualTitle(chat, title) {
  chat.titleManual = true;
  if (title) paint(chat, String(title).trim().slice(0, 80));
}

/** After a turn: ask the CLI for its title for this session, until one is applied. */
export function pullCliTitle(chat) {
  if (!chat || chat.cliTitled || chat.titleManual || !chat.sessionId) return;
  window.ccx.invoke('session:title', { sessionId: chat.sessionId, cwd: chat.cwd }).then((r) => {
    if (r && r.ok && r.info) applyCliTitle(chat, r.info);
  }).catch(() => {});
}
