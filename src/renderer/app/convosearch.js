// Search across past conversations: date cutoff and transcript hits per session.
const DAY = 86400000;
const RANGES = { day: 1, week: 7, month: 30 };

/** Oldest modified time a conversation may have for the chosen range; 0 = any. */
export function dateCutoff(range, now) {
  return RANGES[range] ? now - RANGES[range] * DAY : 0;
}

/** A short readable piece of a transcript line around the query. */
export function snippet(line, query) {
  const flat = String(line || '').replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(String(query || '').toLowerCase());
  const at = i < 0 ? 0 : i;
  const from = Math.max(0, at - 30);
  return (from > 0 ? '…' : '') + flat.slice(from, at + 50).trim() + '…';
}

/** Transcript hits grouped per known session, most hits first; `keep` filters sessions. */
export function deepMatches(matches, sessions, query, keep) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const out = new Map();
  for (const m of matches || []) {
    const id = String(m.file || '').split('/').pop().replace(/\.jsonl$/, '');
    const session = byId.get(id);
    if (!session || (keep && !keep(session))) continue;
    const cur = out.get(id) || { session, count: 0, snippet: snippet(m.line, query) };
    cur.count++;
    out.set(id, cur);
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}
