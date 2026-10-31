// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { scrollDownSoft } from './transcript.js';
import { basename, el, md } from './util.js';
import { makePanel, panelOpen } from './panels.js';
import { chats } from './util.js';
import CCEMemTimeline from '../../shared/memtimeline.js';

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
  if (window.__CCE_DEBUG || window.__CCE_SMOKE) console.log('[cce] auto-memory probe started for chat:', chat.id);
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

export async function toggleMemoryPanel(chat) {
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
  ccx.invoke('settings:get').then((st) => { cb.checked = !!(st && st.settings && st.settings.autoMemory); }).catch(() => { /* leave unchecked; the switch still works */ });
  cb.addEventListener('change', () => ccx.invoke('settings:set', { settings: { autoMemory: cb.checked } }));
  toggle.appendChild(cb);
  toggle.appendChild(el('span', '', ' Propose lasting notes from my chats (same model; I approve each one)'));
  panel.appendChild(toggle);
  // Auto-learn skills (item 19): the same opt-in switch for skill drafts.
  const skillToggle = el('label', 'mem-auto');
  const scb = el('input');
  scb.type = 'checkbox';
  ccx.invoke('settings:get').then((st) => { scb.checked = !!(st && st.settings && st.settings.autoLearnSkills); }).catch(() => { /* leave unchecked; the switch still works */ });
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
  // What the engine reads at session start, and what each part costs in tokens.
  const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
  const loads = el('div', 'mem-loads');
  const fileTok = (f) => CCEMemTimeline.estTokens((f.content || '').length);
  loads.appendChild(el('div', 'mem-sub', 'Loaded at session start · about ' + fmtTok(files.reduce((n, f) => n + fileTok(f), 0)) + ' tokens'));
  for (const f of files) {
    const row = el('div', 'mem-load-row');
    row.appendChild(el('span', '', f.label));
    row.appendChild(el('span', 'mem-tok', '~' + fmtTok(fileTok(f))));
    loads.appendChild(row);
  }
  const seeAll = el('button', 'btn tiny', 'Preview what Claude sees');
  const seen = el('pre', 'mem-proposal-body hidden');
  seeAll.addEventListener('click', () => {
    seen.textContent = files.map((f) => '=== ' + f.label + ' (' + f.path + ') ===\n' + (f.content || '')).join('\n\n') || '(nothing is loaded)';
    seen.classList.toggle('hidden');
  });
  loads.appendChild(seeAll);
  loads.appendChild(seen);
  panel.appendChild(loads);

  // The notes, newest last, as a filterable list. "#mem-N" in a reply opens note N.
  const tl = el('div', 'mem-timeline');
  const tlHead = el('div', 'mem-sub', 'Memory notes');
  const chipRow = el('div', 'mem-chips');
  const search = el('input', 'skills-search');
  search.type = 'search';
  search.placeholder = 'Search notes';
  search.setAttribute('aria-label', 'Search memory notes');
  const list = el('div', 'mem-list');
  tl.appendChild(tlHead);
  tl.appendChild(chipRow);
  tl.appendChild(search);
  tl.appendChild(list);
  panel.appendChild(tl);
  let entries = [];
  let typeSel = 'all';
  const drawList = () => {
    const counts = CCEMemTimeline.typeCounts(entries);
    chipRow.innerHTML = '';
    for (const t of ['all', ...CCEMemTimeline.TYPES]) {
      if (t !== 'all' && !counts[t]) continue;
      const b = el('button', 'mem-chip' + (typeSel === t ? ' on' : ''), t + ' ' + counts[t]);
      b.addEventListener('click', () => { typeSel = t; drawList(); });
      chipRow.appendChild(b);
    }
    list.innerHTML = '';
    const shown = CCEMemTimeline.filterEntries(entries, { type: typeSel, q: search.value });
    if (!shown.length) list.appendChild(el('div', 'hint', entries.length ? 'No note matches.' : 'No notes saved yet for this project.'));
    for (const e of shown) {
      const d = el('details', 'mem-note');
      d.dataset.n = String(e.n);
      const sm = el('summary', '', '');
      sm.appendChild(el('span', 'mem-n', '#mem-' + e.n));
      sm.appendChild(el('span', 'mem-title', e.title));
      sm.appendChild(el('span', 'mem-type', e.type));
      sm.appendChild(el('span', 'mem-tok', '~' + fmtTok(e.tokens)));
      d.appendChild(sm);
      d.appendChild(el('div', 'hint', e.hook));
      d.appendChild(el('pre', 'mem-proposal-body', e.missing ? '(the note file is missing)' : e.body));
      list.appendChild(d);
    }
  };
  search.addEventListener('input', drawList);
  panel._focusNote = (n) => {
    typeSel = 'all'; search.value = ''; drawList();
    const d = list.querySelector('details[data-n="' + n + '"]');
    if (d) { d.open = true; d.scrollIntoView({ block: 'center' }); }
    else toast('No memory note #mem-' + n, 'err');
  };
  ccx.invoke('memory:timeline', { cwd: chat.cwd }).then((tr) => { entries = (tr && tr.entries) || []; drawList(); }).catch(() => drawList());
  panel.appendChild(pick);
  panel.appendChild(editor);
  panel.appendChild(row);
  panel.appendChild(status);
  chat.pane.appendChild(panel);
  if (files.length) show();
  editor.focus();
}

const pathDirname = (p) => String(p).replace(/\/[^/]+$/, '');

/** Open the memory panel on note n (a "#mem-n" citation was clicked). */
export async function openMemoryCitation(chat, n) {
  if (!panelOpen(chat, 'chat-memory-panel')) await toggleMemoryPanel(chat);
  const panel = chat.pane.querySelector('.chat-memory-panel');
  if (panel && panel._focusNote) panel._focusNote(n);
}

/**
 * Turn "#mem-12" in a rendered reply into a button that opens that note. Code and
 * links are left alone.
 */
export function linkMemoryCitations(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('pre, code, a, button') ? NodeFilter.FILTER_REJECT
      : (/#mem-\d/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const hits = CCEMemTimeline.findCitations(node.nodeValue);
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const h of hits) {
      frag.appendChild(document.createTextNode(node.nodeValue.slice(at, h.index)));
      const b = el('button', 'mem-cite', '#mem-' + h.n);
      b.type = 'button';
      b.title = 'Open memory note ' + h.n;
      b.addEventListener('click', () => {
        const pane = b.closest('.chat-pane');
        const chat = [...chats.values()].find((c) => c.pane === pane);
        if (chat) openMemoryCitation(chat, h.n);
      });
      frag.appendChild(b);
      at = h.index + h.length;
    }
    frag.appendChild(document.createTextNode(node.nodeValue.slice(at)));
    node.replaceWith(frag);
  }
}
