// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { toast } from '../app/core.js';
import { openCustomModel } from './picker.js';
import { createSession } from './session.js';
import { appendError, scrollDownSoft } from './transcript.js';
import { el, fmtTok } from './util.js';
import { applySlashToken, highlightParts, loadRecent, pushRecent, rankCommands, slashTokenAt, windowRange, SECTION_ORDER } from './cmdmatch.js';
import { ensurePanes, LIST_H, ROW_H, setPreview } from './preview.js';

import { parseLoop, parseGoal, parseBtw, saveGoal } from './loopgoal.js';
import { askBtw } from './btw.js';

/** Show (or clear, with '') the goal banner above the transcript and remember it for the folder. */
export function setGoal(chat, goal) {
  chat.goal = goal || '';
  saveGoal(chat.cwd, chat.goal);
  if (!chat.goalEl && chat.msgs && chat.msgs.parentNode) {
    chat.goalEl = el('div', 'goal-banner');
    chat.msgs.parentNode.insertBefore(chat.goalEl, chat.msgs);
  }
  if (chat.goalEl) {
    chat.goalEl.textContent = chat.goal ? 'Goal: ' + chat.goal : '';
    chat.goalEl.hidden = !chat.goal;
  }
}

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
  if (cmd === '/btw') {
    const r = parseBtw(text);
    if (r.error) toast(r.error, 'err'); else askBtw(chat, r.question);
    chat.composer.value = '';
    return true;
  }
  if (cmd === '/loop') {
    const r = parseLoop(text);
    if (r.error) { toast(r.error, 'err'); return true; }
    chat.loop = { left: r.n - 1, prompt: r.prompt };
    chat.composer.value = r.prompt;
    setTimeout(() => send(), 0);
    toast('Looping ' + r.n + ' times. Stop ends it.', 'ok');
    return true;
  }
  if (cmd === '/goal') {
    const r = parseGoal(text);
    if (r.goal) setGoal(chat, r.goal);
    else if (r.clear) setGoal(chat, '');
    else toast(chat.goal ? 'Goal: ' + chat.goal : 'No goal set. Use /goal <what you want done>', 'ok');
    return true;
  }
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
  { name: 'btw', description: 'Ask a side question while a turn runs: /btw <question>' },
  { name: 'loop', description: 'Run a prompt n times: /loop 3 run the tests' },
  { name: 'goal', description: 'Keep a goal in view: /goal <text>, /goal clear' },
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
].map((c) => ({ ...c, own: true }));

const PANE_COMMANDS = { '/context': 'tasks', '/files': 'files', '/changes': 'changes', '/diff': 'diff', '/terminal': 'terminal', '/preview': 'preview' };

const recentKey = (chat) => 'cce.slashRecent.' + (chat.cwd || '');

/** Remember a command the user ran so it floats to the top next time. */
export function noteSlashUsed(chat, text) {
  const m = /^\/([^\s]+)/.exec(text || '');
  if (m) pushRecent(localStorage, recentKey(chat), m[1]);
}

/**
 * Every command the session offers, with descriptions. The engine only lists
 * them in its first reply, so a fresh chat showed nothing for "/": ask the
 * session directly instead, once.
 */
async function loadSlashCommands(chat) {
  // Skills and plugins can appear mid-session: ask the engine again after a minute.
  if (chat.slashCatalog && Date.now() - (chat.slashCatalogAt || 0) < 60000) return chat.slashCatalog;
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
      chat.slashCatalogAt = Date.now();
      chat.cmdDetail = null;
      chat.slashLoading = null;
      return chat.slashCatalog;
    })();
  }
  return chat.slashLoading;
}

export async function maybeSlash(chat) {
  const pos = chat.composer.selectionStart ?? chat.composer.value.length;
  const tok = slashTokenAt(chat.composer.value, pos);
  if (!tok) return hideSlash(chat);
  const all = await loadSlashCommands(chat);
  // The user may have typed on while the list loaded.
  const now = slashTokenAt(chat.composer.value, chat.composer.selectionStart ?? chat.composer.value.length);
  if (!now) return hideSlash(chat);
  chat.slashToken = now;
  const rows = rankCommands(all, now.query.toLowerCase(), loadRecent(localStorage, recentKey(chat)));
  if (!rows.length) return hideSlash(chat);
  // Flat list: a header row before each section, then its commands.
  const flat = [];
  const items = [];
  let last = null;
  for (const r of rows) {
    if (!now.query && r.section !== last) { flat.push({ header: r.section }); last = r.section; }
    flat.push({ row: r, index: items.length });
    items.push(r.c);
  }
  chat.slashFlat = flat;
  chat.slashRows = rows;
  chat.slashItems = items;
  if (chat.slashIdx < 0 || chat.slashIdx >= items.length) chat.slashIdx = 0;
  renderSlash(chat);
}

function flatIndexOf(chat, idx) {
  return chat.slashFlat.findIndex((f) => f.row && f.index === idx);
}

function renderSlash(chat) {
  ensurePanes(chat);
  chat.slash.classList.remove('hidden');
  chat.slashList.style.maxHeight = LIST_H + 'px';
  chat.slashSpacer.style.height = chat.slashFlat.length * ROW_H + 'px';
  paintWindow(chat);
  if (!chat.slashWired) {
    chat.slashWired = true;
    chat.slashList.addEventListener('scroll', () => paintWindow(chat), { passive: true });
  }
  showSelected(chat, true);
}

function paintWindow(chat) {
  const list = chat.slashList;
  for (const n of [...list.querySelectorAll('.slash-item, .slash-section')]) n.remove();
  const { first, last } = windowRange(chat.slashFlat.length, ROW_H, list.scrollTop, LIST_H);
  for (let i = first; i < last; i++) {
    const f = chat.slashFlat[i];
    let node;
    if (f.header) {
      node = el('div', 'slash-section', f.header);
    } else {
      const { c, badge, indices } = f.row;
      node = el('div', 'slash-item' + (f.index === chat.slashIdx ? ' sel' : ''));
      node.setAttribute('role', 'option');
      node.dataset.idx = String(f.index);
      node.id = 'slash-' + f.index;
      const name = el('span', 'slash-name');
      name.appendChild(document.createTextNode('/'));
      for (const part of highlightParts(c.name, indices)) {
        name.appendChild(part.hit ? el('mark', 'slash-hit', part.text) : document.createTextNode(part.text));
      }
      if (c.argumentHint) name.appendChild(el('span', 'slash-arg', ' ' + c.argumentHint));
      node.appendChild(name);
      if (c.description) node.appendChild(el('span', 'slash-desc', c.description));
      node.appendChild(el('span', 'slash-badge', badge));
      node.addEventListener('mousedown', (e) => { e.preventDefault(); chat.slashIdx = f.index; applySlash(chat); });
      node.addEventListener('mouseenter', () => { if (chat.slashIdx !== f.index) { chat.slashIdx = f.index; showSelected(chat, false); } });
    }
    node.style.top = i * ROW_H + 'px';
    list.appendChild(node);
  }
}

/** Mark the selected row, scroll it into view, load its preview. */
function showSelected(chat, scroll) {
  const list = chat.slashList;
  const fi = flatIndexOf(chat, chat.slashIdx);
  if (fi >= 0 && scroll) {
    const top = fi * ROW_H;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_H > list.scrollTop + LIST_H) list.scrollTop = top + ROW_H - LIST_H;
    paintWindow(chat);
  }
  for (const n of list.querySelectorAll('.slash-item')) n.classList.toggle('sel', n.dataset.idx === String(chat.slashIdx));
  const sel = chat.slashItems[chat.slashIdx];
  if (sel) chat.composer.setAttribute('aria-activedescendant', 'slash-' + chat.slashIdx);
  clearTimeout(chat.slashPreviewTimer);
  chat.slashPreviewTimer = setTimeout(() => loadPreview(chat, sel), 80);
}

async function loadPreview(chat, c) {
  if (!c) return setPreview(chat, null);
  const badge = chat.slashRows.find((r) => r.c === c)?.badge || '';
  const base = { title: '/' + c.name, badge, meta: [c.argumentHint, c.description].filter(Boolean).join(' · ') };
  setPreview(chat, base);
  if (c.own) return;
  chat.cmdDetail = chat.cmdDetail || new Map();
  let d = chat.cmdDetail.get(c.name);
  if (!d) {
    try { const r = await ccx.invoke('cmd:detail', { name: c.name, cwd: chat.cwd }); d = r && r.ok ? r : { found: false }; } catch { d = { found: false }; }
    chat.cmdDetail.set(c.name, d);
  }
  if (chat.slashItems[chat.slashIdx] !== c) return;   // the user moved on
  if (d.found) setPreview(chat, { ...base, meta: [d.argumentHint || c.argumentHint, d.description || c.description, d.path].filter(Boolean).join(' · '), body: d.preview, cut: d.cut });
}

export function moveSlash(chat, d) {
  if (!chat.slashItems.length) return;
  chat.slashIdx = (chat.slashIdx + d + chat.slashItems.length) % chat.slashItems.length;
  showSelected(chat, true);
}

/** Jump to the start / end or by a page. */
export function jumpSlash(chat, where) {
  const n = chat.slashItems.length;
  if (!n) return;
  const page = Math.floor(LIST_H / ROW_H) - 1;
  chat.slashIdx = where === 'home' ? 0 : where === 'end' ? n - 1
    : Math.max(0, Math.min(n - 1, chat.slashIdx + (where === 'pagedown' ? page : -page)));
  showSelected(chat, true);
}

/** Put the chosen command in the box. The user adds arguments, then sends. */
export function applySlash(chat) {
  const c = chat.slashItems[chat.slashIdx >= 0 ? chat.slashIdx : 0];
  if (c) {
    const tok = chat.slashToken || slashTokenAt(chat.composer.value, chat.composer.selectionStart);
    const out = tok ? applySlashToken(chat.composer.value, tok, c.name) : { value: '/' + c.name + ' ', caret: c.name.length + 2 };
    chat.composer.value = out.value;
    chat.composer.setSelectionRange(out.caret, out.caret);
    chat.composer.focus();
    hideSlash(chat);
    return;
  }
  hideSlash(chat);
}

export function hideSlash(chat) {
  chat.slash.classList.add('hidden');
  chat.slashIdx = -1;
  clearTimeout(chat.slashPreviewTimer);
  chat.composer.removeAttribute('aria-activedescendant');
}

export { SECTION_ORDER };
