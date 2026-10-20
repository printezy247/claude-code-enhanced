// RTK-style compaction of shell output.
//
// The engine's own bashOutputMaxChars (default 30k) is the only ceiling CCE
// had: a command that printed 200k of build noise still sent 30k to the
// model, and the model paid for every token of it. This compacts the Bash
// result on its way to the model — head and tail, repeated lines collapsed,
// with the elided size stated — while the card in the UI keeps the full
// text, so nothing is hidden from the user.
'use strict';

const DEFAULT_MAX_CHARS = 8000;
const HEAD_CHARS = 1200;
const TAIL_CHARS = 1200;
/** Room reserved for the "… N characters elided …" marker. */
const MARKER_ROOM = 64;

/**
 * The plain text of a tool result, whatever shape the engine used.
 * @param {unknown} content
 * @returns {string}
 */
function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b == null) return '';
        if (typeof b === 'string') return b;
        if (b.type === 'text') return String(b.text || '');
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    const out = [];
    if (content.stdout) out.push(String(content.stdout));
    if (content.stderr) out.push(String(content.stderr));
    if (out.length) return out.join('\n');
    if (content.text) return String(content.text);
    return '';
  }
  return String(content);
}

/**
 * Collapse a run of identical adjacent lines into one line plus a count.
 * Build logs repeat the same line hundreds of times; that is noise to the
 * model and information to nobody.
 */
function collapseRepeats(text) {
  const lines = text.split('\n');
  const out = [];
  let run = 1;
  for (let i = 1; i <= lines.length; i++) {
    if (i < lines.length && lines[i] === lines[i - 1]) { run++; continue; }
    if (run > 2) out.push(lines[i - 1] + '  (×' + run + ' identical lines)');
    else for (let k = 0; k < run; k++) out.push(lines[i - 1]);
    run = 1;
  }
  return out.join('\n');
}

/**
 * Compact one command's output.
 *
 * @param {object} opts
 * @param {unknown} opts.output     the tool result, in any shape
 * @param {string} [opts.command]   the command, for the header
 * @param {number} [opts.maxChars]  how much the model may read
 * @returns {{text: string, original: string, compacted: boolean}}
 */
function compactBashOutput({ output, command = '', maxChars = DEFAULT_MAX_CHARS } = {}) {
  const original = toolResultText(output);
  const limit = Math.max(500, Number(maxChars) || DEFAULT_MAX_CHARS);
  if (original.length <= limit) return { text: original, original, compacted: false };

  const collapsed = collapseRepeats(original);
  const body = collapsed.length < original.length ? collapsed : original;
  const header = '[cce] compacted shell output: '
    + original.split('\n').length + ' lines, ' + original.length + ' chars, model sees ~' + limit + ' chars'
    + (command ? ' (' + String(command).slice(0, 200) + ')' : '')
    + '\n';

  const budget = Math.max(200, limit - header.length - MARKER_ROOM);
  if (body.length <= budget) return { text: header + body, original, compacted: true };

  const headLen = Math.min(HEAD_CHARS, Math.floor(budget / 2));
  const tailLen = Math.min(TAIL_CHARS, Math.max(0, budget - headLen));
  const elided = Math.max(0, body.length - headLen - tailLen);
  const marker = '\n… [' + elided + ' characters elided] …\n';
  const text = header + body.slice(0, headLen) + marker + body.slice(body.length - tailLen);
  return { text, original, compacted: true };
}

module.exports = { compactBashOutput, collapseRepeats, toolResultText, DEFAULT_MAX_CHARS };
