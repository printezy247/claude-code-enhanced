// The Sessions card: what every open chat is doing, as plain rows.
export const MAX_ROWS = 8;

const base = (cwd) => String(cwd || '').split('/').filter(Boolean).pop() || 'chat';

/** Rows for the open chats: needs-you first, then working, then most recently used. */
export function sessionRows(entries, activeId, usedAt) {
  const rows = entries
    .filter(([, m]) => m && m.kind === 'chat')
    .map(([id, m]) => ({
      id,
      title: m.title || base(m.cwd),
      status: m.needsYou ? 'needs you' : m.busy ? 'working' : 'idle',
      active: id === activeId,
      used: (usedAt && usedAt[id]) || 0,
    }));
  const rank = (r) => (r.status === 'needs you' ? 0 : r.status === 'working' ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || b.used - a.used);
  const out = rows.slice(0, MAX_ROWS);
  out.more = Math.max(0, rows.length - MAX_ROWS);
  return out;
}
