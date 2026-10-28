'use strict';
// cce:// deep links (item 24): one parser for the protocol the app registers.
// Shapes:  cce://chat/<id>       → open/resume that conversation
//          cce://view/<name>     → switch to a sidebar view (board, usage, ...)
//          cce://open?p=<path>   → open a project folder (path is URL-encoded)
// Anything else is 'unknown' - links never name a file to write or a shell to run.

const VIEWS = new Set(['conversations', 'board', 'usage', 'providers', 'connectors', 'settings']);

function parseCceUrl(url) {
  const s = String(url || '').trim();
  if (!/^cce:\/\//i.test(s)) return { action: 'unknown' };
  // '..' would normalize away inside new URL() and turn traversal into a
  // clean-looking segment; nothing here needs it, so reject it up front.
  if (s.includes('..')) return { action: 'unknown' };
  let rest;
  try {
    // URL() gives us decoding for free; the host is the first path segment.
    const u = new URL(s);
    rest = (u.host || '') + u.pathname;            // 'chat/abc123' style
  } catch { return { action: 'unknown' }; }
  const parts = rest.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts.length === 2 && parts[0] === 'chat') {
    const id = parts[1];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { action: 'unknown' };
    return { action: 'chat', id };
  }
  if (parts.length === 2 && parts[0] === 'view') {
    const view = String(parts[1]).toLowerCase();
    if (!VIEWS.has(view)) return { action: 'unknown' };
    return { action: 'view', view };
  }
  if (parts.length === 1 && parts[0] === 'open') {
    let p = '';
    try { p = new URL(s).searchParams.get('p') || ''; } catch { /* handled below */ }
    if (!p) return { action: 'unknown' };
    if (/[\x00-\x1f]/.test(p)) return { action: 'unknown' };   // no control characters in paths
    if (!/^(\/|~\/)/.test(p)) return { action: 'unknown' };    // absolute or home-relative only
    return { action: 'open', path: p };
  }
  return { action: 'unknown' };
}

module.exports = { parseCceUrl, VIEWS };
