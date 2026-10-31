'use strict';
/**
 * Group the engine's MCP server list for people.
 *
 * Plugins bring their own copy of the same connector (plugin:sales:google-calendar,
 * plugin:finance:google-calendar, ...), so a raw list shows one row per plugin and a
 * count like 12/114. Here they fold into one row per connector and status, and only
 * connectors that work or are broken count in the badge: ones that wait for a
 * sign-in or were switched off are neither.
 * Shared by the Overview card (live) and the chat's "not ready" note.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEMcpGroup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PLUGIN_RE = /^plugin:([^:]+):(.+)$/;

  /** plugin:sales:google-calendar -> google-calendar; other names are kept. */
  const baseName = (name) => {
    const m = PLUGIN_RE.exec(String(name || ''));
    return m ? m[2] : String(name || '');
  };
  const isPlugin = (name) => PLUGIN_RE.test(String(name || ''));
  const pluginOf = (name) => { const m = PLUGIN_RE.exec(String(name || '')); return m ? m[1] : ''; };

  /** connected | failed | auth | off | pending */
  const bucket = (status) => {
    switch (status) {
      case 'connected': return 'live';
      case 'failed': return 'failed';
      case 'needs-auth': return 'auth';
      case 'disabled': return 'off';
      default: return 'pending';
    }
  };

  const ORDER = ['live', 'pending', 'failed', 'auth', 'off'];

  /**
   * @param {Array<{name:string,status:string,autoOff?:boolean}>} servers
   * @returns {{counts:object, total:number, badge:string, groups:Array}}
   *   groups: one per (connector, bucket): {key,label,bucket,count,names,plugins,servers}
   */
  function groupServers(servers) {
    const counts = { live: 0, pending: 0, failed: 0, auth: 0, off: 0 };
    const map = new Map();
    for (const sv of Array.isArray(servers) ? servers : []) {
      if (!sv || !sv.name) continue;
      const b = bucket(sv.status);
      counts[b]++;
      const label = baseName(sv.name);
      const key = label + '|' + b;
      let g = map.get(key);
      if (!g) { g = { key, label, bucket: b, count: 0, names: [], plugins: [], servers: [] }; map.set(key, g); }
      g.count++;
      g.names.push(sv.name);
      g.servers.push(sv);
      const p = pluginOf(sv.name);
      if (p && !g.plugins.includes(p)) g.plugins.push(p);
    }
    const groups = [...map.values()].sort((a, c) => ORDER.indexOf(a.bucket) - ORDER.indexOf(c.bucket)
      || c.count - a.count || a.label.localeCompare(c.label));
    // Working or broken: the two states that tell the user something about their setup.
    const judged = counts.live + counts.failed;
    return { counts, total: judged, badge: judged ? counts.live + '/' + judged : '0', groups };
  }

  /** "12 live · 2 failed · 37 sign-in" — empty parts are left out. */
  function summaryText(counts) {
    const parts = [];
    if (counts.live) parts.push(counts.live + ' live');
    if (counts.failed) parts.push(counts.failed + ' failed');
    if (counts.auth) parts.push(counts.auth + ' sign-in');
    if (counts.pending) parts.push(counts.pending + ' starting');
    return parts.join(' · ');
  }

  /**
   * The note shown in the chat when connectors are not ready.
   * scope 'mine': only connectors the user added (not plugin copies); 'all': every one.
   * @returns {null|{summary:string,lines:string[]}}
   */
  function notReadyNotice(servers, scope) {
    const wanted = (Array.isArray(servers) ? servers : []).filter((s) => s && s.name
      && s.status !== 'connected' && s.status !== 'disabled'
      && (scope === 'all' || !isPlugin(s.name)));
    if (!wanted.length) return null;
    const g = groupServers(wanted);
    const bits = [];
    if (g.counts.auth) bits.push(g.counts.auth + ' need' + (g.counts.auth === 1 ? 's' : '') + ' sign-in');
    if (g.counts.failed) bits.push(g.counts.failed + ' failed');
    if (g.counts.pending) bits.push(g.counts.pending + ' still starting');
    const lines = g.groups.map((x) => x.label + (x.count > 1 ? ' ×' + x.count : '') + ' (' + (x.bucket === 'auth' ? 'needs-auth' : x.bucket) + ')');
    return { summary: '⚠ Connectors not ready: ' + bits.join(', '), lines };
  }

  return { baseName, isPlugin, pluginOf, bucket, groupServers, summaryText, notReadyNotice };
});
