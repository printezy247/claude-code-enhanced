'use strict';
/**
 * Splitting a model's leaked reasoning out of its answer.
 *
 * Shared because the proxy and the chat pane must agree on the cut: when the
 * proxy streams a reply and the renderer re-splits the same text, two copies of
 * this rule that drift apart show the user reasoning twice, or none of it.
 * Loaded as a <script> by the renderer and require()d by the main process.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEThink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const THINK_CLOSE_RE = /<\/think(?:ing)?\s*>/i;
  const THINK_OPEN_RE = /^\s*<think(?:ing)?\s*>/i;

  /** True when `idx` sits inside a ``` fence or an inline `code` span. */
  function inCode(text, idx) {
    const before = text.slice(0, idx);
    if ((before.match(/```/g) || []).length % 2 === 1) return true;
    const line = before.slice(before.lastIndexOf('\n') + 1).replace(/```/g, '');
    return (line.match(/`/g) || []).length % 2 === 1;
  }

  /**
   * Reasoning a model wrote into its reply instead of the thinking channel:
   * `<think>…</think>answer`, or just `…</think>answer` when the chat template
   * supplied the opening tag. A tag inside code is prose, not a cut.
   * @returns {{thinking: string, text: string}}
   */
  function splitThink(text) {
    const s = String(text || '');
    const m = THINK_CLOSE_RE.exec(s);
    if (m && !inCode(s, m.index)) {
      const head = s.slice(0, m.index).replace(THINK_OPEN_RE, '');
      return { thinking: head.trim(), text: s.slice(m.index + m[0].length).replace(/^\s+/, '') };
    }
    const open = THINK_OPEN_RE.exec(s);
    if (open && !m) return { thinking: s.slice(open[0].length).trim(), text: '' };
    return { thinking: '', text: s };
  }

  return { THINK_CLOSE_RE, inCode, splitThink };
});