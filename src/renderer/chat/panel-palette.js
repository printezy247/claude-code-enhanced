// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { switchView } from '../app/tabs.js';
import { paletteKinds, paletteMode } from '../app/nav.js';
import { openChats } from './mentions-live.js';
import { autosize } from './composer.js';
import { createSession } from './session.js';
import { basename, el, fmtAge } from './util.js';
import { toggleMemoryPanel } from './panel-memory.js';
import { toggleSkillsPanel } from './panel-skills.js';
import { toggleMcpPanel } from './panel-mcp.js';
import { toggleHistoryPanel, toggleRewindPanel } from './panel-history.js';

/* ---------------- command palette (Ctrl/Cmd+K) ---------------- */

export function openPalette(chat) {
  const old = document.querySelector('.palette-back');
  if (old) { old.remove(); return; }
  const back = el('div', 'palette-back');
  const box = el('div', 'palette');
  const input = el('input');
  input.placeholder = 'Jump to…   > commands  @ files  # chats  : models';
  const list = el('div', 'palette-list');
  box.appendChild(input);
  box.appendChild(list);
  back.appendChild(box);

  const items = [];
  const add = (kind, label, sub, run) => items.push({ kind, label, sub: sub || '', run });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };

  for (const [label, view] of [['Sessions', 'terminal'], ['History', 'chats'], ['Providers', 'providers'],
    ['Connectors', 'connectors'], ['Settings', 'settings']]) {
    add('view', label, '', () => { close(); switchView(view); });
  }
  if (chat) {
    add('panel', 'Skills, agents, hooks, tools', '', () => { close(); toggleSkillsPanel(chat); });
    add('panel', 'MCP servers (live)', '', () => { close(); toggleMcpPanel(chat); });
    add('panel', 'past conversations', '', () => { close(); toggleHistoryPanel(chat); });
    add('panel', '⏪ rewind files', '', () => { close(); toggleRewindPanel(chat); });
    add('panel', 'memory & rules', '', () => { close(); toggleMemoryPanel(chat); });
    add('chat', '⑂ fork this conversation', '', () => { close(); chat.forkBtn.click(); });
    add('chat', '⌨ terminal tab in this folder', '', () => { close(); window.createSession({ cwd: chat.cwd, type: 'shell' }); });
    add('chat', 'summarize session into a handoff brief', '', () => { close(); prefilledSummary(chat); });
    add('chat', '■ stop / interrupt', '', () => { close(); chat.stopBtn.click(); });

    for (const o of chat.modelSel.options) {
      if (!o.value || o.value === '__custom') continue;
      add('model', o.textContent, '', () => {
        close();
        chat.modelSel.value = o.value;
        chat.modelSel.dispatchEvent(new Event('change'));
      });
    }
    for (const c of (chat.commandDetails || chat.commands || []).slice(0, 120)) {
      const name = typeof c === 'string' ? c : c.name;
      const desc = typeof c === 'string' ? '' : (c.description || '');
      add('command', '/' + name, desc, () => {
        close();
        chat.composer.value = '/' + name + ' ';
        chat.composer.focus();
      });
    }
  }
  for (const c of openChats(chat && chat.id)) {
    add('open', c.title, c.folder, () => { close(); switchView('conversations'); if (window.__activate) window.__activate(c.id); });
  }

  let sel = 0;
  const render = () => {
    const shown = shownNow();
    list.innerHTML = '';
    if (sel >= shown.length) sel = 0;
    shown.forEach((i, idx) => {
      const row = el('div', 'palette-item' + (idx === sel ? ' sel' : ''));
      row.appendChild(el('span', 'pi-kind', i.kind));
      row.appendChild(el('span', '', i.label));
      if (i.sub) row.appendChild(el('span', 'pi-sub', String(i.sub).slice(0, 60)));
      row.addEventListener('mouseenter', () => { sel = idx; [...list.children].forEach((c, j) => c.classList.toggle('sel', j === sel)); });
      row.addEventListener('click', i.run);
      list.appendChild(row);
    });
    if (!shown.length) list.appendChild(el('div', 'palette-item', 'no match'));
    return shown;
  };
  // Prefixes: > commands, @ files, # conversations, : models.
  const shownNow = () => {
    const { mode, q: raw } = paletteMode(input.value);
    const q = raw.toLowerCase();
    if (mode === 'files') {
      if (!chat) return [];
      return [{ kind: 'file', label: '@' + raw, sub: 'add to the message', run: () => { close(); chat.composer.value += (chat.composer.value && !/\s$/.test(chat.composer.value) ? ' ' : '') + '@' + raw + ' '; chat.composer.focus(); } }];
    }
    const kinds = paletteKinds(mode);
    return items.filter(i => (!kinds || kinds.includes(i.kind))
      && (!q || i.label.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q))).slice(0, 60);
  };

  function onKey(e) {
    if (!back.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shownNow().length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const i = shownNow()[sel];
      if (i) i.run();
    }
  }
  input.addEventListener('input', () => { sel = 0; render(); });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  render();
  document.body.appendChild(back);
  input.focus();

  // async: all stored sessions, searchable by preview text
  ccx.invoke('chats:index').then((r) => {
    if (!r.ok) return;
    for (const s of (r.sessions || []).slice(0, 120)) {
      add('session', s.preview || '(empty session)', basename(s.cwd || s.folder) + ' · ' + fmtAge(s.mtime), () => {
        close();
        createSession({ cwd: s.cwd || s.folder, resume: s.sessionId });
      });
    }
    render();
  }).catch(() => {});
}

function prefilledSummary(chat) {
  chat.composer.value = 'Summarize what we did in this session into a compact handoff brief: goals, decisions made, files touched (with paths), open TODOs, and the exact next step. Keep it under 30 lines.';
  chat.composer.focus();
  autosize(chat.composer);
}
