'use strict';
/**
 * The /doctor checklist: what is set up, what is not, and a text report that is safe
 * to paste into a bug report (every line goes through the secret masker).
 * Pure: the chat pane collects the facts and places the result.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEDoctor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * @param {object} d
   * @param {{found:boolean,version?:string}} [d.claude]
   * @param {string} [d.auth]            label shown in the status bar
   * @param {boolean} [d.authFailed]
   * @param {{live:number,failed:number,auth:number}} [d.mcp]
   * @param {Array<{name:string,found:boolean}>} [d.tools]
   * @param {boolean} [d.sandbox]        the chat runs its commands in a sandbox
   * @param {boolean} [d.lightpanda]     the web browser is on for this chat
   * @param {{percentage:number}} [d.ctx]
   * @returns {Array<{name:string, level:'ok'|'warn'|'bad', detail:string}>}
   */
  function buildChecks(d = {}) {
    const out = [];
    const add = (name, level, detail) => out.push({ name, level, detail });
    if (d.claude && d.claude.found) add('Claude Code CLI', 'ok', d.claude.version || 'found');
    else add('Claude Code CLI', 'bad', 'not found: install it, then re-check from the banner');

    if (d.authFailed) add('Sign-in', 'bad', 'the last request failed to sign in: run /login in a terminal tab');
    else add('Sign-in', 'ok', d.auth || 'ok');

    if (d.mcp) {
      const { live = 0, failed = 0, auth = 0 } = d.mcp;
      if (failed) add('Connectors', 'warn', live + ' working, ' + failed + ' failed (' + auth + ' waiting for sign-in)');
      else add('Connectors', 'ok', live + ' working' + (auth ? ', ' + auth + ' waiting for sign-in' : ''));
    }

    const missing = (d.tools || []).filter((t) => !t.found).map((t) => t.name);
    if (d.tools) add('Helper tools', missing.length ? 'warn' : 'ok', missing.length ? 'missing: ' + missing.join(', ') : 'all found');

    add('Sandbox', d.sandbox ? 'ok' : 'warn', d.sandbox ? 'commands run inside the sandbox' : 'commands run without a sandbox');
    add('Web browser (Lightpanda)', 'ok', d.lightpanda ? 'on for this chat' : 'off for this chat');

    if (d.ctx && Number.isFinite(Number(d.ctx.percentage))) {
      const p = Math.round(Number(d.ctx.percentage));
      add('Context window', p >= 90 ? 'bad' : p >= 75 ? 'warn' : 'ok', p + '% used' + (p >= 75 ? ': compact soon' : ''));
    }
    return out;
  }

  /** A 0-100 score: ok counts full, warn half, bad none. */
  function score(checks) {
    if (!checks.length) return 100;
    const pts = checks.reduce((n, c) => n + (c.level === 'ok' ? 1 : c.level === 'warn' ? 0.5 : 0), 0);
    return Math.round((pts / checks.length) * 100);
  }

  /**
   * Plain-text report. `mask` hides secrets (CCESecrets.maskText); it is required so a
   * report can never be built without it.
   */
  function reportText(checks, meta, mask) {
    if (typeof mask !== 'function') throw new Error('reportText needs a masking function');
    const m = meta || {};
    const lines = [
      'Claude Code Enhanced diagnostics',
      'version: ' + (m.appVersion || '?') + ' · electron ' + (m.electron || '?') + ' · ' + (m.platform || '?'),
      'model: ' + (m.model || 'default') + ' · folder: ' + (m.cwd || '?'),
      'health: ' + score(checks) + '/100',
      '',
      ...checks.map((c) => (c.level === 'ok' ? '[ok]   ' : c.level === 'warn' ? '[warn] ' : '[FAIL] ') + c.name + ' — ' + c.detail),
    ];
    return mask(lines.join('\n'));
  }

  return { buildChecks, score, reportText };
});
