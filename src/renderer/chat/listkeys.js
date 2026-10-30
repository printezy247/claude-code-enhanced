// Shift+Enter in a bullet or numbered line: start the next item (or end the list).
const ITEM = /^(\s*)([-*+]|\d+\.)\s(.*)$/;

/** { value, caret } after the key, or null when the line is not a list item. */
export function continueList(value, caret) {
  const v = String(value || '');
  const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
  const m = ITEM.exec(v.slice(lineStart, caret));
  if (!m) return null;
  const [, indent, marker, text] = m;
  const rest = v.slice(caret);
  if (!text.trim()) {
    const head = v.slice(0, lineStart);
    return { value: head + rest, caret: head.length };
  }
  const next = /^\d+\.$/.test(marker) ? (parseInt(marker, 10) + 1) + '.' : marker;
  const insert = '\n' + indent + next + ' ';
  return { value: v.slice(0, caret) + insert + rest, caret: caret + insert.length };
}
