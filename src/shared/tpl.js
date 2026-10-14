'use strict';
/**
 * `${KEY}` handling for provider URL templates.
 *
 * The main process fills templates when saving a provider; the renderer fills
 * the same templates live as the user types placeholders. Both must leave a
 * missing key in place, otherwise the UI flags the wrong thing. Shared for that
 * reason — loaded as a <script> by the renderer, require()d by the main process.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCETpl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** Fill a `${KEY}` template. Missing keys are left in place so the UI can flag them. */
  function resolveTemplate(tpl, values) {
    return String(tpl || '').replace(/\$\{(\w+)\}/g, (m, k) => {
      const v = values && values[k];
      return v == null || v === '' ? m : String(v);
    });
  }

  /** Extract `${KEY}` placeholder keys from a template string. */
  function placeholdersIn(tpl) {
    return [...String(tpl || '').matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
  }

  return { resolveTemplate, placeholdersIn };
});