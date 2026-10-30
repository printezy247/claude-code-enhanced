// Split from panels.js (Phase 3.7). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { INSTALL_CMD, renderHooks } from './events.js';
import { createSession } from './session.js';
import { el, md } from './util.js';
import { makePanel, panelOpen } from './panels.js';
import { toggleMemoryPanel } from './panel-memory.js';

/* ---------------- skills panel ---------------- */

export async function toggleSkillsPanel(chat) {
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
