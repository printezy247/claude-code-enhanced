'use strict';
/**
 * The memory notes as a timeline: parse MEMORY.md and the note files, number the
 * notes so a reply can cite "#mem-3", filter them, and keep text marked <private>
 * out of what is remembered. Pure: main reads the files, the panel draws the list.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEMemTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TYPES = ['user', 'feedback', 'project', 'reference'];
  const estTokens = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) / 4);

  /** "- [Title](file.md) — hook" lines of MEMORY.md, numbered from 1 in file order. */
  function parseIndex(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
      const m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+?)\)\s*(?:[—–-]+\s*(.*))?$/.exec(line);
      if (!m) continue;
      out.push({ n: out.length + 1, title: m[1].trim(), file: m[2].trim(), hook: (m[3] || '').trim() });
    }
    return out;
  }

  /** Front matter + body of one note file. */
  function parseNote(text) {
    const s = String(text || '');
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(s);
    const head = m ? m[1] : '';
    const body = (m ? m[2] : s).trim();
    const pick = (k) => { const r = new RegExp('^\\s*' + k + ':\\s*(.+)$', 'm').exec(head); return r ? r[1].trim().replace(/^"(.*)"$/, '$1') : ''; };
    const type = pick('type');
    return { name: pick('name'), description: pick('description'), type: TYPES.includes(type) ? type : 'project', body };
  }

  /** Entries with a type, a search text and a token estimate, ready for the panel. */
  function buildTimeline(indexText, notesByFile) {
    return parseIndex(indexText).map((e) => {
      const raw = notesByFile && notesByFile[e.file];
      const note = raw == null ? null : parseNote(raw);
      const chars = raw == null ? 0 : String(raw).length;
      return {
        n: e.n, title: e.title, file: e.file, hook: e.hook,
        type: note ? note.type : 'project', body: note ? note.body : '',
        missing: raw == null, chars, tokens: estTokens(chars),
      };
    });
  }

  /** type: one of TYPES or ''/'all'; q: words that must all appear in title, hook or body. */
  function filterEntries(entries, { type, q } = {}) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return (entries || []).filter((e) => {
      if (type && type !== 'all' && e.type !== type) return false;
      const hay = (e.title + ' ' + e.hook + ' ' + e.body).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  /** Counts per type for the filter chips. */
  function typeCounts(entries) {
    const c = { all: (entries || []).length };
    for (const t of TYPES) c[t] = 0;
    for (const e of entries || []) c[e.type] = (c[e.type] || 0) + 1;
    return c;
  }

  const PRIVATE_RE = /<private>[\s\S]*?<\/private>/gi;
  const hasPrivate = (text) => /<private>/i.test(String(text || ''));
  /** Text with every <private>…</private> block removed. */
  const stripPrivate = (text) => String(text || '').replace(PRIVATE_RE, '').replace(/<\/?private>/gi, '');
  /** Wrap text so Claude uses it now but is told never to save it. */
  const markPrivate = (text) => '<private>' + String(text || '').trim() + '</private>';

  /** Where "#mem-12" appears in a text: [{index, length, n}]. */
  function findCitations(text) {
    const out = [];
    const re = /(^|[^\w&])#mem-(\d{1,4})\b/g;
    let m;
    const s = String(text || '');
    while ((m = re.exec(s))) {
      const lead = m[1].length;
      out.push({ index: m.index + lead, length: m[0].length - lead, n: Number(m[2]) });
    }
    return out;
  }

  return { TYPES, estTokens, parseIndex, parseNote, buildTimeline, filterEntries, typeCounts, hasPrivate, stripPrivate, markPrivate, findCitations };
});
