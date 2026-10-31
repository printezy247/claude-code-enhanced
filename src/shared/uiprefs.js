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

  return { SCROLLBARS, NOTICE_SCOPES, normalizeScrollbar, normalizeNoticeScope };
});
