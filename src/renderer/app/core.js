// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.

export const TermCtor = window.Terminal;

export const FitCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;

export const LinksCtor = (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) || window.WebLinksAddon;

export const $ = (sel) => document.querySelector(sel);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * An element whose content is trusted markup (an inline SVG from CCEIcons).
 *
 * `el()` assigns textContent on purpose — that is what makes it safe to pass
 * model and server strings. Icons are the one thing that must be parsed, so they
 * get their own constructor instead of turning `el()` into an innerHTML helper
 * for everyone. #54
 */
export function elIcon(tag, cls, markup) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.innerHTML = String(markup || '');
  return n;
}

export function toast(msg, kind = '', action) {
  const t = el('div', 'toast ' + kind, msg);
  if (action && action.label) {
    const b = el('button', 'toast-action', action.label);
    b.addEventListener('click', () => { t.remove(); action.onClick(); });
    t.appendChild(b);
  }
  // An error toast is the app telling you something went wrong; a screen-reader
  // user was never told, because the toast area was not a live region. #53
  if (kind === 'err') t.setAttribute('role', 'alert');
  $('#toasts').appendChild(t);
  const life = action ? 6000 : 3600;
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, life);
  setTimeout(() => t.remove(), life + 400);
}

/**
 * Text input dialog. Electron does not implement window.prompt (it throws), so
 * Rename and re-ask silently did nothing. Resolves to the text, or null.
 */
window.askText = function askText(title, value = '', { multiline = false, okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', '', title));
    const field = el(multiline ? 'textarea' : 'input', 'ask-field');
    if (multiline) field.rows = 6; else field.type = 'text';
    field.value = value;
    field.setAttribute('aria-label', title);
    modal.appendChild(field);
    const row = el('div', 'modal-actions');
    const cancel = el('button', 'btn', 'Cancel');
    const ok = el('button', 'btn primary', okLabel);
    row.appendChild(cancel); row.appendChild(ok);
    modal.appendChild(row);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const done = (v) => { overlay.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(field.value));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); done(field.value); }
    });
    setTimeout(() => { field.focus(); field.select(); }, 0);
  });
};

// Real HTML escaping: several call sites interpolate provider- and
// server-supplied strings into innerHTML, and MCP server names are untrusted. #7
/**
 * Fill every <span data-icon="name"> in the static markup with its SVG. The
 * HTML stays readable and the icon set stays in one file; emoji cannot do this
 * because they cannot inherit colour or follow the theme. #54
 */
export function paintDeclaredIcons(root) {
  const scope = root || document;
  for (const host of scope.querySelectorAll('[data-icon]')) {
    if (host.dataset.iconPainted) continue;
    const svg = CCEIcons.svg(host.dataset.icon);
    if (!svg) continue;
    host.innerHTML = svg;
    host.dataset.iconPainted = '1';
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const state = {
  info: null,
  settings: null,
  providers: { presets: [], catalog: [], modelsdev: null, instances: [], defaultUid: null },
  leanPresets: [],
  leanAllTools: [],
  theme: 'dark',
  connectorPresets: [],
  sessions: new Map(),   // id -> { term, fit, tabEl, pane, alive, label, cwd, provider }
  activeId: null,
  view: 'terminal',
  booting: true,
};

/**
 * Settings > "Show thinking" also controls whether reasoning summaries are
 * shown in chat. A body class keeps it live: every thought block, streamed or
 * replayed, hides at once — and reappears when the box is ticked again.
 */
export function applyThinkingDisplay() {
  const hidden = !!(state.settings && state.settings.showThinking === false);
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('hide-reasoning', hidden);
  }
}

export const TERM_THEME = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ff9a3c',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(255,154,60,0.32)',
  black: '#0b0b0b', red: '#d2626a', green: '#7dc98f', yellow: '#e0af68',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c8c8d4',
  brightBlack: '#61627a', brightRed: '#e8878d', brightGreen: '#9ddba7',
  brightYellow: '#eecb8b', brightBlue: '#9cc2ff', brightMagenta: '#cdb4fc',
  brightCyan: '#a8dcff', brightWhite: '#ffffff',
};

/* ================= Monaco, on first use ================= */

let monacoLoading = null;
/**
 * The diff editor and code-block colours come from Monaco, a 4.6 MB bundle
 * that every start used to parse before the window could paint. It loads the
 * first time a diff or code block asks for it. Resolves with window.monaco,
 * or null when the bundle is missing (fresh clone before `npm run vendor`),
 * so callers keep their plain-text fallback.
 */
export function loadMonaco() {
  if (window.monaco && window.monaco.editor) return Promise.resolve(window.monaco);
  if (monacoLoading) return monacoLoading;
  const add = (src) => new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = bad;
    document.head.appendChild(s);
  });
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'vendor/monaco.css';
  document.head.appendChild(css);
  monacoLoading = add('vendor/monaco-env.js')
    .then(() => add('vendor/monaco.js'))
    .then(() => {
      applyTheme(state.theme);
      return (window.monaco && window.monaco.editor) ? window.monaco : null;
    }, () => null);
  return monacoLoading;
}

/* ================= theme (#47) ================= */

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  state.theme = t;
  // Code blocks and diffs are painted by Monaco; keep its theme in step with the app's.
  if (window.monaco && window.monaco.editor && typeof window.monaco.editor.setTheme === 'function') {
    window.monaco.editor.setTheme(t === 'light' ? 'vs' : 'vs-dark');
  }
}

window.applyTheme = applyTheme;

/**
 * Chat scrollbar: 'accent' (orange, see-through), 'hidden' or 'default'. An
 * attribute on <html> lets the stylesheet do the work, so it is live and the
 * same for every chat. The allowed values live in src/shared/uiprefs.js.
 */
export function applyScrollbar(mode) {
  const m = ['accent', 'hidden', 'default'].includes(mode) ? mode : 'accent';
  document.documentElement.setAttribute('data-scrollbar', m);
  return m;
}

export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export const basenameOf = (p) => String(p || '~').replace(/\/+$/, '').split('/').pop() || String(p || '');

  export function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
  }

export function fmtTokShort(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
