// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { switchView } from '../app/tabs.js';
import { autosize } from './composer.js';
import { INSTALL_CMD, renderHooks } from './events.js';
import { closeChat, createSession } from './session.js';
import { doCompact } from './slash.js';
import { scrollDownSoft } from './transcript.js';
import { basename, el, esc, fmtAge, md } from './util.js';
import { ProvidersUI } from '../providers/ui.js';

/* ---------------- side panels (one frame for all of them) ---------------- */

// Every ⋯ panel used to be a bare box: no title bar, no close button, and
// two could stack on top of each other. They now share one frame — title,
// close (✕ / Esc), and only one open at a time.
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
  if (hint) panel.appendChild(el('p', 'hint', hint));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); panel.remove(); chat.composer.focus(); }
  });
  return panel;
}

const panelOpen = (chat, cls) => {
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
  try {
    const r = await ccx.invoke('git:info', { cwd: chat.cwd });
    if (!r.ok || !chat.projEl) return;
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
  } catch { /* git absent or not a repo — chips stay minimal */ }
}

/* ---------------- memory & rules editor ---------------- */

/* ---------------- auto-memory proposals (opt-in) ---------------- */

// Once per chat, after a few finished turns: ask the same model for lasting
// facts. They only wait for review; nothing reaches MEMORY.md unapproved.
export async function maybeProbeMemory(chat) {
  if (!chat.alive || chat.busy || chat.memProbed || chat.compacting || chat.memProbe) return;
  const s = await ccx.invoke('settings:get');
  if (!s || !s.ok || !s.settings || !s.settings.autoMemory) return;
  const p = await ccx.invoke('memory:probe-prompt');
  if (!p || !p.ok) return;
  chat.memProbed = true;
  chat.memProbe = true;
  console.log('[cce] auto-memory probe started for chat:', chat.id);
  chat.msgs.appendChild(el('div', 'sys-note', '[Auto-memory probe] checking this chat for lasting notes (auto memory is on)…'));
  scrollDownSoft(chat);
  const r = await ccx.invoke('chat:send', { id: chat.id, text: p.prompt });
  if (!r || !r.ok) chat.memProbe = false;
}

export async function collectMemoryProbe(chat, msg) {
  const text = msg.subtype === 'success' ? String(msg.result || '') : '';
  const r = text ? await ccx.invoke('memory:propose', { cwd: chat.cwd, text }) : null;
  const n = r && r.ok ? r.queued : 0;
  chat.msgs.appendChild(el('div', 'sys-note', n
    ? 'memory: ' + n + ' note' + (n > 1 ? 's' : '') + ' to review: open memory & rules, then accept or reject each'
    : 'memory: nothing new worth remembering'));
  scrollDownSoft(chat);
  showPendingChip(chat);
}

/** Auto-learn (item 19): ask the same model, once per chat, whether the
 *  workflow here deserves a skill draft. Opt-in via settings.autoLearnSkills. */
export async function maybeProbeSkill(chat) {
  if (!chat.alive || chat.busy || chat.skillProbed || chat.compacting || chat.skillProbe) return;
  if (chat.memProbe) { setTimeout(() => maybeProbeSkill(chat), 2000); return; }   // one probe at a time
  const s = await ccx.invoke('settings:get');
  if (!s || !s.ok || !s.settings || !s.settings.autoLearnSkills) return;
  const p = await ccx.invoke('skills:autolearn-prompt');
  if (!p || !p.ok) return;
  chat.skillProbed = true;
  chat.skillProbe = true;
  chat.msgs.appendChild(el('div', 'sys-note', '[Auto-learn] checking this chat for a workflow worth turning into a skill…'));
  scrollDownSoft(chat);
  const r = await ccx.invoke('chat:send', { id: chat.id, text: p.prompt });
  if (!r || !r.ok) chat.skillProbe = false;
}

export async function collectSkillProbe(chat, msg) {
  const text = msg.subtype === 'success' ? String(msg.result || '') : '';
  const r = text ? await ccx.invoke('skills:autolearn-propose', { text }) : null;
  const n = r && r.ok ? r.queued : 0;
  chat.msgs.appendChild(el('div', 'sys-note', n
    ? 'skill: ' + n + ' draft' + (n > 1 ? 's' : '') + ' to review: open Memory & rules, then accept or reject each'
    : 'skill: nothing new worth learning'));
  scrollDownSoft(chat);
}

/** A chip on the project bar while notes wait for review; click opens the Memory panel. */
export async function showPendingChip(chat) {
  const r = await ccx.invoke('memory:pending', { cwd: chat.cwd });
  chat.projEl.querySelector('.mem-pending-chip')?.remove();
  const n = r && r.ok ? (r.pending || []).length : 0;
  if (!n) return;
  const chip = elIcon('button', 'proj-chip mem-pending-chip', CCEIcons.svg('brain', 13) + ' ' + n + ' memory note' + (n > 1 ? 's' : '') + ' to review');
  chip.addEventListener('click', () => toggleMemoryPanel(chat));
  chat.projEl.appendChild(chip);
}

async function toggleMemoryPanel(chat) {
  if (panelOpen(chat, 'chat-memory-panel')) return;
  const panel = makePanel(chat, 'chat-memory-panel', 'brain', 'Memory & rules',
    'What the engine loads at session start: CLAUDE.md memory, .claude/rules/*.md, and settings.json hooks. Hooks apply to sessions started after saving.');
  const pick = el('select', 'skills-search');
  const editor = el('textarea', 'mem-editor');
  editor.spellcheck = false;
  const status = el('div', 'hint', '');
  const r = await ccx.invoke('memory:files', { cwd: chat.cwd });
  const files = (r.ok && r.files) || [];
  if (!files.length) status.textContent = 'No memory or rule files yet for this project.';
  files.forEach((f, i) => {
    const o = el('option', '', f.label + ' — ' + basename(pathDirname(f.path)));
    o.value = String(i);
    pick.appendChild(o);
  });
  const show = () => {
    const f = files[Number(pick.value) || 0];
    editor.value = f ? f.content : '';
    status.textContent = f ? f.path : '';
  };
  pick.addEventListener('change', show);
  const row = el('div', 'perm-actions');
  const save = el('button', 'btn small primary', 'Save');
  save.addEventListener('click', async () => {
    const f = files[Number(pick.value) || 0];
    if (!f) return;
    const rr = await ccx.invoke('memory:save', { path: f.path, content: editor.value });
    if (!rr.ok) { status.textContent = 'save failed: ' + rr.error; return; }
    f.content = editor.value;
    status.textContent = 'saved ' + rr.bytes + ' bytes — ' + f.path;
    toast('Saved ' + f.label, 'ok');
  });
  row.appendChild(save);
  // Auto memory: opt-in switch, and the notes the model proposed, awaiting a yes or no.
  const toggle = el('label', 'mem-auto');
  const cb = el('input');
  cb.type = 'checkbox';
  ccx.invoke('settings:get').then((st) => { cb.checked = !!(st && st.settings && st.settings.autoMemory); });
  cb.addEventListener('change', () => ccx.invoke('settings:set', { settings: { autoMemory: cb.checked } }));
  toggle.appendChild(cb);
  toggle.appendChild(el('span', '', ' Propose lasting notes from my chats (same model; I approve each one)'));
  panel.appendChild(toggle);
  // Auto-learn skills (item 19): the same opt-in switch for skill drafts.
  const skillToggle = el('label', 'mem-auto');
  const scb = el('input');
  scb.type = 'checkbox';
  ccx.invoke('settings:get').then((st) => { scb.checked = !!(st && st.settings && st.settings.autoLearnSkills); });
  scb.addEventListener('change', () => ccx.invoke('settings:set', { settings: { autoLearnSkills: scb.checked } }));
  skillToggle.appendChild(scb);
  skillToggle.appendChild(el('span', '', ' Propose new skills from my chats (same model; I approve each one)'));
  panel.appendChild(skillToggle);
  const proposals = el('div', 'mem-proposals');
  panel.appendChild(proposals);
  const loadProposals = async () => {
    const pr = await ccx.invoke('memory:pending', { cwd: chat.cwd });
    proposals.innerHTML = '';
    for (const p of ((pr && pr.pending) || [])) {
      const card = el('div', 'mem-proposal');
      card.appendChild(el('div', 'mem-proposal-head', p.type + ' · ' + p.slug));
      card.appendChild(el('div', 'hint', p.description));
      card.appendChild(el('pre', 'mem-proposal-body', p.body));
      const act = el('div', 'perm-actions');
      for (const [label, accept, cls] of [['Accept', true, 'btn small primary'], ['Reject', false, 'btn small']]) {
        const b = el('button', cls, label);
        b.addEventListener('click', async () => {
          b.disabled = true;
          const rr = await ccx.invoke('memory:resolve', { cwd: chat.cwd, slug: p.slug, accept });
          if (rr && rr.ok && rr.saved) toast('Saved to memory: ' + p.slug, 'ok');
          await loadProposals();
          showPendingChip(chat);
        });
        act.appendChild(b);
      }
      card.appendChild(act);
      proposals.appendChild(card);
    }
  };
  loadProposals();
  // Skill drafts waiting for review (item 19) — same accept/reject cards.
  const skillBox = el('div', 'mem-proposals');
  panel.appendChild(skillBox);
  const loadSkills = async () => {
    const pr = await ccx.invoke('skills:autolearn-pending');
    skillBox.innerHTML = '';
    for (const p of ((pr && pr.pending) || [])) {
      const card = el('div', 'mem-proposal');
      card.appendChild(el('div', 'mem-proposal-head', 'skill · ' + p.name));
      card.appendChild(el('div', 'hint', p.description));
      card.appendChild(el('pre', 'mem-proposal-body', p.body));
      const act = el('div', 'perm-actions');
      for (const [label, accept, cls] of [['Accept', true, 'btn small primary'], ['Reject', false, 'btn small']]) {
        const b = el('button', cls, label);
        b.addEventListener('click', async () => {
          b.disabled = true;
          const rr = await ccx.invoke('skills:autolearn-resolve', { name: p.name, accept });
          if (rr && rr.ok && rr.saved) toast('Skill saved: ' + p.name, 'ok');
          await loadSkills();
        });
        act.appendChild(b);
      }
      card.appendChild(act);
      skillBox.appendChild(card);
    }
  };
  loadSkills();
  panel.appendChild(pick);
  panel.appendChild(editor);
  panel.appendChild(row);
  panel.appendChild(status);
  chat.pane.appendChild(panel);
  if (files.length) show();
  editor.focus();
}

const pathDirname = (p) => String(p).replace(/\/[^/]+$/, '');

/* ---------------- command palette (Ctrl/Cmd+K) ---------------- */

export function openPalette(chat) {
  const old = document.querySelector('.palette-back');
  if (old) { old.remove(); return; }
  const back = el('div', 'palette-back');
  const box = el('div', 'palette');
  const input = el('input');
  input.placeholder = 'Jump to a session, model, command, or panel…';
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

  let sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const shown = items.filter(i => !q || i.label.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q)).slice(0, 60);
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
  const shownNow = () => items.filter(i => {
    const q = input.value.trim().toLowerCase();
    return !q || i.label.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q);
  }).slice(0, 60);

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

/* ---------------- skills panel ---------------- */

async function toggleSkillsPanel(chat) {
  if (panelOpen(chat, 'chat-skills-main')) return;
  const panel = makePanel(chat, 'chat-skills-main', 'bolt', 'Skills, commands, agents & hooks',
    'Type / in the composer to run a command; skills auto-trigger when a task matches. Click a row to use it.');
  // Jump links: the panel is long, so each section is one click away.
  const jump = el('div', 'panel-tabs');
  panel.appendChild(jump);

  const search = el('input', 'skills-search');
  search.type = 'text';
  search.placeholder = 'Filter by name or description…';
  panel.appendChild(search);

  const body = el('div', 'skills-body');
  panel.appendChild(body);

  // Live command list from the session (includes plugin + project commands).
  if (!chat.commandDetails) {
    const r = await ccx.invoke('chat:commands', { id: chat.id });
    chat.commandDetails = r.ok ? (r.commands || []) : [];
  }
  const detail = chat.skillsDetail.length ? chat.skillsDetail : await (async () => {
    const r = await ccx.invoke('chat:skills', { cwd: chat.cwd });
    chat.skillsDetail = r.ok ? r.skills : [];
    return chat.skillsDetail;
  })();
  if (!chat.agentsList) {
    const ar = await ccx.invoke('chat:agents', { id: chat.id });
    chat.agentsList = ar.ok ? (ar.agents || []) : [];
  }
  if (!chat.toolsList) {
    const tr = await ccx.invoke('tools:check');
    chat.toolsList = tr.ok ? (tr.tools || []) : [];
  }

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const match = (s) => !q || (s.name || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
    body.innerHTML = '';

    const cmds = chat.commandDetails.filter(match);
    const sec1 = el('div', 'skills-section');
    sec1.appendChild(el('h5', '', `Commands (${cmds.length})`));
    const clist = el('div', 'skills-list');
    for (const c of cmds.slice(0, 80)) {
      const row = el('div', 'skill-row');
      const code = el('code', '', '/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : ''));
      row.appendChild(code);
      if (c.description) row.appendChild(el('span', 'skill-desc', c.description));
      if (c.builtin) row.appendChild(el('span', 'chip', 'built-in'));
      row.addEventListener('click', () => {
        chat.composer.value = '/' + c.name + ' ';
        chat.composer.focus();
        panel.remove();
      });
      clist.appendChild(row);
    }
    if (cmds.length > 80) clist.appendChild(el('div', 'hint', `…and ${cmds.length - 80} more — type to filter`));
    sec1.appendChild(clist);
    body.appendChild(sec1);

    const skills = detail.filter(match).concat(
      (chat.init ? (chat.init.skills || []) : [])
        .filter(n => match({ name: n }))
        .map(n => ({ name: n, description: '', source: 'session' }))
    );
    const seen = new Set();
    const uniq = skills.filter(s => !seen.has(s.name) && seen.add(s.name));
    const sec2 = el('div', 'skills-section');
    sec2.appendChild(el('h5', '', `Skills (${uniq.length})`));
    const slist = el('div', 'skills-list');
    for (const s of uniq.slice(0, 80)) {
      const row = el('div', 'skill-row');
      row.appendChild(el('code', '', s.name));
      if (s.description) row.appendChild(el('span', 'skill-desc', s.description));
      if (s.source) row.appendChild(el('span', 'chip', s.source));
      const use = el('button', 'btn small', 'use');
      use.title = 'Ask Claude to use this skill';
      use.addEventListener('click', (e) => {
        e.stopPropagation();
        chat.composer.value = 'Use the ' + s.name + ' skill: ';
        chat.composer.focus();
        panel.remove();
      });
      row.appendChild(use);
      const on = s.enabled !== false;
      const tog = el('button', 'switch' + (on ? ' on' : ''));
      tog.setAttribute('role', 'switch');
      tog.setAttribute('aria-checked', on ? 'true' : 'false');
      tog.title = (on ? 'Disable' : 'Enable') + ' ' + s.name;
      tog.textContent = on ? 'disable' : 'enable';
      tog.addEventListener('click', async (e) => {
        e.stopPropagation();
        tog.disabled = true;
        const next = tog.textContent === 'enable';
        await ccx.invoke('skills:toggle', { name: s.name, enabled: next });
        s.enabled = next;
        tog.classList.toggle('on', next);
        tog.textContent = next ? 'disable' : 'enable';
        tog.setAttribute('aria-checked', next ? 'true' : 'false');
        tog.disabled = false;
      });
      row.appendChild(tog);
      slist.appendChild(row);
    }
    if (uniq.length > 80) slist.appendChild(el('div', 'hint', `…and ${uniq.length - 80} more — type to filter`));
    sec2.appendChild(slist);
    body.appendChild(sec2);

    // Subagents registered for this session (`.claude/agents` + built-ins).
    const agents = (chat.agentsList || []).filter(a => match({ name: a.name, description: a.description }));
    if (agents.length) {
      const sec3 = el('div', 'skills-section');
      sec3.appendChild(el('h5', '', `Agents (${agents.length})`));
      const alist = el('div', 'skills-list');
      for (const a of agents) {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', a.name));
        if (a.description) row.appendChild(el('span', 'skill-desc', a.description));
        if (a.model) row.appendChild(el('span', 'chip', a.model));
        const use = el('button', 'btn small', 'use');
        use.title = 'Ask Claude to delegate to this agent';
        use.addEventListener('click', (e) => {
          e.stopPropagation();
          chat.composer.value = 'Use the ' + a.name + ' agent to: ';
          chat.composer.focus();
          panel.remove();
        });
        row.appendChild(use);
        const on = a.enabled !== false;
        const tog = el('button', 'switch' + (on ? ' on' : ''));
        tog.setAttribute('role', 'switch');
        tog.setAttribute('aria-checked', on ? 'true' : 'false');
        tog.title = (on ? 'Disable' : 'Enable') + ' ' + a.name;
        tog.textContent = on ? 'disable' : 'enable';
        tog.addEventListener('click', async (e) => {
          e.stopPropagation();
          tog.disabled = true;
          const next = tog.textContent === 'enable';
          await ccx.invoke('agents:toggle', { name: a.name, enabled: next });
          a.enabled = next;
          tog.classList.toggle('on', next);
          tog.textContent = next ? 'disable' : 'enable';
          tog.setAttribute('aria-checked', next ? 'true' : 'false');
          tog.disabled = false;
        });
        row.appendChild(tog);
        alist.appendChild(row);
      }
      sec3.appendChild(alist);
      body.appendChild(sec3);
    }

    // Live hook audit trail (PreToolUse / PostToolUse / … fired this session).
    const sec4 = el('div', 'skills-section');
    sec4.appendChild(el('h5', '', 'Hooks'));
    const hlist = el('div', 'skills-list');
    hlist.appendChild(el('div', 'hint', 'none yet'));
    sec4.appendChild(hlist);
    body.appendChild(sec4);
    chat.hooksHost = sec4;
    chat.hooksHost.__list = hlist;
    renderHooks(chat);

    // Runtime tools some skills shell out to (bun, uv, rg…)
    const sec5 = el('div', 'skills-section');
    sec5.appendChild(el('h5', '', 'Runtime tools'));
    const tlist = el('div', 'skills-list');
    for (const t of (chat.toolsList || [])) {
      const row = el('div', 'skill-row');
      row.appendChild(el('code', '', t.name));
      row.appendChild(el('span', 'skill-desc', t.found ? t.path : 'not installed'));
      if (!t.found && INSTALL_CMD[t.name]) {
        const b = el('button', 'btn small', 'install');
        b.title = 'Opens a terminal tab running: ' + INSTALL_CMD[t.name];
        b.addEventListener('click', () => {
          panel.remove();
          window.createSession({ cwd: chat.cwd, type: 'shell', initText: INSTALL_CMD[t.name] + '\r' });
        });
        row.appendChild(b);
      }
      tlist.appendChild(row);
    }
    sec5.appendChild(tlist);
    body.appendChild(sec5);

    jump.innerHTML = '';
    for (const h of body.querySelectorAll('.skills-section h5')) {
      const b = el('button', 'panel-tab', h.textContent);
      b.addEventListener('click', () => h.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      jump.appendChild(b);
    }
  };
  search.addEventListener('input', render);
  render();

  // Memory & rules editor (CLAUDE.md, .claude/rules, settings hooks)
  const memBtn = elIcon('button', 'btn small', CCEIcons.svg('brain', 14) + ' edit memory & rules');
  memBtn.addEventListener('click', () => { panel.remove(); toggleMemoryPanel(chat); });
  panel.appendChild(memBtn);

  // Import a skill from GitHub / GitLab / Bitbucket (#37)
  const imp = el('div', 'skills-import');
  const impIn = el('input');
  impIn.type = 'text';
  impIn.placeholder = 'github.com/user/repo — import a skill from a repository';
  const impBtn = el('button', 'btn small', '⬇ import');
  const impHint = el('div', 'hint', '');
  const doImport = async () => {
    const url = impIn.value.trim();
    if (!url) return;
    impBtn.disabled = true;
    impHint.textContent = 'cloning…';
    const r = await ccx.invoke('skill:import', { url: /^https?:/.test(url) ? url : 'https://' + url });
    impBtn.disabled = false;
    if (!r.ok) { impHint.textContent = r.error; return; }
    impHint.textContent = 'imported: ' + r.imported.join(', ')
      + ((r.skipped && r.skipped.length) ? ' · already installed (skipped): ' + r.skipped.join(', ') : '');
    chat.skillsDetail = [];   // refetch on next open
    toast('Skill imported: ' + r.imported.join(', '), 'ok');
  };
  impBtn.addEventListener('click', doImport);
  impIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });
  imp.appendChild(impIn); imp.appendChild(impBtn);
  panel.appendChild(imp);
  panel.appendChild(impHint);

  // MCP status chips
  if (chat.init && (chat.init.mcp_servers || []).length) {
    panel.appendChild(elIcon('h4', '', CCEIcons.svg('plug2', 15) + ' MCP servers'));
    const mrow = el('div', 'mcp-chip-row');
    for (const s of chat.init.mcp_servers) {
      mrow.appendChild(el('span', 'chip mcp-chip ' + (s.status === 'connected' ? 'mcp-ok' : ''), `${s.name} · ${s.status}`));
    }
    panel.appendChild(mrow);
  }
  chat.pane.appendChild(panel);
  search.focus();
}

/* ---------------- mcp panel (live) ---------------- */

const MCP_CLS = { connected: 'mcp-ok', failed: 'mcp-err', 'needs-auth': 'mcp-warn', pending: '', disabled: 'mcp-off' };

async function toggleMcpPanel(chat) {
  if (panelOpen(chat, 'chat-mcp-panel')) return;
  const panel = makePanel(chat, 'chat-mcp-panel', 'plug2', 'MCP servers (live)',
    'Live session status. Connectors switch on and off by themselves; reconnect retries a failed server. Click a server to see its tools.');
  const filter = el('input', 'skills-search');
  filter.placeholder = 'Filter servers or tools…';
  panel.appendChild(filter);
  const summary = el('div', 'mcp-summary');
  panel.appendChild(summary);
  const body = el('div', 'skills-list');
  body.appendChild(el('div', 'hint', 'loading…'));
  panel.appendChild(body);
  const refresh = elIcon('button', 'btn small', CCEIcons.svg('refresh', 14) + ' refresh');
  refresh.addEventListener('click', () => load());
  const link = elIcon('button', 'btn small', CCEIcons.svg('gear', 14) + ' open connectors');
  link.addEventListener('click', () => { panel.remove(); switchView('connectors'); });
  const actions = el('div', 'perm-actions');
  actions.appendChild(refresh);
  actions.appendChild(link);
  panel.appendChild(actions);
  chat.pane.appendChild(panel);

  let cached = null;
  const load = async (fromCache) => {
    const r = (fromCache && cached) || await ccx.invoke('chat:mcp', { id: chat.id, op: 'status' });
    cached = r;
    if (!panel.isConnected) return;
    body.innerHTML = '';
    const all = (r.ok && r.servers) || [];
    const count = (st) => all.filter(s => s.status === st).length;
    summary.innerHTML = '';
    for (const [label, n, cls] of [['connected', count('connected'), 'mcp-ok'], ['failed', count('failed'), 'mcp-err'],
      ['needs auth', count('needs-auth'), 'mcp-warn'], ['disabled', count('disabled'), 'mcp-off']]) {
      if (n) summary.appendChild(el('span', 'chip ' + cls, n + ' ' + label));
    }
    const q = filter.value.trim().toLowerCase();
    const servers = all.filter(s => !q || s.name.toLowerCase().includes(q)
      || (s.tools || []).some(t => String(t.name).toLowerCase().includes(q)));
    if (!servers.length) { body.appendChild(el('div', 'hint', all.length ? 'Nothing matches.' : 'No MCP servers in this session.')); return; }
    for (const s of servers) {
      const row = el('div', 'skill-row');
      row.appendChild(el('code', '', s.name));
      row.appendChild(el('span', 'chip ' + (MCP_CLS[s.status] || ''), s.status));
      // The tool list is what proves the connector has tool-calling access.
      const tools = s.tools || [];
      if (tools.length) {
        const tchip = el('button', 'chip mcp-ok chip-btn', tools.length + ' tools ▾');
        tchip.title = 'Show the tools';
        let open = false;
        const tl = el('div', 'mcp-tools wide-hint hidden');
        for (const t of tools) {
          const tr = el('div', 'mcp-tool');
          tr.appendChild(el('code', '', t.name));
          if (t.description) tr.appendChild(el('span', 'skill-desc', String(t.description).slice(0, 140)));
          tl.appendChild(tr);
        }
        tchip.addEventListener('click', (e) => {
          e.stopPropagation();
          open = !open;
          tl.classList.toggle('hidden', !open);
          tchip.textContent = tools.length + ' tools ' + (open ? '▴' : '▾');
        });
        row.appendChild(tchip);
        row.__tools = tl;
      }
      if (s.error) row.appendChild(el('span', 'skill-desc', String(s.error).slice(0, 120)));
      // No enable/disable here: CCE switches connectors on and off by itself, and
      // what the user decides is set in Settings → Connectors.
      if (s.how) row.appendChild(el('span', 'chip', s.how));
      if (s.status === 'failed' || s.status === 'needs-auth') {
        const rc = elIcon('button', 'btn small', CCEIcons.svg('refresh', 14) + ' reconnect');
        rc.addEventListener('click', async () => {
          rc.disabled = true;
          const nr = await ccx.invoke('chat:mcp', { id: chat.id, op: 'reconnect', name: s.name });
          if (!nr.ok) { toast(nr.error, 'err'); rc.disabled = false; } else load();
        });
        row.appendChild(rc);
      }
      // Per-connector "ask every time" — the desktop app's tool policy.
      // The SDK carries the policy on the server definition, so it can only
      // be applied to a server this session registered itself; re-registering
      // a config-loaded server would replace a working one with a broken
      // copy (stale auth header). Refuse rather than break the connector.
      if (tools.length) {
        const ask = el('button', 'btn small', 'ask every time');
        ask.title = 'Require an approval for every call to this connector';
        ask.addEventListener('click', async () => {
          ask.disabled = true;
          const nr = await ccx.invoke('chat:mcp', {
            id: chat.id, op: 'policy', name: s.name, policy: 'always_ask',
            tools: tools.map((t) => t.name),
          });
          ask.disabled = false;
          if (!nr.ok) toast(nr.error || 'Could not set the policy', 'err');
          else toast('Always ask enabled for ' + s.name, 'ok');
        });
        row.appendChild(ask);
      }
      body.appendChild(row);
      if (row.__tools) body.appendChild(row.__tools);
    }
  };
  filter.addEventListener('input', () => load(true));
  load();
  filter.focus();
}

/* ---------------- rewind (file checkpoints) ---------------- */

async function toggleRewindPanel(chat) {
  if (panelOpen(chat, 'chat-rewind-panel')) return;
  const r = await ccx.invoke('chat:checkpoints', { id: chat.id });
  const list = (r.ok && r.checkpoints) || [];
  const panel = makePanel(chat, 'chat-rewind-panel', 'undo', 'Rewind files',
    'Restore files written/edited by this session to an earlier checkpoint. The conversation is NOT undone. Changes made by Bash are not tracked. First click previews, second click applies.');
  const body = el('div', 'skills-list');
  if (!list.length) body.appendChild(el('div', 'hint', 'No checkpoints yet — they start with your first prompt in this session.'));
  for (const c of [...list].reverse()) {
    const row = el('div', 'skill-row');
    const main = el('div', 'hist-main');
    main.appendChild(el('div', 'hist-preview', c.text));
    main.appendChild(el('div', 'hist-meta', new Date(c.at).toLocaleString()));
    row.appendChild(main);
    const b = el('button', 'btn small danger', 'rewind');
    let armed = false;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      // First click previews the change set; the second one applies it. #31
      if (!armed) {
        armed = true;
        b.textContent = 'checking…';
        const prev = await ccx.invoke('chat:rewind', { id: chat.id, uuid: c.uuid, dryRun: true });
        armed = false;
        if (!prev.ok) { toast(prev.error, 'err'); b.textContent = 'rewind'; return; }
        const files = (prev.filesChanged || []).length;
        const detail = prev.canRewind === false
          ? 'cannot rewind: ' + (prev.error || 'unknown')
          : (files ? files + ' file(s) would change  +' + (prev.insertions || 0) + ' −' + (prev.deletions || 0)
            : 'no tracked file changes');
        b.textContent = 'sure?';
        b.title = detail;
        row.appendChild(el('div', 'hint wide-hint', detail));
        armed = true;
        setTimeout(() => {
          if (!armed) return;
          armed = false; b.textContent = 'rewind'; b.title = '';
        }, 6000);
        return;
      }
      b.disabled = true;
      const rw = await ccx.invoke('chat:rewind', { id: chat.id, uuid: c.uuid });
      if (!rw.ok) { toast(rw.error, 'err'); b.disabled = false; b.textContent = 'rewind'; return; }
      panel.remove();
      chat.msgs.appendChild(el('div', 'sys-note',
        '⏪ files rewound to: ' + c.text.slice(0, 90) + (rw.skipped ? ' (' + rw.skipped + ' path(s) skipped)' : '')));
      scrollDownSoft(chat);
      toast('Files rewound', 'ok');
    });
    row.appendChild(b);
    body.appendChild(row);
  }
  panel.appendChild(body);
  chat.pane.appendChild(panel);
}

/* ---------------- history panel (per-folder, inside a chat) ---------------- */
// The flat, all-projects conversation list now lives in app.js next to the
// workspace; this panel stays for the per-folder variant.


async function toggleHistoryPanel(chat) {
  if (panelOpen(chat, 'chat-history-panel')) return;
  const panel = makePanel(chat, 'chat-history-panel', 'clock', 'Past conversations · ' + basename(chat.cwd),
    'From the engine’s transcript store, terminal sessions included. Open resumes; Fork branches without touching the original.');
  const filter = el('input', 'skills-search');
  filter.placeholder = 'Search this folder’s conversations…';
  panel.appendChild(filter);
  const list = el('div', 'skills-list');
  panel.appendChild(list);
  const allBtn = el('button', 'btn small', 'All conversations (every folder)');
  allBtn.addEventListener('click', () => { panel.remove(); if (window.toggleConversations) window.toggleConversations(true); });
  panel.appendChild(allBtn);
  chat.pane.appendChild(panel);
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    for (const row of list.querySelectorAll('.hist-row')) row.classList.toggle('hidden', !!q && !row.textContent.toLowerCase().includes(q));
  });
  filter.focus();

  const r = await ccx.invoke('chat:history', { cwd: chat.cwd });
  const sessions = (r.ok && r.sessions) || [];
  if (!sessions.length) list.appendChild(el('div', 'hint', 'No past sessions found for this folder yet.'));
  for (const s of sessions) {
    const row = el('div', 'skill-row hist-row');
    row.appendChild(el('span', 'hist-preview', s.preview));
    row.appendChild(el('span', 'chip', fmtAge(s.mtime)));
    const open = el('button', 'btn small', 'open');
    open.title = 'Resume this conversation';
    open.addEventListener('click', async () => {
      if (s.sessionId === chat.sessionId) await closeChat(chat.id);
      createSession({ cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode, resume: s.sessionId });
    });
    const fork = el('button', 'btn small', '⑂ fork');
    fork.title = 'Branch from this point — original stays untouched';
    fork.addEventListener('click', () => createSession({ cwd: chat.cwd, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode, resume: s.sessionId, fork: true }));
    const del = elIcon('button', 'btn small danger', CCEIcons.svg('trash', 14));
    del.setAttribute('aria-label', 'Delete this session from disk');
    del.title = 'Delete this session from disk';
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) { armed = true; del.textContent = 'sure?'; setTimeout(() => { armed = false; del.innerHTML = CCEIcons.svg('trash', 14); }, 2500); return; }
      const rd = await ccx.invoke('chat:delete', { cwd: chat.cwd, sessionId: s.sessionId });
      if (rd.ok) { row.remove(); toast('Session deleted', 'ok'); } else toast(rd.error, 'err');
    });
    row.appendChild(open); row.appendChild(fork); row.appendChild(del);
    list.appendChild(row);
  }
}

/* ---------------- plan viewer (claude-desktop style) ---------------- */

export function openPlanViewer(chat) {
  if (chat.planViewer) return chat.planViewer.body;
  const wrap = el('div', 'chat-plan-viewer');
  const head = el('div', 'plan-head');
  head.appendChild(elIcon('h4', '', CCEIcons.svg('map', 14) + ' Plan'));
  const close = el('button', 'close', '✕');
  close.title = 'Hide plan panel';
  close.setAttribute('aria-label', 'Hide plan panel');
  close.addEventListener('click', () => { wrap.remove(); chat.planViewer = null; });
  head.appendChild(close);
  const body = el('div', 'plan-body md');
  body.innerHTML = '<p class="hint">waiting for the plan…</p>';
  wrap.appendChild(head);
  wrap.appendChild(body);
  chat.planViewer = { wrap, body };
  chat.pane.querySelector('.chat-body').appendChild(wrap);
  return body;
}

export function updatePlanViewer(chat, jsonStr) {
  const body = chat.planViewer ? chat.planViewer.body : null;
  if (!body || !jsonStr) return;
  try {
    const j = JSON.parse(jsonStr);
    if (j && j.plan) body.innerHTML = md(j.plan);
  } catch { /* partial JSON — wait for more */ }
}

/* ---------------- find in transcript (#feat-find) ----------------
   Uses the engine's native window.find (Chromium find-in-page) so matches
   highlight across the whole rendered transcript, plus a naive occurrence
   count from the text. */
export function showFind(chat) {
  let bar = chat.pane.querySelector('.chat-find');
  if (!bar) {
    bar = el('div', 'chat-find');
    const inp = el('input');
    inp.type = 'text';
    inp.placeholder = 'find in transcript';
    inp.setAttribute('aria-label', 'Find in transcript');
    const prev = el('button', 'btn small', '◀');
    prev.setAttribute('aria-label', 'Previous match');
    const next = el('button', 'btn small', '▶');
    next.setAttribute('aria-label', 'Next match');
    const count = el('span', 'hint chat-find-count', '');
    const close = el('button', 'btn small', '✕');
    close.setAttribute('aria-label', 'Close find bar');
    const step = (back) => {
      const q = inp.value;
      if (!q) return;
      try { window.find(q, !!back, false, true); } catch { /* empty */ }
      paintCount();
    };
    const paintCount = () => {
      const q = inp.value;
      if (!q) { count.textContent = ''; return; }
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let n = 0;
      try { n = (chat.msgs.textContent.match(new RegExp(esc, 'gi')) || []).length; } catch { /* bad regex */ }
      count.textContent = n ? n + ' match' + (n === 1 ? '' : 'es') : 'no matches';
    };
    const hide = () => { bar.classList.add('hidden'); inp.value = ''; paintCount(); };
    inp.addEventListener('input', () => { try { window.find(inp.value, false, false, false); } catch { /* empty */ } paintCount(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { step(e.shiftKey); e.preventDefault(); }
      else if (e.key === 'Escape') { hide(); chat.composer.focus(); e.preventDefault(); e.stopPropagation(); }
    });
    [prev, next].forEach((b, i) => b.addEventListener('click', () => step(i === 0)));
    close.addEventListener('click', hide);
    bar.appendChild(inp); bar.appendChild(prev); bar.appendChild(next); bar.appendChild(count); bar.appendChild(close);
    chat.pane.appendChild(bar);
  }
  bar.classList.remove('hidden');
  const inp = bar.querySelector('input');
  inp.focus();
  inp.select();
}
