'use strict';
/**
 * Remember which connectors have worked, so a connector that worked last time and is
 * broken now stands out from one that never worked (usually: never signed in).
 * Also picks the plugin connectors worth switching off in one go.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEConnHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_ENTRIES = 300;
  const MAX_PER_BUCKET = 120;   // the limit connectorauto.normalizeModes keeps per bucket

  /** history: { name: { okAt } }. Returns a new object; a connected server records the time. */
  function updateHistory(history, servers, now) {
    const next = {};
    const old = history && typeof history === 'object' && !Array.isArray(history) ? history : {};
    for (const [k, v] of Object.entries(old)) if (v && Number(v.okAt) > 0) next[k] = { okAt: Number(v.okAt) };
    for (const s of Array.isArray(servers) ? servers : []) {
      if (s && s.name && s.status === 'connected') next[s.name] = { okAt: now };
    }
    const keys = Object.keys(next);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => next[a].okAt - next[b].okAt).slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete next[k]);
    }
    return next;
  }

  /** Names that connected before and are failed or waiting for a sign-in now. */
  function regressed(history, servers) {
    const out = new Set();
    for (const s of Array.isArray(servers) ? servers : []) {
      if (!s || !s.name) continue;
      if ((s.status === 'failed' || s.status === 'needs-auth') && history && history[s.name] && history[s.name].okAt) out.add(s.name);
    }
    return out;
  }

  /** Plugin connectors that are failing (not merely waiting for a sign-in). */
  function failedPluginNames(servers) {
    return (Array.isArray(servers) ? servers : [])
      .filter((s) => s && /^plugin:[^:]+:.+/.test(String(s.name || '')) && s.status === 'failed')
      .map((s) => s.name);
  }

  /**
   * connectorModes with `names` set to off for all projects.
   * @returns {{next:object, added:number, skipped:number}}
   */
  function withOff(connectorModes, names) {
    const cur = connectorModes && typeof connectorModes === 'object' ? connectorModes : {};
    const next = { global: { ...(cur.global || {}) }, projects: { ...(cur.projects || {}) } };
    let added = 0;
    let skipped = 0;
    for (const n of names || []) {
      if (next.global[n] === 'off') continue;
      if (Object.keys(next.global).length >= MAX_PER_BUCKET) { skipped++; continue; }
      next.global[n] = 'off';
      added++;
    }
    return { next, added, skipped };
  }

  return { updateHistory, regressed, failedPluginNames, withOff, MAX_PER_BUCKET };
});
