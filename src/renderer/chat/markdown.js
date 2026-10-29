// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, loadMonaco } from '../app/core.js';
import { sendToTerminal, switchView } from '../app/tabs.js';
import { makePanel } from './panels.js';
import { codeFileName, isShellBlock, shellText } from './cmdmatch.js';
import { el } from './util.js';

/** navigator.clipboard is refused in some Electron states (focus, permissions); fall back to the main process. */
async function copyText(text) {
  const t = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; }
  } catch { /* fall through */ }
  try { const r = await ccx.invoke('clipboard:write', { text: t }); return !!(r && r.ok); } catch { return false; }
}

export function addCopyBtn(host, getText, cls) {
  const b = elIcon('button', 'copy-btn ' + (cls || ''), CCEIcons.svg('copy', 14));
  b.title = 'Copy';
  b.setAttribute('aria-label', 'Copy to clipboard');
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await copyText(getText());
    b.innerHTML = CCEIcons.svg(ok ? 'check' : 'close', 14);
    b.title = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { b.innerHTML = CCEIcons.svg('copy', 14); b.title = 'Copy'; }, 1200);
  });
  host.appendChild(b);
}

/** Language label on the left, Wrap and Save on the right. Copy stays where it was. */
function addCodeHeader(pre, code, plain) {
  const m = /(?:^|\s)language-([\w+#-]+)/.exec(code.className || '');
  const lang = m ? m[1] : '';
  const head = el('div', 'code-head');
  head.appendChild(el('span', 'code-lang', lang || 'text'));
  const wrap = el('button', 'code-act', 'Wrap');
  wrap.type = 'button';
  wrap.setAttribute('aria-pressed', 'false');
  wrap.addEventListener('click', () => { const on = pre.classList.toggle('code-wrap'); wrap.setAttribute('aria-pressed', String(on)); });
  const save = el('button', 'code-act', 'Save');
  save.type = 'button';
  save.title = 'Save as ' + codeFileName(lang);
  save.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([plain], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = codeFileName(lang);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  head.appendChild(wrap);
  head.appendChild(save);
  if (isShellBlock(lang, plain)) {
    const term = el('button', 'code-act', 'Send to terminal');
    term.type = 'button';
    term.title = 'Paste into a terminal tab. It is not run until you press Enter.';
    term.addEventListener('click', async () => {
      const ok = await sendToTerminal(shellText(plain));
      term.textContent = ok ? 'Sent' : 'No terminal';
      setTimeout(() => { term.textContent = 'Send to terminal'; }, 1500);
    });
    head.insertBefore(term, wrap);
  }
  pre.insertBefore(head, pre.firstChild);
}

export function enhanceMarkdown(container, rawText) {
  addCopyBtn(container, () => rawText, 'msg-copy');
  container.querySelectorAll('pre').forEach(pre => {
    // Take the text BEFORE the copy button is added and before highlighting:
    // Monaco's colorized HTML uses &nbsp; for spaces and <br> for line breaks,
    // so reading textContent afterwards pasted odd spaces and no newlines.
    let code = pre.querySelector('code');
    const plain = code ? code.textContent : pre.textContent;
    // Highlighting replaces innerHTML, so it must never target the <pre>
    // itself — that would also destroy the copy button living inside it. A
    // bare <pre> gets a <code> wrapper first. #54
    if (!code) {
      code = document.createElement('code');
      code.textContent = plain;
      pre.textContent = '';
      pre.appendChild(code);
    }
    colorizeCode(pre, code, plain);
    addCodeHeader(pre, code, plain);
    addCopyBtn(pre, () => plain, 'pre-copy');
  });
}

// Monaco paints with whichever theme is current, and its default is the light one:
// black text on cce's dark code blocks. Follow the app theme instead.
export const monacoThemeName = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark');

// Monaco is already vendored for the diff editor, so syntax highlighting
// costs no extra dependency. Falls back to plain text when unavailable. #35
function colorizeCode(pre, code, plain) {
  if (!window.monaco || !window.monaco.editor) {
    // Monaco loads on first use; colour the block once it is in.
    loadMonaco().then((m) => { if (m && typeof m.editor.colorize === 'function') colorizeCode(pre, code, plain); });
    return;
  }
  if (typeof window.monaco.editor.colorize !== 'function') return;
  const text = plain != null ? plain : (code.textContent || '');
  if (!text.trim() || text.length > 20000) return;
  try {
    if (typeof window.monaco.editor.setTheme === 'function') window.monaco.editor.setTheme(monacoThemeName());
    const lang = detectLang(code);
    Promise.resolve(window.monaco.editor.colorize(text, lang, { tabSize: 2 }))
      .then((html) => { if (html && code.textContent === text) code.innerHTML = html; })
      .catch(() => { /* leave plain */ });
  } catch { /* leave plain */ }
}

const LANG_BY_CLASS = {
  'language-js': 'javascript', 'language-javascript': 'javascript',
  'language-ts': 'typescript', 'language-typescript': 'typescript',
  'language-py': 'python', 'language-python': 'python',
  'language-bash': 'shell', 'language-sh': 'shell', 'language-shell': 'shell',
  'language-json': 'json', 'language-yaml': 'yaml', 'language-yml': 'yaml',
  'language-html': 'html', 'language-css': 'css', 'language-sql': 'sql',
  'language-rust': 'rust', 'language-rs': 'rust', 'language-go': 'go',
};

function detectLang(code) {
  const cls = (code.className || '') + ' ' + [...(code.parentElement?.classList || [])].join(' ');
  for (const [needle, lang] of Object.entries(LANG_BY_CLASS)) {
    if (cls.includes(needle)) return lang;
  }
  const first = (code.textContent || '').trim().split('\n')[0] || '';
  if (/^#!.*\b(bash|sh)\b/.test(first)) return 'shell';
  if (/^\s*[{[]/.test(first)) return 'json';
  return 'plaintext';
}

export function wireRunMenu(chat) {
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; } };
  // The button lives in the overflow menu now; keep a stable handle so both
  // the menu item and the Ctrl+K palette can trigger it.
  const btn = el('button', 'chat-btn', '▶');
  btn.title = 'Run build / test scripts in a terminal tab';
  btn.setAttribute('aria-label', 'Run build or test scripts in a terminal tab');
  btn.style.display = 'none';
  chat.pane.appendChild(btn);
  chat.runBtn = btn;
  btn.addEventListener('click', async () => {
    if (menu && menu.isConnected) return close();
    menu = makePanel(chat, 'chat-run-menu', 'play', 'Run in a terminal tab',
      'Opens a terminal tab in this folder and runs the command there.');
    const list = el('div', 'skills-list');
    menu.appendChild(list);
    const add = (label, cmd) => {
      const row = el('div', 'skill-row');
      row.appendChild(el('code', '', cmd));
      row.appendChild(el('span', 'skill-desc', label));
      const b = el('button', 'btn small', 'run');
      b.addEventListener('click', () => {
        window.createSession({ cwd: chat.cwd, type: 'shell', initText: cmd === '$SHELL' ? '' : cmd + '\r' });
        switchView('terminal');
        close();
      });
      list.appendChild(row);
    };
    const r = await ccx.invoke('project:scripts', { cwd: chat.cwd });
    add('interactive shell', '$SHELL');
    for (const s of (r.ok ? r.scripts : [])) add('package.json script', 'npm run ' + s);
    if (r.ok && r.hasMakefile) { add('makefile default target', 'make'); add('makefile test target', 'make test'); }
    menu.appendChild(list);
    chat.pane.appendChild(menu);
  });
}
