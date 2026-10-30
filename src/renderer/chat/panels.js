// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { switchView } from '../app/tabs.js';
import { paletteKinds, paletteMode } from '../app/nav.js';
import { openChats } from './mentions-live.js';
import { OUTPUT_STYLES, parseEnv, redactEnv } from './chatopts.js';
import { autosize } from './composer.js';
import { INSTALL_CMD, renderHooks } from './events.js';
import { closeChat, createSession } from './session.js';
import { doCompact } from './slash.js';
import { scrollDownSoft } from './transcript.js';
import { basename, el, esc, fmtAge, md } from './util.js';
import { ProvidersUI } from '../providers/ui.js';
import { toggleMemoryPanel, maybeProbeMemory, collectMemoryProbe, maybeProbeSkill, collectSkillProbe, showPendingChip } from './panel-memory.js';
import { openPalette } from './panel-palette.js';
import { toggleSkillsPanel } from './panel-skills.js';
import { toggleMcpPanel } from './panel-mcp.js';
import { toggleHistoryPanel, toggleRewindPanel } from './panel-history.js';
import { openPlanViewer, showFind, updatePlanViewer } from './panel-plan.js';
import { editChatEnv, setOutputStyle, toggleBrowser } from './panel-opts.js';
export { maybeProbeMemory, collectMemoryProbe, maybeProbeSkill, collectSkillProbe, showPendingChip, openPalette, openPlanViewer, showFind, updatePlanViewer, setOutputStyle };

/* ---------------- side panels (one frame for all of them) ---------------- */

// Every ⋯ panel used to be a bare box: no title bar, no close button, and
// two could stack on top of each other. They now share one frame — title,
// close (✕ / Esc), and only one open at a time.
// Label, panel class, opener. Functions below are hoisted, so this can sit first.
const PANEL_TABS = [
  ['Skills', 'chat-skills-main', (c) => toggleSkillsPanel(c)],
  ['MCP', 'chat-mcp-panel', (c) => toggleMcpPanel(c)],
  ['Memory', 'chat-memory-panel', (c) => toggleMemoryPanel(c)],
  ['Rewind', 'chat-rewind-panel', (c) => toggleRewindPanel(c)],
  ['History', 'chat-history-panel', (c) => toggleHistoryPanel(c)],
];

export function makePanel(chat, cls, icon, title, hint) {
  chat.pane.querySelectorAll('.chat-skills-panel').forEach(p => p.remove());
  const panel = el('div', 'chat-skills-panel ' + cls);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  const head = el('div', 'panel-head-row');
  head.appendChild(elIcon('h4', '', (CCEIcons.svg(icon, 15) || '') + ' ' + esc(title)));
  const x = elIcon('button', 'panel-close', CCEIcons.svg('close', 14));
  x.title = 'Close (Esc)';
  x.setAttribute('aria-label', 'Close ' + title);
  x.addEventListener('click', () => panel.remove());
  head.appendChild(x);
  panel.appendChild(head);
  const here = PANEL_TABS.find(([, c]) => c === cls);
  if (here) {
    // One click to any sibling panel, no trip back through the ⋯ menu.
    const tabs = el('div', 'panel-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [label, c, open] of PANEL_TABS) {
      const b = el('button', 'panel-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(c === cls));
      if (c !== cls) b.addEventListener('click', () => open(chat));
      tabs.appendChild(b);
    }
    panel.appendChild(tabs);
  }
  if (hint) panel.appendChild(el('p', 'hint', hint));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); panel.remove(); chat.composer.focus(); }
  });
  return panel;
}

export const panelOpen = (chat, cls) => {
  const p = chat.pane.querySelector('.' + cls);
  if (p) { p.remove(); return true; }
  return false;
};

/* ---------------- header overflow menu (#33) ---------------- */

export function wireHeaderMenu(chat, forkConversation) {
  let menu = null;
  const away = (e) => { if (menu && !menu.contains(e.target) && !chat.moreBtn.contains(e.target)) close(); };
  const close = () => {
    if (!menu) return;
    menu.remove(); menu = null;
    chat.moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', away, true);
  };
  // `icon` is a name from the shared SVG set, not a glyph: it inherits
  // currentColor and is hidden from assistive tech. #54
  const item = (icon, label, run, { kbd, on } = {}) => {
    const b = el('button', 'chat-menu-item');
    b.setAttribute('role', 'menuitem');
    b.appendChild(elIcon('span', 'chat-menu-ico', CCEIcons.svg(icon, 15)));
    b.appendChild(el('span', 'cmi-label', label));
    if (on) b.appendChild(el('span', 'cmi-on', 'on'));
    if (kbd) b.appendChild(el('kbd', 'cmi-kbd', kbd));
    b.addEventListener('click', () => { close(); run(); });
    return b;
  };
  const section = (name) => menu.appendChild(el('div', 'chat-menu-sec', name));
  chat.moreBtn.setAttribute('aria-haspopup', 'menu');
  chat.moreBtn.addEventListener('click', () => {
    if (menu) return close();
    menu = el('div', 'chat-menu');
    menu.setAttribute('role', 'menu');
    const head = el('div', 'chat-menu-head');
    head.appendChild(el('span', '', 'Chat actions'));
    const x = elIcon('button', 'panel-close', CCEIcons.svg('close', 13));
    x.setAttribute('aria-label', 'Close menu');
    x.title = 'Close (Esc)';
    x.addEventListener('click', close);
    head.appendChild(x);
    menu.appendChild(head);

    section('This conversation');
    menu.appendChild(item('compress', 'Compact in place', () => doCompact(chat), { kbd: '/compact' }));
    menu.appendChild(item('search', 'Find in conversation', () => showFind(chat), { kbd: 'Ctrl+F' }));
    menu.appendChild(item('fork', 'Fork this conversation', forkConversation));
    section('Engine');
    for (const st of OUTPUT_STYLES) {
      menu.appendChild(item('pencil', 'Output style: ' + st.label, () => setOutputStyle(chat, st.id), { on: (chat.outputStyle || '') === st.id }));
    }
    menu.appendChild(item('gear', 'Environment variables…', () => editChatEnv(chat)));
    menu.appendChild(item('globe', 'Web browser (Lightpanda)', () => toggleBrowser(chat), { on: !!chat.browserOn }));
    menu.appendChild(item('undo', 'Rewind files', () => toggleRewindPanel(chat)));
    menu.appendChild(item('download', 'Export as markdown', async () => {
      if (!chat.sessionId) { toast('Nothing to export yet', 'err'); return; }
      const r = await ccx.invoke('chat:export', { cwd: chat.cwd, sessionId: chat.sessionId });
      if (r && r.ok && r.saved) toast('Saved ' + r.path, 'ok'); else if (r && !r.ok) toast(r.error, 'err');
    }));
    menu.appendChild(item('clock', 'Past conversations', () => toggleHistoryPanel(chat)));

    section('Tools & context');
    menu.appendChild(item('bolt', 'Skills, commands, agents, hooks', () => toggleSkillsPanel(chat)));
    menu.appendChild(item('plug2', 'MCP servers (live)', () => toggleMcpPanel(chat)));
    menu.appendChild(item('brain', 'Memory & rules', () => toggleMemoryPanel(chat)));
    menu.appendChild(item('list', 'Command palette', () => openPalette(chat), { kbd: 'Ctrl+K' }));

    section('Workspace');
    const splitOn = !!document.querySelector('#main.split');
    menu.appendChild(item('split', 'Tool panel (changes, files, terminal)', () => window.toggleSplit && window.toggleSplit(), { kbd: 'Alt+V', on: splitOn }));
    menu.appendChild(item('keyboard', 'Terminal tab in this folder', () => window.createSession({ cwd: chat.cwd, type: 'shell' })));
    menu.appendChild(item('play', 'Run build / test scripts', () => chat.runBtn.click()));
    if (chat.provider && chat.provider.baseUrl) {
      menu.appendChild(item('gear', 'Model manager (load / unload)',
        () => (window.ProvidersUI ? ProvidersUI.openLocalManager(chat.provider.baseUrl) : (window.openOllamaManager && window.openOllamaManager(chat.provider)))));
    }
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.chat-menu-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); chat.moreBtn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    const rect = chat.moreBtn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.right = Math.max(8, (window.innerWidth || 1200) - rect.right) + 'px';
    document.body.appendChild(menu);
    chat.moreBtn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    const first = menu.querySelector('.chat-menu-item');
    if (first) first.focus();
  });
}

/* ---------------- project / github chips ---------------- */

export async function renderProjectInfo(chat) {
  // A folder on another machine: this computer's git knows nothing about it.
  if (chat.ssh) return;
  try {
    const r = await ccx.invoke('git:info', { cwd: chat.cwd });
    if (!r.ok || !chat.projEl) return;
    // Chips added by other code (worktree, sandbox) carry .proj-extra and survive the redraw.
    const extras = [...chat.projEl.querySelectorAll('.proj-extra')];
    chat.projEl.innerHTML = '';
    const folder = elIcon('span', 'proj-chip', CCEIcons.svg('folder', 13) + ' ' + esc(basename(chat.cwd)));
    folder.title = chat.cwd + (r.remote ? '\nremote: ' + r.remote : '') + (r.branch ? '\nbranch: ' + r.branch : '');
    chat.projEl.appendChild(folder);
    if (r.repo) {
      const repo = el('span', 'proj-chip repo', '⎇ ' + r.repo);
      repo.title = 'Open github.com/' + r.repo;
      repo.addEventListener('click', () => ccx.invoke('shell:openExternal', { url: 'https://github.com/' + r.repo }));
      chat.projEl.appendChild(repo);
    }
    if (r.branch) chat.projEl.appendChild(el('span', 'proj-chip branch', r.branch));
    if (r.dirty) {
      const d = el('span', 'proj-chip dirty', '● ' + r.dirty + ' changed');
      d.title = r.dirty + ' uncommitted file(s) in this working tree';
      chat.projEl.appendChild(d);
    }
    for (const x of extras) chat.projEl.appendChild(x);
  } catch { /* git absent or not a repo — chips stay minimal */ }
}
