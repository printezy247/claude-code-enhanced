'use strict';
/**
 * Small display settings, normalised in one place so the main process (which stores
 * them) and the renderer (which applies them) agree on the allowed values.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEUiPrefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCROLLBARS = ['accent', 'hidden', 'default'];
  const NOTICE_SCOPES = ['mine', 'all'];

  /** Chat scrollbar: orange see-through (default), hidden, or the plain grey one. */
  const normalizeScrollbar = (v) => (SCROLLBARS.includes(v) ? v : 'accent');
  /** Which connectors the "not ready" chat note may name: the user's own, or every one. */
  const normalizeNoticeScope = (v) => (NOTICE_SCOPES.includes(v) ? v : 'mine');

  /** Tools /read may try, as a comma list in the user's order. */
  const normalizeReadOrder = (v) => {
    const ids = ['lightpanda', 'webfetch', 'ytdlp', 'gh'];
    const out = [];
    for (const x of (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,]+/))) {
      const id = String(x).toLowerCase();
      if (ids.includes(id) && !out.includes(id)) out.push(id);
    }
    return (out.length ? out : ['lightpanda', 'webfetch']).join(',');
  };

  return { SCROLLBARS, NOTICE_SCOPES, normalizeScrollbar, normalizeNoticeScope, normalizeReadOrder };
});
