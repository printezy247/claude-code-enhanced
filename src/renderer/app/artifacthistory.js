// Artifact versions: saves with the same title and kind are versions of one thing.
const MAX_LINES = 1500;

/** All saved versions of an artifact (same title and kind), newest first. */
export function versionsOf(items, a) {
  return items.filter((x) => x.title === a.title && x.kind === a.kind).sort((x, y) => y.at - x.at);
}

/** Line diff between two texts: [{ t: 'same'|'add'|'del', s }]. */
export function lineDiff(oldText, newText) {
  const a = String(oldText).split('\n');
  const b = String(newText).split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;   // too big to compare line by line
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: 'same', s: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ t: 'del', s: a[i++] });
    else out.push({ t: 'add', s: b[j++] });
  }
  while (i < n) out.push({ t: 'del', s: a[i++] });
  while (j < m) out.push({ t: 'add', s: b[j++] });
  return out;
}

/** A file name and extension for exporting an artifact. */
export function exportName(a) {
  const base = String(a.title || 'artifact').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'artifact';
  return base + (a.kind === 'markdown' ? '.md' : '.txt');
}
