// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { toast } from '../app/core.js';
import { openCustomModel } from './picker.js';
import { createSession } from './session.js';
import { appendError, scrollDownSoft } from './transcript.js';
import { el, fmtTok } from './util.js';

/* ---------------- built-in slash commands ---------------- */

const COMPACT_PROMPT = 'Summarize this conversation so far as a handoff brief for a fresh session: project state, key decisions, files changed, open tasks, and next steps. Be dense and concrete. Reply with ONLY the brief.';

// In-place compaction: the engine's own /compact summarizes the earlier
// turns into the SAME session, so the chat, its tab and its tools carry on.
export async function doCompact(chat, focus) {
  if (!chat.alive) return;
  if (chat.busy) { toast('Wait for the current turn to finish, then compact', 'err'); return; }
  chat.msgs.querySelector('.chat-empty')?.remove();
  chat.msgs.appendChild(el('div', 'sys-note', '✂ compacting this conversation in place…'));
  scrollDownSoft(chat);
  if (chat.compactBtn) chat.compactBtn.disabled = true;
  try {
    const r = await ccx.invoke('chat:send', { id: chat.id, text: '/compact' + (focus ? ' ' + focus : '') });
    if (!r || !r.ok) appendError(chat, 'Could not compact: ' + ((r && r.error) || 'session not running'));
  } catch (e) {
    appendError(chat, 'Could not compact: ' + ((e && e.message) || e));
  } finally {
    if (chat.compactBtn) chat.compactBtn.disabled = false;   // a rejected invoke used to strand it disabled
  }
}

// The old behaviour, kept as /handoff: a brief, then a fresh session.
async function doHandoff(chat) {
  if (!chat.alive) return;
  chat.compacting = true;
  chat.msgs.querySelector('.chat-empty')?.remove();
  chat.msgs.appendChild(el('div', 'sys-note', '✂ handoff — asking for a brief, then continuing in a fresh session…'));
  scrollDownSoft(chat);
  try {
    const r = await ccx.invoke('chat:send', { id: chat.id, text: COMPACT_PROMPT });
    if (!r || !r.ok) {
      // Drop compacting or the NEXT ordinary result is misread as the brief
      // and spawns a session nobody asked for.
      chat.compacting = false;
      appendError(chat, 'Could not hand off: ' + ((r && r.error) || 'session not running'));
    }
  } catch (e) {
    chat.compacting = false;
    appendError(chat, 'Could not hand off: ' + ((e && e.message) || e));
  }
}

export function handleBuiltin(chat, text) {
  const cmd = text.split(/\s/)[0];
  if (cmd === '/compact') { doCompact(chat, text.slice(cmd.length).trim()); return true; }
  if (cmd === '/handoff') { doHandoff(chat); return true; }
  if (cmd === '/clear') {
    createSession({ cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode });
    toast('Fresh session opened (old one stays in History)');
    return true;
  }
  if (cmd === '/cost') {
    const r = chat.lastResult;
    toast(r && typeof r.total_cost_usd === 'number'
      ? `Cost so far: $${r.total_cost_usd.toFixed(4)} · ${r.num_turns} turns · ${fmtTok((r.usage || {}).input_tokens || 0)} in / ${fmtTok((r.usage || {}).output_tokens || 0)} out`
      : 'No usage yet this session.', 'ok');
    return true;
  }
  if (cmd === '/model') { openCustomModel(chat); return true; }
  if (cmd === '/review') {
    const focus = text.slice(cmd.length).trim();
    chat.composer.value = 'Review the current changes' + (focus ? ' focusing on ' + focus : '') + ': run git diff, identify bugs, risks, missing tests, and style issues; report findings as a numbered list with file:line references.';
    setTimeout(() => send(), 0);
    return true;
  }
  if (PANE_COMMANDS[cmd] === 'tasks') {   // /context: the Overview is always on screen; refresh it
    if (window.renderOverview) window.renderOverview();
    return true;
  }
  if (PANE_COMMANDS[cmd]) {
    const k = document.querySelector('#split-kind');
    if (k) { k.value = PANE_COMMANDS[cmd]; k.dispatchEvent(new Event('change')); }
    if (window.toggleSplit && !document.querySelector('#main.split')) window.toggleSplit(true);
    return true;
  }
  if (cmd === '/attach') { chat.attachBtn.click(); return true; }
  if (cmd === '/status') {
    toast('model ' + (chat.model || 'default') + ' · mode ' + chat.mode + ' · ' + (chat.cwd || ''), 'ok');
    return true;
  }
  if (cmd === '/help') {
    toast('Built-ins: /compact · /handoff · /clear · /cost · /model · /review · /attach · /context · /status · /files · /changes · /diff · /terminal · /preview · /help — every other /command runs in the engine', '');
    return true;
  }
  return false; // engine-side command (skills, plugins, custom)
}

/* ---------------- slash palette ---------------- */

// Handled by cce itself, so they work before the engine has said anything.
const OWN_SLASH = [
  { name: 'compact', description: 'Summarise the conversation and carry on in a fresh session' },
  { name: 'clear', description: 'Start a fresh session in this folder' },
  { name: 'cost', description: 'Tokens and cost so far' },
  { name: 'model', description: 'Switch model' },
  { name: 'help', description: 'What cce can do here' },
  { name: 'attach', description: 'Attach files (any type) to this message' },
  { name: 'context', description: 'Show the context window breakdown' },
  { name: 'status', description: 'Model, mode and folder of this chat' },
  { name: 'files', description: 'Open the Files tab' },
  { name: 'changes', description: 'Open the Changes tab' },
  { name: 'diff', description: 'Open the last edit diff' },
  { name: 'terminal', description: 'Open a terminal in this folder' },
  { name: 'preview', description: 'Open the Preview tab' },
];

const PANE_COMMANDS = { '/context': 'tasks', '/files': 'files', '/changes': 'changes', '/diff': 'diff', '/terminal': 'terminal', '/preview': 'preview' };

/**
 * Every command the session offers, with descriptions. The engine only lists
 * them in its first reply, so a fresh chat showed nothing for "/": ask the
 * session directly instead, once.
 */
async function loadSlashCommands(chat) {
  if (chat.slashCatalog) return chat.slashCatalog;
  if (!chat.slashLoading) {
    chat.slashLoading = (async () => {
      let live = [];
      try {
        const r = await ccx.invoke('chat:commands', { id: chat.id });
        if (r && r.ok) live = (r.commands || []).map(c => (typeof c === 'string' ? { name: c } : c));
      } catch { /* fall back to the init list */ }
      if (!live.length) live = (chat.commands || []).map(name => ({ name }));
      const seen = new Set();
      chat.slashCatalog = OWN_SLASH.concat(live).filter(c => c && c.name && !seen.has(c.name) && seen.add(c.name));
      chat.slashLoading = null;
      return chat.slashCatalog;
    })();
  }
  return chat.slashLoading;
}

export async function maybeSlash(chat) {
  const v = chat.composer.value;
  if (!(v.startsWith('/') && !v.includes(' '))) return hideSlash(chat);
  const all = await loadSlashCommands(chat);
  // The user may have typed on while the list loaded.
  const now = chat.composer.value;
  if (!(now.startsWith('/') && !now.includes(' '))) return hideSlash(chat);
  const q = now.slice(1).toLowerCase();
  const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
  const contains = q ? all.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : [];
  chat.slashItems = starts.concat(contains).slice(0, 24);
  if (!chat.slashItems.length) return hideSlash(chat);
  if (chat.slashIdx < 0 || chat.slashIdx >= chat.slashItems.length) chat.slashIdx = 0;
  renderSlash(chat);
}

function renderSlash(chat) {
  chat.slash.innerHTML = '';
  chat.slashItems.forEach((c, i) => {
    const item = el('div', 'slash-item' + (i === chat.slashIdx ? ' sel' : ''));
    item.appendChild(el('span', 'slash-name', '/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : '')));
    if (c.description) item.appendChild(el('span', 'slash-desc', c.description));
    item.addEventListener('mousedown', (e) => { e.preventDefault(); chat.slashIdx = i; applySlash(chat); });
    chat.slash.appendChild(item);
  });
  chat.slash.classList.remove('hidden');
}

export function moveSlash(chat, d) {
  if (!chat.slashItems.length) return;
  chat.slashIdx = (chat.slashIdx + d + chat.slashItems.length) % chat.slashItems.length;
  renderSlash(chat);
}

export function applySlash(chat) {
  const c = chat.slashItems[chat.slashIdx >= 0 ? chat.slashIdx : 0];
  if (c) { chat.composer.value = '/' + c.name + ' '; chat.composer.focus(); }
  hideSlash(chat);
}

export function hideSlash(chat) { chat.slash.classList.add('hidden'); chat.slashIdx = -1; }
