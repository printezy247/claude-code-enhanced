// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { scrollDownSoft } from './transcript.js';
import { basename, el, md } from './util.js';
import { makePanel, panelOpen } from './panels.js';

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
  panel.appendChild(pick);
  panel.appendChild(editor);
  panel.appendChild(row);
  panel.appendChild(status);
  chat.pane.appendChild(panel);
  if (files.length) show();
  editor.focus();
}

const pathDirname = (p) => String(p).replace(/\/[^/]+$/, '');
