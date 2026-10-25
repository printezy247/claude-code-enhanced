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
/**
 * The range the Settings row promises, and the single source of truth for it.
 *
 * The renderer clamps what the user types, but the main process is the code
 * that actually uses the number: a hand-edited config.json, another writer, or
 * a stale value must not hand the model an unbounded result. #F1
 */
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 100000;
/** Room reserved for the "… N characters elided …" marker. */
const MARKER_ROOM = 64;

/**
 * Clamp a budget to the range the Settings row promises.
 * @param {unknown} maxChars
 * @returns {number}
 */
function clampMaxChars(maxChars) {
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.round(n)));
}

const DEFAULT_IDLE_SECONDS = 180;

/**
 * How long a silent engine stream may stay silent before the turn is called dead.
 * Lives here with the other Settings clamps: the main process uses the number.
 * @param {unknown} seconds
 * @returns {number} 30…1800
 */
function clampIdleSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_SECONDS;
  return Math.min(1800, Math.max(30, Math.round(n)));
}

/** Tools whose output is compacted by this filter. */
const FILTERED_TOOLS = ['Bash', 'Grep', 'Glob', 'Read'];

/**
 * How much of one tool's output the model may read. A file the model asked to
 * read is the work itself, so Read gets a larger share than a search or a log.
 */
function budgetFor(toolName, maxChars) {
  const base = clampMaxChars(maxChars);
  if (toolName === 'Read') return Math.min(MAX_MAX_CHARS, Math.max(base * 3, 24000));
  return base;
}

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
    // Read: { file: { content } }. Grep: { content } or { filenames }. Glob: { filenames }.
    if (content.file && typeof content.file.content === 'string') return content.file.content;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.filenames)) return content.filenames.map(String).join('\n');
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
  return compactToolOutput({ output, toolName: 'Bash', detail: command, maxChars });
}

/**
 * Compact any tool's output (Bash, Grep, Glob, Read).
 *
 * @param {object} opts
 * @param {unknown} opts.output     the tool result, in any shape
 * @param {string}  [opts.toolName] the tool name (e.g. 'Bash', 'Grep', 'Glob')
 * @param {string}  [opts.detail]   detail string (e.g. command or pattern)
 * @param {number}  [opts.maxChars] how much the model may read
 * @returns {{text: string, original: string, compacted: boolean}}
 */
function compactToolOutput({ output, toolName = 'tool', detail = '', maxChars = DEFAULT_MAX_CHARS } = {}) {
  const original = toolResultText(output);
  const limit = budgetFor(toolName, maxChars);
  if (original.length <= limit) return { text: original, original, compacted: false };

  // Collapsing repeats rewrites the text; a file's blank lines must come back as written.
  const collapsed = toolName === 'Read' ? original : collapseRepeats(original);
  const body = collapsed.length < original.length ? collapsed : original;
  const lines = original.split('\n').length;
  const det = detail ? ' (' + String(detail).slice(0, 200) + ')' : '';
  const label = toolName === 'Bash' ? 'shell output' : toolName + ' output';
  const hint = toolName === 'Read' ? ' — read a narrower range with offset and limit for the rest' : '';
  const headerFor = (stated) => '[cce] compacted ' + label + ': '
    + lines + ' lines, ' + original.length + ' chars, model sees ' + stated + ' chars'
    + det + hint + '\n';
  const headerRoom = headerFor('').length + 8;
  const budget = Math.max(0, limit - headerRoom - MARKER_ROOM);

  let bodyText = body;
  if (body.length > budget) {
    const headLen = Math.max(1, Math.min(budget - 1, Math.round(budget * 0.6)));
    const tailLen = Math.max(0, budget - headLen);
    const elided = Math.max(0, body.length - headLen - tailLen);
    const marker = '\n… [' + elided + ' characters elided] …\n';
    bodyText = body.slice(0, headLen) + marker + body.slice(body.length - tailLen);
  }
  const stated = statedLength(headerFor('').length + bodyText.length);
  const text = headerFor(stated) + bodyText;
  return { text, original, compacted: true };
}

/**
 * The length of a text that states its own length in its header.
 *
 * The text is `base + digits(stated)` long, and `stated` is that length, so
 * the two must agree: pick the number of digits that makes the equation true.
 *
 * @param {number} base  the length of the text without the stated number
 * @returns {number}
 */
function statedLength(base) {
  for (let d = 1; d <= 9; d++) {
    const n = base + d;
    if (String(n).length === d) return n;
  }
  return base + 1;
}

module.exports = {
  compactBashOutput, compactToolOutput, collapseRepeats, toolResultText,
  DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS, clampMaxChars, budgetFor, FILTERED_TOOLS, clampIdleSeconds, DEFAULT_IDLE_SECONDS,
};
