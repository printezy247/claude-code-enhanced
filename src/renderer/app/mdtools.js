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

// ---- mermaid flowcharts (the subset people actually write) ------------------
// graph TD / flowchart LR, nodes A[text] B(text) C{text} D((text)), arrows
// --> --- ==> -.->, labels -->|text| and -- text -->. Anything else in a
// mermaid fence (sequence diagrams, gantt…) is not drawn: the source is shown
// with a note, never a half-right picture.

// Each opener is paired with its own closer, so a label may hold other brackets:
// A[Fix (urgent)] and B{x > (y)?} read whole. Longer openers are tried first.
const ID_RE = /^([A-Za-z_][\w-]*)/;
const SHAPE_RES = [
  [/^\(\(("[^"]*"|.*?)\)\)/, 'circle'],
  [/^\(\[("[^"]*"|.*?)\]\)/, 'pill'],
  [/^\[\[("[^"]*"|.*?)\]\]/, 'box'],
  [/^\[("[^"]*"|.*?)\]/, 'box'],
  [/^\(("[^"]*"|.*?)\)/, 'round'],
  [/^\{("[^"]*"|.*?)\}/, 'diamond'],
  [/^>("[^"]*"|.*?)\]/, 'box'],
];
/** One node at the start of `text`: { id, shape?, label?, length } or null. */
function readNode(text) {
  const idm = ID_RE.exec(text);
  if (!idm) return null;
  const after = text.slice(idm[0].length);
  for (const [re, shape] of SHAPE_RES) {
    const sm = re.exec(after);
    if (sm) return { id: idm[1], shape, label: sm[1], length: idm[0].length + sm[0].length };
  }
  return { id: idm[1], length: idm[0].length };
}
const ARROW_LABELED = /^--\s+([^>]+?)\s+-->/;
const ARROW_PLAIN = /^(-->|---|==>|-\.->|-\.-|===)/;

/** Parse the body of a ```mermaid fence. Returns { dir, nodes, edges } or { unsupported }. */
export function parseMermaid(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('%%'))) i++;
  const head = (lines[i] || '').trim();
  const m = /^(graph|flowchart)\s*(TD|TB|BT|LR|RL)?\s*;?$/i.exec(head);
  if (!m) return { unsupported: head.split(/\s+/)[0] || 'empty diagram' };
  let dir = (m[2] || 'TD').toUpperCase();
  if (dir === 'TB') dir = 'TD';
  const nodes = new Map();
  const edges = [];
  const labelOf = (raw) => String(raw || '').replace(/^"|"$/g, '').replace(/<br\s*\/?>/gi, ' ').trim();
  const touch = (id, shape, label) => {
    const cur = nodes.get(id) || { id, label: id, shape: 'box' };
    if (shape !== undefined) { cur.shape = shape; cur.label = labelOf(label) || id; }
    nodes.set(id, cur);
    return id;
  };
  const statements = lines.slice(i + 1).flatMap((l) => l.split(';'));
  for (const raw of statements) {
    let rest = raw.trim();
    if (!rest || rest.startsWith('%%') || /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/.test(rest)) continue;
    let prev = null;
    let pendingArrow = null;
    let guard = 0;
    while (rest && guard++ < 50) {
      const nm = readNode(rest);
      if (!nm) break;
      const id = touch(nm.id, nm.shape, nm.label);
      rest = rest.slice(nm.length).trimStart();
      if (prev !== null && pendingArrow) edges.push({ from: prev, to: id, label: pendingArrow.label, dashed: pendingArrow.dashed });
      prev = id;
      pendingArrow = null;
      let am = ARROW_LABELED.exec(rest);
      let label = '';
      let dashed = false;
      if (am) { label = labelOf(am[1]); rest = rest.slice(am[0].length).trimStart(); }
      else if ((am = ARROW_PLAIN.exec(rest))) {
        dashed = am[1].includes('.');
        rest = rest.slice(am[0].length).trimStart();
        const lm = /^\|([^|]*)\|/.exec(rest);
        if (lm) { label = labelOf(lm[1]); rest = rest.slice(lm[0].length).trimStart(); }
      } else break;
      pendingArrow = { label, dashed };
    }
  }
  const list = [...nodes.values()];
  if (!list.length) return { unsupported: 'empty diagram' };
  return { dir, nodes: list, edges };
}

/** Layer the nodes by the longest path from a start node; back edges (cycles) are ignored for layering. */
function layers(graph) {
  const out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from).push(e.to);
  const state = new Map();     // 1 = on the DFS stack, 2 = done
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const to of out.get(id)) {
      if (state.get(to) === 1) back.add(id + '>' + to);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const n of graph.nodes) if (!state.has(n.id)) visit(n.id);
  const level = new Map(graph.nodes.map((n) => [n.id, 0]));
  // relax edges in passes: at most N passes settle any acyclic graph
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    for (const e of graph.edges) {
      if (!out.has(e.from) || !out.has(e.to) || back.has(e.from + '>' + e.to)) continue;
      if (level.get(e.to) < level.get(e.from) + 1) { level.set(e.to, level.get(e.from) + 1); changed = true; }
    }
    if (!changed) break;
  }
  return level;
}

/** Draw a parsed flowchart as SVG: layers across (LR/RL) or down (TD/BT). */
export function mermaidSvg(graph) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const level = layers(graph);
  const rows = [];
  for (const n of graph.nodes) (rows[level.get(n.id)] = rows[level.get(n.id)] || []).push(n);
  const horizontal = graph.dir === 'LR' || graph.dir === 'RL';
  const H = 38, PADX = 14, GAPL = horizontal ? 70 : 46, GAPN = 24;
  const sizeOf = (n) => ({ w: Math.max(84, Math.min(240, n.label.length * 7.4 + PADX * 2)), h: H });
  const pos = new Map();
  let crossMax = 0;
  const spans = rows.map((row) => (row || []).reduce((a, n) => a + (horizontal ? sizeOf(n).h : sizeOf(n).w) + GAPN, -GAPN));
  crossMax = Math.max(0, ...spans);
  let along = 8;
  const layerW = rows.map((row) => Math.max(0, ...(row || []).map((n) => (horizontal ? sizeOf(n).w : sizeOf(n).h))));
  rows.forEach((row, li) => {
    if (!row) return;
    let cross = 8 + (crossMax - spans[li]) / 2;
    for (const n of row) {
      const { w, h } = sizeOf(n);
      pos.set(n.id, horizontal ? { x: along, y: cross, w, h } : { x: cross, y: along, w, h });
      cross += (horizontal ? h : w) + GAPN;
    }
    along += layerW[li] + GAPL;
  });
  if (graph.dir === 'BT' || graph.dir === 'RL') {
    const total = along - GAPL + 8;
    for (const p of pos.values()) { if (graph.dir === 'BT') p.y = total - p.y - p.h; else p.x = total - p.x - p.w; }
  }
  const width = Math.max(...[...pos.values()].map((p) => p.x + p.w)) + 8;
  const height = Math.max(...[...pos.values()].map((p) => p.y + p.h)) + 8;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" role="img" aria-label="flowchart">`];
  parts.push('<defs><marker id="mm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>');
  const anchor = (p, toward) => {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const dx = toward.x + toward.w / 2 - cx, dy = toward.y + toward.h / 2 - cy;
    if (Math.abs(dx) * p.h > Math.abs(dy) * p.w) return { x: cx + Math.sign(dx) * p.w / 2, y: cy };
    return { x: cx, y: cy + Math.sign(dy || 1) * p.h / 2 };
  };
  for (const e of graph.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    if (a === b) {   // a loop on one node
      parts.push(`<path d="M ${a.x + a.w} ${a.y + 8} h 14 v ${a.h - 16} h -14" fill="none" stroke="currentColor" stroke-width="1.6" marker-end="url(#mm-arrow)"/>`);
      continue;
    }
    const p1 = anchor(a, b), p2 = anchor(b, a);
    parts.push(`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="currentColor" stroke-width="1.6"${e.dashed ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#mm-arrow)"/>`);
    if (e.label) parts.push(`<text x="${(p1.x + p2.x) / 2 + 4}" y="${(p1.y + p2.y) / 2 - 4}" font-size="11" fill="currentColor">${esc(e.label)}</text>`);
  }
  for (const n of graph.nodes) {
    const p = pos.get(n.id);
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8"';
    if (n.shape === 'diamond') parts.push(`<polygon points="${cx},${p.y} ${p.x + p.w},${cy} ${cx},${p.y + p.h} ${p.x},${cy}" ${stroke}/>`);
    else if (n.shape === 'circle') parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${p.w / 2}" ry="${p.h / 2}" ${stroke}/>`);
    else parts.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${n.shape === 'pill' ? p.h / 2 : n.shape === 'round' ? 12 : 4}" ${stroke}/>`);
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="13" fill="currentColor">${esc(n.label)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

// ---- callouts: > [!NOTE] and the collapsible > [!NOTE]- / > [!NOTE]+ ------------

const CALLOUTS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

/**
 * Turn blockquotes that start with [!KIND] into callout boxes. `-` after the
 * kind starts it collapsed and `+` open (a <details>); text after it is the title.
 * Works on marked's HTML, before sanitising.
 */
export function renderCallouts(html) {
  return String(html || '').replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([+-]?)[ \t]*([^\n<]*)(?:\n|<br\s*\/?>)?([\s\S]*?)<\/blockquote>/gi, (all, kind, fold, title, body) => {
    const k = kind.toLowerCase();
    const heading = (title || '').trim() || CALLOUTS[k];
    const inner = '<div class="md-callout-body"><p>' + body;
    if (fold) {
      return `<details class="md-callout md-callout-${k}"${fold === '+' ? ' open' : ''}><summary>${heading}</summary>${inner}</div></details>`;
    }
    return `<div class="md-callout md-callout-${k}"><div class="md-callout-title">${heading}</div>${inner}</div></div>`;
  });
}

/**
 * Preview pipeline: markdown → safe HTML, with ```flow and ```mermaid (flowchart
 * subset) fences swapped for SVG, [!NOTE]-style callouts boxed, and checklist lines rendered as real checkboxes (toggling goes through the
 * source text, not the DOM). marked/DOMPurify are page globals.
 */
export function renderPreview(text, { marked, DOMPurify } = {}) {
  const src = String(text || '');
  const flowBlocks = [];
  const mermaidBlocks = [];
  const withoutFlows = src.replace(/```flow\n([\s\S]*?)```/g, (_, body) => {
    flowBlocks.push(body);
    return '\n\n<!--cce-flow-' + (flowBlocks.length - 1) + '-->\n\n';
  }).replace(/```mermaid\n([\s\S]*?)```/g, (_, body) => {
    mermaidBlocks.push(body);
    return '\n\n<!--cce-mermaid-' + (mermaidBlocks.length - 1) + '-->\n\n';
  });
  let html;
  if (marked && typeof marked.parse === 'function') html = marked.parse(withoutFlows);
  else html = '<pre>' + withoutFlows.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  html = html.replace(/<!--cce-flow-(\d+)-->/g, (_, i) => {
    const svg = flowSvg(parseFlow(flowBlocks[Number(i)] || ''));
    return '<div class="md-flow">' + svg + '</div>';
  });
  html = html.replace(/<!--cce-mermaid-(\d+)-->/g, (_, i) => {
    const body = mermaidBlocks[Number(i)] || '';
    const g = parseMermaid(body);
    if (g.unsupported) {
      const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return '<div class="md-mermaid-note">The preview draws flowcharts only (graph / flowchart). “' + esc(g.unsupported) + '” is shown as source.</div><pre><code>' + esc(body) + '</code></pre>';
    }
    return '<div class="md-flow">' + mermaidSvg(g) + '</div>';
  });
  html = renderCallouts(html);
  if (DOMPurify && typeof DOMPurify.sanitize === 'function') html = DOMPurify.sanitize(html, { ADD_TAGS: ['svg', 'rect', 'line', 'path', 'text', 'defs', 'marker', 'polygon', 'ellipse'], ADD_ATTR: ['viewBox', 'xmlns', 'role', 'aria-label', 'text-anchor', 'font-size', 'marker-end', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'points', 'stroke-dasharray', 'rx', 'ry', 'cx', 'cy'] });
  return html;
}
