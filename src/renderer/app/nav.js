// Keyboard navigation as plain functions: which chord means what, which tab
// comes next in most-recently-used order, and what a palette prefix selects.
export const SPLIT_KINDS = ['changes', 'files', 'terminal', 'diff', 'review', 'preview'];

/** { tab: index } for Ctrl+1..9, { split: kind } for Alt+1..6, else null. */
export function chordAction(e, tabCount) {
  if (e.shiftKey || e.metaKey || (e.ctrlKey && e.altKey) || !(e.ctrlKey || e.altKey)) return null;
  if (!/^[1-9]$/.test(String(e.key))) return null;
  const n = Number(e.key);
  if (e.ctrlKey) {
    if (!tabCount || (n !== 9 && n > tabCount)) return null;
    return { tab: n === 9 ? tabCount - 1 : n - 1 };
  }
  return n <= SPLIT_KINDS.length ? { split: SPLIT_KINDS[n - 1] } : null;
}

/** The tab Ctrl+Tab goes to: newest first (or oldest first backwards), skipping the current one. */
export function mruCycle(ids, usedAt, current, backwards) {
  if (!ids.length) return null;
  const order = ids.slice().sort((x, y) => (usedAt[y] || 0) - (usedAt[x] || 0));
  const i = order.indexOf(current);
  if (order.length < 2 || i < 0) return current && ids.includes(current) ? current : order[0];
  return order[(i + (backwards ? order.length - 1 : 1)) % order.length];
}

const PREFIX = { '>': 'commands', '@': 'files', '#': 'chats', ':': 'models' };

/** What the palette box asks for: a prefix picks a list, no prefix searches all. */
export function paletteMode(input) {
  const s = String(input || '');
  const mode = PREFIX[s[0]];
  return mode ? { mode, q: s.slice(1).trim() } : { mode: 'all', q: s.trim() };
}

const MODE_KINDS = {
  commands: ['command', 'panel', 'chat', 'view'],
  chats: ['session', 'open'],
  models: ['model'],
};
/** Which palette entries a mode lists (null: all of them; files are built on the fly). */
export function paletteKinds(mode) { return MODE_KINDS[mode] || null; }
