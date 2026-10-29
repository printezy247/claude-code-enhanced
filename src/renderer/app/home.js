// The blank home page shown when no chat is open: recent folders, "Open
// folder…", "New chat here" and resume-latest, the way the desktop app opens.
// It used to boot straight into a chat rooted at ~. #E3
import { Chat } from '../chat/index.js';
import { $, el, state, toast } from './core.js';
import { resumeLatest } from './tabs.js';

const RECENT_MAX = 6;

const short = (p) => String(p || '').replace(/^\/home\/[^/]+/, '~');
const base = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || p;

function start(cwd) {
  if (!cwd) return;
  // New chats run the CLI's own default; CCE providers are picked per chat.
  Chat.createSession({ cwd, cliDefault: true })
    .catch((err) => toast(String((err && err.message) || err), 'err'));
}

export async function openFolder() {
  const r = await ccx.invoke('dialog:pickDir', { defaultPath: state.settings && state.settings.defaultCwd });
  if (r && !r.canceled && r.path) start(r.path);
}

/** Folders with past chats, newest first, each once. */
async function recentFolders() {
  try {
    const r = await ccx.invoke('chats:index');
    const rows = ((r && r.sessions) || []).filter((s) => s && s.cwd).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    return [...new Set(rows.map((s) => s.cwd))].slice(0, RECENT_MAX);
  } catch { return []; }
}

async function paintRecent(list) {
  const folders = await recentFolders();
  list.textContent = '';
  if (!folders.length) { list.appendChild(el('div', 'home-none', 'No recent folders yet.')); return; }
  for (const cwd of folders) {
    const b = el('button', 'home-folder');
    b.type = 'button';
    b.dataset.cwd = cwd;
    b.title = 'New chat in ' + cwd;
    b.setAttribute('aria-label', 'New chat in ' + cwd);
    b.appendChild(el('span', 'home-folder-name', base(cwd)));
    b.appendChild(el('span', 'home-folder-path', short(cwd)));
    b.addEventListener('click', () => start(cwd));
    list.appendChild(b);
  }
}

/* The chats open when the app last stopped (quit or crash), by session id,
   so the home page can bring them back. #phase4 */
const OPEN_KEY = 'cce:openChats';
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function rememberOpenChats() {
  const tabs = window.__tabs;
  if (!tabs) return;
  const list = [...tabs.values()]
    // Engine chats are not Claude sessions: reopening them as one would fail.
    .filter((m) => m && m.kind === 'chat' && !m.engine && m.sessionId && m.cwd)
    .map((m) => ({ cwd: m.cwd, sessionId: m.sessionId }))
    .slice(0, 12);
  try { localStorage.setItem(OPEN_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
window.cceRememberOpenChats = rememberOpenChats;

function lastOpenChats() {
  try {
    const list = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.cwd === 'string' && SESSION_ID.test(String(x.sessionId))) : [];
  } catch { return []; }
}

async function reopen(list) {
  for (const x of list) {
    try { await Chat.createSession({ cwd: x.cwd, resume: x.sessionId }); }
    catch (err) { toast(String((err && err.message) || err), 'err'); }
  }
}

/** True while no chat or terminal pane is open. */
const empty = () => !document.querySelector('#terminals > .chat-pane, #terminals > .term-pane');

function sync(home) {
  const was = home.hidden;
  home.hidden = !empty();
  rememberOpenChats();
  // Coming back after the last chat closed: the folder list may have changed.
  if (was && !home.hidden) paintRecent($('#home-recent'));
}

export function initHome() {
  const host = $('#terminals');
  if (!host || $('#home-blank')) return;
  const home = el('div', 'home-blank');
  home.id = 'home-blank';
  home.setAttribute('role', 'region');
  home.setAttribute('aria-label', 'Start');
  home.appendChild(el('h2', 'home-title', 'Start a conversation'));
  home.appendChild(el('p', 'home-sub', 'Pick a folder to work in. The chat runs with that folder as its project.'));

  const actions = el('div', 'home-actions');
  const open = el('button', 'btn primary', 'Open folder…');
  open.id = 'home-open'; open.type = 'button';
  open.addEventListener('click', () => openFolder().catch((err) => toast(String(err), 'err')));
  const cwd = (state.settings && state.settings.defaultCwd) || '~';
  const here = el('button', 'btn', 'New chat in ' + base(cwd));
  here.id = 'home-here'; here.type = 'button'; here.title = 'New chat in ' + cwd;
  here.addEventListener('click', () => start(cwd));
  const resume = el('button', 'btn ghost', 'Resume latest');
  resume.id = 'home-resume'; resume.type = 'button'; resume.title = 'Resume the latest conversation in ' + cwd;
  resume.addEventListener('click', () => resumeLatest());
  actions.append(open, here, resume);
  home.appendChild(actions);
  const last = lastOpenChats();
  if (last.length) {
    const restore = el('button', 'btn', 'Reopen ' + last.length + ' chat' + (last.length === 1 ? '' : 's') + ' from last time');
    restore.id = 'home-restore'; restore.type = 'button';
    restore.title = last.map((x) => short(x.cwd)).join('\n');
    restore.addEventListener('click', () => { restore.disabled = true; reopen(last); });
    actions.appendChild(restore);
  }

  home.appendChild(el('h3', 'home-recent-head', 'Recent folders'));
  const list = el('div', 'home-recent');
  list.id = 'home-recent';
  home.appendChild(list);
  host.appendChild(home);

  home.hidden = !empty();
  paintRecent(list);
  if (typeof MutationObserver === 'function') new MutationObserver(() => sync(home)).observe(host, { childList: true });
}
