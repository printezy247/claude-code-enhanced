'use strict';
/**
 * What a "user" record in the engine's stream really is.
 *
 * The engine records more than prompts as user messages: the slash command the
 * user ran (<command-name>), the output of a local command such as /model
 * (<local-command-stdout>), a note telling the model that output was not a
 * request (<local-command-caveat>), and the compaction summary. Drawn as
 * prompts they showed raw tags and a page-long "message" from the user.
 * Shared by the chat pane (live) and the transcript reader (reopened chats).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CCEUserText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const tag = (s, name) => {
    const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(s);
    return m ? m[1].trim() : null;
  };
  const SUMMARY_RE = /^This session is being continued from a previous conversation/;

  /**
   * @param {string} text  the record's text
   * @param {object} [flags]  record flags (isCompactSummary, isMeta)
   * @returns {{kind: 'prompt'|'note'|'summary'|'skip', text: string}}
   */
  function classifyUserText(text, flags = {}) {
    const s = String(text || '');
    if (flags.isCompactSummary || SUMMARY_RE.test(s.trim())) return { kind: 'summary', text: s.trim() };
    if (/<local-command-caveat>/.test(s)) return { kind: 'skip', text: '' };
    const out = tag(s, 'local-command-stdout');
    const err = tag(s, 'local-command-stderr');
    if (out != null || err != null) {
      const t = [out, err].filter(Boolean).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
      return t ? { kind: 'note', text: t } : { kind: 'skip', text: '' };
    }
    const name = tag(s, 'command-name');
    if (name != null) {
      const args = tag(s, 'command-args') || '';
      return { kind: 'prompt', text: (name.startsWith('/') ? name : '/' + name) + (args ? ' ' + args : '') };
    }
    if (flags.isMeta) return { kind: 'skip', text: '' };
    return { kind: 'prompt', text: s.trim() };
  }

  return { classifyUserText };
});
