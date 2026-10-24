// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.

export const chats = new Map();

 // id -> chat view state

// A reply that shows a fenced example inside a fenced block (a ```markdown
// block holding ```pine) closes early at the first inner fence, so the rest of
// the block renders as loose text. Lengthen the outer fence past the inner ones.
export function fixNestedFences(text) {
  if (!text || !text.includes('```')) return text;
  const open = /^ {0,3}(`{3,})[^`\s]/;      // a fence with an info string
  const bare = /^ {0,3}(`{3,})\s*$/;        // a bare fence: closes
  const plain = /^ {0,3}(`{3,})[^`]*$/;     // any opening fence
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(plain);
    if (!m) { i++; continue; }
    const start = i;
    let depth = 0, longest = m[1].length, end = -1, nested = false;
    for (let j = i + 1; j < lines.length; j++) {
      const o = lines[j].match(open);
      if (o && !bare.test(lines[j])) { depth++; nested = true; longest = Math.max(longest, o[1].length + 1); continue; }
      if (bare.test(lines[j])) { if (depth === 0) { end = j; break; } depth--; }
    }
    if (end < 0) break;                      // still streaming: leave it alone
    if (nested) {
      const ticks = '`'.repeat(longest);
      lines[start] = lines[start].replace(/`{3,}/, ticks);
      lines[end] = lines[end].replace(/`{3,}/, ticks);
    }
    i = end + 1;
  }
  return lines.join('\n');
}

export const md = (text) => {
  try {
    let html = DOMPurify.sanitize(marked.parse(fixNestedFences(text || ''), { breaks: true, gfm: true }));
    // collapse runs of empty rules (some relays pad replies with '---' lines)
    html = html.replace(/(?:<hr\s*\/?>\s*(?:<p>\s*<\/p>\s*)*){3,}/g, '<hr>');
    return html;
  } catch {
    // Escaped text, not raw: the return value is assigned to innerHTML, so
    // returning the bare string was an injection path when marked/DOMPurify
    // were unavailable. #7
    return esc(text || '');
  }
};

// Reasoning the model wrote into its reply rather than the thinking channel.
// Shared with the proxy (src/shared/think.js) — the two must agree on the cut.
export const { splitThink } = CCEThink;

// Real HTML escaping. The old version was String(s), and it fed innerHTML with
// tool names — MCP tool names come from remote servers and are untrusted. #7
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export const basename = (p) => String(p || '~').replace(/\/+$/, '').split('/').pop() || p;

export const modeLabel = (m) => ({ default: 'accept edits', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto', bypassPermissions: 'yolo' }[m] || m);

export const fmtAge = (ms) => {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
};

export const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

/* ---------------- permissions ---------------- */

export const fmtDur = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
