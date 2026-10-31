'use strict';
/**
 * The agent board: one row per subagent (Task / Agent call) in a chat, nested by who
 * started whom. Pure: the Overview card draws what this returns.
 *
 * The engine reports no cost or token count per subagent, so a row shows what the
 * app can see: type, model if one was asked for, state, how long it ran, and the size
 * of what it returned (a rough token estimate of its answer).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEAgentBoard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const isAgent = (name) => name === 'Task' || name === 'Agent';

  /**
   * @param {Array<[string, object]>} tools  [toolUseId, ctx] pairs from chat.tools
   * @param {number} now
   * @returns {{rows:Array, running:number, total:number, failed:number}}
   */
  function boardRows(tools, now) {
    const list = [];
    const byId = new Map();
    for (const [id, c] of tools || []) {
      if (!c || !isAgent(c.name)) continue;
      const input = c.input || {};
      const end = c.endedAt || (c.status === 'running' ? now : c.startedAt);
      const row = {
        id, parentId: c.parentId || null, depth: 0,
        title: String(input.description || input.subagent_type || 'agent').slice(0, 80),
        type: String(input.subagent_type || 'general'),
        model: String(input.model || ''),
        state: c.status === 'running' ? 'running' : c.status === 'err' ? 'failed' : 'done',
        ms: Math.max(0, (end || now) - (c.startedAt || now)),
        tokens: Math.ceil(String(c.output || '').length / 4),
        started: c.startedAt || 0,
      };
      list.push(row);
      byId.set(id, row);
    }
    for (const r of list) {
      let d = 0;
      let p = r.parentId && byId.get(r.parentId);
      const seen = new Set([r.id]);
      while (p && !seen.has(p.id) && d < 6) { d++; seen.add(p.id); p = p.parentId && byId.get(p.parentId); }
      r.depth = d;
    }
    // Parents first, each followed by its children, in start order.
    const children = new Map();
    for (const r of list) {
      const k = r.parentId && byId.has(r.parentId) ? r.parentId : '';
      (children.get(k) || children.set(k, []).get(k)).push(r);
    }
    const rows = [];
    const walk = (k) => {
      for (const r of (children.get(k) || []).sort((a, b) => a.started - b.started)) { rows.push(r); walk(r.id); }
    };
    walk('');
    return {
      rows, total: rows.length,
      running: rows.filter((r) => r.state === 'running').length,
      failed: rows.filter((r) => r.state === 'failed').length,
    };
  }

  /** 4s, 2m 05s, 1h 02m */
  function fmtMs(ms) {
    const s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  return { isAgent, boardRows, fmtMs };
});
