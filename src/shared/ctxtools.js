'use strict';
/**
 * Small pure helpers for keeping the context window in view:
 *  - describe and search a big tool output without reading all of it,
 *  - rank which tool results cost the most context,
 *  - spot Claude retrying the same failing call,
 *  - read what a compaction summary says it kept.
 * The chat pane in src/renderer/chat only places the results on screen.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCECtxTools = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** Tokens, roughly: 4 characters each. Good enough to rank, never shown as exact. */
  const estTokens = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) / 4);

  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB'
    : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');

  /** "56 KB · 1,240 lines" */
  function describeOutput(text) {
    const s = String(text || '');
    const lines = s ? s.split('\n').length : 0;
    return { chars: s.length, lines, label: fmtBytes(s.length) + ' · ' + lines.toLocaleString('en-US') + ' line' + (lines === 1 ? '' : 's') };
  }

  /**
   * Lines of `text` that contain `query` (case-insensitive), with their line numbers.
   * @returns {{shown:Array<{n:number,text:string}>, matches:number, total:number}}
   */
  function filterLines(text, query, max = 200) {
    const q = String(query || '').trim().toLowerCase();
    const all = String(text || '').split('\n');
    if (!q) return { shown: [], matches: 0, total: all.length };
    const hits = [];
    for (let i = 0; i < all.length; i++) if (all[i].toLowerCase().includes(q)) hits.push({ n: i + 1, text: all[i] });
    return { shown: hits.slice(0, max), matches: hits.length, total: all.length };
  }

  /** The n biggest results: [{label, chars, tokens}], biggest first. */
  function topConsumers(list, n = 5) {
    return (Array.isArray(list) ? list : [])
      .filter((x) => x && Number(x.chars) > 0)
      .map((x) => ({ label: String(x.label || x.name || 'tool'), chars: Number(x.chars), tokens: estTokens(x.chars) }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, n);
  }

  /** Same tool + same input = same key. */
  function retryKey(name, input) {
    let body = '';
    try { body = JSON.stringify(input == null ? null : input); } catch { body = String(input); }
    return String(name || '') + '\u0000' + body;
  }

  /**
   * Counts calls that fail one after another with identical input.
   * note() is true exactly once, when the streak reaches `limit`.
   */
  function createRetryTracker(limit = 3) {
    let key = null;
    let streak = 0;
    return {
      note(k, failed) {
        if (!failed) { key = null; streak = 0; return false; }
        if (k === key) streak++; else { key = k; streak = 1; }
        return streak === limit;
      },
      get streak() { return streak; },
    };
  }

  const FILE_RE = /[\w@.\-/]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|md|css|html|py|sh|yml|yaml|toml|txt|rs|go|java|c|h|cpp)\b/g;

  /**
   * What a compaction summary says it kept: file names it mentions and its section
   * headings. Read from the text, so it is a guide to the summary, not a guarantee.
   */
  function summaryFacts(text) {
    const s = String(text || '');
    const files = [];
    for (const m of s.match(FILE_RE) || []) {
      const f = m.replace(/^[./]+/, '');
      if (f && !files.includes(f)) files.push(f);
      if (files.length >= 12) break;
    }
    const sections = [];
    for (const line of s.split('\n')) {
      const m = /^\s*(?:#{1,3}\s+|\d{1,2}\.\s+)(.{3,80}?):?\s*$/.exec(line);
      if (m && !sections.includes(m[1])) sections.push(m[1]);
      if (sections.length >= 12) break;
    }
    return { files, sections };
  }

  return { estTokens, fmtBytes, describeOutput, filterLines, topConsumers, retryKey, createRetryTracker, summaryFacts };
});
