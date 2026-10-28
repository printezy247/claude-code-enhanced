// Pure markdown helpers for the visual editor (item 21). No DOM imports —
// the tests import this module directly.

/** Toggle one checklist line: '- [ ] x' ↔ '- [x] x'. Everything else is untouched. */
export function toggleTaskLine(line) {
  if (/^- \[ \]/.test(line)) return line.replace(/^- \[ \]/, '- [x]');
  if (/^- \[x\]/i.test(line)) return line.replace(/^- \[x\]/i, '- [ ]');
  return line;
}

/** Parse an arrow chain ('a -> b -> c', one arrow or one `->` per line) into a graph. */
export function parseFlow(text) {
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const add = (n) => {
    const name = n.trim();
    if (!name) return null;
    if (!seen.has(name)) { seen.add(name); nodes.push(name); }
    return name;
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('->')) continue;
    const segs = line.split(/\s*->\s*/).filter(Boolean);
    if (segs.length < 2) continue;
    const ids = segs.map(add);
    for (let i = 0; i < ids.length - 1; i++) {
      if (ids[i] && ids[i + 1]) edges.push([ids[i], ids[i + 1]]);
    }
  }
  return { nodes, edges };
}

/** Render the graph as a vertical SVG of boxes with arrows between them. */
export function flowSvg({ nodes, edges }) {
  const w = 260, boxH = 36, gap = 34;
  const h = Math.max(nodes.length * (boxH + gap) - gap + 8, 40);
  const pos = new Map();
  nodes.forEach((n, i) => pos.set(n, { x: 10, y: 4 + i * (boxH + gap) }));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="flow diagram">`];
  for (const [from, to] of edges) {
    const a = pos.get(from), b = pos.get(to);
    if (!a || !b) continue;
    const x = a.x + 70;
    parts.push(`<line x1="${x}" y1="${a.y + boxH}" x2="${x}" y2="${b.y}" stroke="currentColor" stroke-width="2"/>`);
    parts.push(`<path d="M ${x - 5} ${b.y - 7} L ${x} ${b.y} L ${x + 5} ${b.y - 7}" fill="none" stroke="currentColor" stroke-width="2"/>`);
  }
  for (const n of nodes) {
    const p = pos.get(n);
    parts.push(`<rect x="${p.x}" y="${p.y}" width="140" height="${boxH}" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>`);
    parts.push(`<text x="${p.x + 70}" y="${p.y + boxH / 2 + 4}" text-anchor="middle" font-size="13" fill="currentColor">${esc(n)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Preview pipeline: markdown → safe HTML, with ```flow fences swapped for SVG
 * and checklist lines rendered as real checkboxes (toggling goes through the
 * source text, not the DOM). marked/DOMPurify are page globals.
 */
export function renderPreview(text, { marked, DOMPurify } = {}) {
  const src = String(text || '');
  const flowBlocks = [];
  const withoutFlows = src.replace(/```flow\n([\s\S]*?)```/g, (_, body) => {
    flowBlocks.push(body);
    return '\n\n<!--cce-flow-' + (flowBlocks.length - 1) + '-->\n\n';
  });
  let html;
  if (marked && typeof marked.parse === 'function') html = marked.parse(withoutFlows);
  else html = '<pre>' + withoutFlows.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  html = html.replace(/<!--cce-flow-(\d+)-->/g, (_, i) => {
    const svg = flowSvg(parseFlow(flowBlocks[Number(i)] || ''));
    return '<div class="md-flow">' + svg + '</div>';
  });
  if (DOMPurify && typeof DOMPurify.sanitize === 'function') html = DOMPurify.sanitize(html, { ADD_TAGS: ['svg', 'rect', 'line', 'path', 'text'], ADD_ATTR: ['viewBox', 'xmlns', 'role', 'aria-label', 'text-anchor', 'font-size'] });
  return html;
}
