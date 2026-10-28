// The workflow picker. Each workflow can carry options (when it runs, mode,
// model, scope, your own command, a follow-up chain) saved globally or per
// project. The rules are in wfoptions.js; this file draws the menu and runs it.
import { elIcon, toast } from '../app/core.js';
import { autosize } from './composer.js';
import { enqueue, setQueue } from './qpanel.js';
import { applyOverrides, drainQueue } from './status.js';
import { el, modeLabel } from './util.js';
import { CHAINS, WORKFLOWS, WORKFLOW_MENU } from './wfdata.js';
import {
  GROUPS, buildPrompt, chainFromPreset, chainSteps, cleanOptions, customToWorkflow, exportCustom, filterRows, historyLine,
  importCustom, loadStore, mergeOptions, neededMode, noteRecent, planRun, recordRun, saveStore, storeKey, toggleIn, validateCustom,
} from './wfoptions.js';

const ICONS = ['bolt', 'search', 'bug', 'check', 'eye', 'shield', 'globe', 'file', 'list', 'wrench', 'branch', 'map', 'notebook', 'thought'];

/* ---------------- stores and definitions ---------------- */

const stores = (chat) => ({ g: loadStore(localStorage, storeKey('')), p: loadStore(localStorage, storeKey(chat.cwd)) });
const saveG = (st) => saveStore(localStorage, storeKey(''), st);
const saveP = (chat, st) => saveStore(localStorage, storeKey(chat.cwd), st);

/** Custom workflows from both stores, project first, each tagged with where it is saved. */
function customList(s) {
  return s.p.custom.map((c) => ({ ...c, scope: 'project' })).concat(s.g.custom.map((c) => ({ ...c, scope: 'global' })));
}

function defOf(key, s) {
  if (WORKFLOWS[key]) return { wf: WORKFLOWS[key] };
  const c = customList(s).find((x) => x.key === key);
  return c ? { wf: customToWorkflow(c), custom: c } : null;
}

/** Every menu row: built-in groups plus custom ones. */
function allRows(s) {
  const rows = [];
  for (const [group, cls, items] of WORKFLOW_MENU) {
    for (const [key, icon, label, hint] of items) rows.push({ key, icon, label, hint, group, cls });
  }
  for (const c of customList(s)) {
    const gi = WORKFLOW_MENU.find((g) => g[0] === c.group);
    rows.push({ key: c.key, icon: c.icon, label: c.label, hint: c.hint, group: c.group, cls: gi ? gi[1] : 'wf-c-build', custom: true });
  }
  return rows;
}

function labelOf(key, s) {
  const r = allRows(s).find((x) => x.key === key);
  return r ? r.label : key;
}

function basePrompt(key, s, chat) {
  const override = s.p.prompts[key];
  if (override) return override;
  const d = defOf(key, s);
  return d ? d.wf.prompt(chat.cwd) : '';
}

/* ---------------- running ---------------- */

/** Three choices for a half-typed message the workflow would overwrite. */
function chooseDraft() {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', '', 'You have text in the message box'));
    modal.appendChild(el('p', 'hint', 'This workflow sends its own prompt. What should happen to your text?'));
    const row = el('div', 'inline');
    const done = (v) => { overlay.remove(); resolve(v); };
    for (const [label, v] of [['Use as extra notes', 'extra'], ['Replace it', 'replace'], ['Cancel', 'cancel']]) {
      const b = el('button', v === 'extra' ? 'primary' : '', label);
      b.addEventListener('click', () => done(v));
      row.appendChild(b);
    }
    modal.appendChild(row);
    overlay.appendChild(modal);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') done('cancel'); });
    document.body.appendChild(overlay);
    row.querySelector('button').focus();
  });
}

/** How a workflow run ended, for the history line. */
export function finishWorkflowRun(chat, end) {
  if (!chat.wfRunning) return;
  const { key } = chat.wfRunning;
  chat.wfRunning = null;
  const s = stores(chat);
  saveP(chat, recordRun(s.p, key, end));
}

/** Take the chain items out of the queue (Stop was pressed). */
export function cancelChain(chat) {
  const all = chat.pendingMsgs || [];
  const keep = all.filter((i) => !i.chain);
  if (keep.length === all.length) return;
  setQueue(chat, keep);
  toast('Workflow chain stopped');
}

async function runWorkflow(chat, send, key, once = {}) {
  const s = stores(chat);
  const d = defOf(key, s);
  if (!d || !chat.alive) return;
  const { wf } = d;
  const o = mergeOptions(wf, s.g, s.p, key, once);
  const draft = chat.composer.value;
  const plan = planRun(wf, o, { draft, busy: chat.busy });
  let command = plan.command;

  if (plan.askAboutDraft) {
    const choice = await chooseDraft();
    if (choice === 'cancel') return;
    if (choice === 'extra') command = [command, draft.trim()].filter(Boolean).join('\n');
  }

  // Mode, model and effort for this run, put back afterwards unless the user opts out.
  const wantMode = neededMode(wf, o, chat.mode);
  const apply = { mode: wantMode && wantMode !== chat.mode ? wantMode : '', model: o.model, effort: o.effort };
  if (apply.mode || apply.model || apply.effort) {
    const before = chat.restoreAfterTurn;
    await applyOverrides(chat, apply);
    if (!o.restoreMode && chat.restoreAfterTurn && !before) {
      delete chat.restoreAfterTurn.mode;   // the user wants the new mode to stay
      if (!Object.keys(chat.restoreAfterTurn).length) chat.restoreAfterTurn = null;
    }
    if (apply.mode) toast('Mode → ' + modeLabel(chat.mode));
  }

  const text = buildPrompt(basePrompt(key, s, chat), wf, o, command);
  const label = labelOf(key, s);

  saveP(chat, recordRun(noteRecent(s.p, key), key, 'start'));
  chat.wfRunning = { key };

  const followUps = chainSteps(o.then, WORKFLOWS);
  const chainId = followUps.length ? 'c' + Date.now().toString(36) : '';

  if (plan.destination === 'composer') {
    chat.composer.value = text;
    autosize(chat.composer);
    chat.composer.focus();
    chat.composer.setSelectionRange(text.length, text.length);
  } else if (plan.destination === 'queue') {
    enqueue(chat, { text }, { label, chain: chainId ? { id: chainId } : undefined });
    toast('Queued: ' + label);
    if (!chat.busy) drainQueue(chat);
  } else {
    chat.composer.value = text;
    autosize(chat.composer);
    send();
  }

  // The follow-ups wait in the queue and run one after the other.
  for (const step of followUps) {
    const fd = defOf(step.key, s);
    if (!fd) continue;
    const fo = mergeOptions(fd.wf, s.g, s.p, step.key);
    const fmode = neededMode(fd.wf, fo, '');
    enqueue(chat, { text: buildPrompt(basePrompt(step.key, s, chat), fd.wf, fo, command) }, {
      label: labelOf(step.key, s), ask: step.ask, mode: fmode === 'plan' ? 'plan' : fo.mode || undefined,
      model: fo.model || undefined, effort: fo.effort || undefined, chain: { id: chainId },
    });
  }
  if (followUps.length) toast('Chain queued: ' + followUps.length + ' more step' + (followUps.length > 1 ? 's' : ''));
}

/* ---------------- the menu ---------------- */

export function wireWorkflowPicker(chat, send) {
  if (!chat.wfBtn) return;
  let menu = null;
  const close = () => {
    if (!menu) return;
    menu.remove(); menu = null;
    chat.wfBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', away, true);
  };
  const away = (e) => { if (menu && !menu.contains(e.target) && !chat.wfBtn.contains(e.target) && !e.target.closest('.modal-overlay')) close(); };

  chat.wfBtn.addEventListener('click', () => {
    if (menu) return close();
    menu = el('div', 'wf-menu');
    menu.setAttribute('role', 'menu');
    chat.pane.querySelector('.chat-composer').appendChild(menu);
    chat.wfBtn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('mousedown', away, true), 0);
    drawList();
  });

  /** Redraw the whole menu body: top inputs, groups, footer. */
  function drawList(filter = '') {
    const s = stores(chat);
    const rows = allRows(s);
    const hidden = new Set(s.p.hidden.concat(s.g.hidden));
    menu.textContent = '';

    // Your command: sent together with the workflow you pick.
    const cmd = el('textarea', 'wf-command');
    cmd.rows = 2;
    cmd.placeholder = 'Your command, sent with the workflow you pick (optional)';
    cmd.setAttribute('aria-label', 'Your command, sent with the workflow');
    cmd.value = chat.wfCommand || '';
    cmd.addEventListener('input', () => { chat.wfCommand = cmd.value; });
    cmd.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { close(); chat.wfBtn.focus(); } });
    menu.appendChild(cmd);
    const flt = el('input', 'wf-filter');
    flt.type = 'search';
    flt.placeholder = 'Filter workflows…';
    flt.setAttribute('aria-label', 'Filter workflows');
    flt.value = filter;
    flt.addEventListener('input', () => { drawList(flt.value); const f = menu.querySelector('.wf-filter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); });
    flt.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { close(); chat.wfBtn.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); const f = menu.querySelector('.wf-item'); if (f) f.focus(); }
    });
    menu.appendChild(flt);

    const visible = filterRows(rows.filter((r) => !hidden.has(r.key)), filter);
    const byKey = new Map(visible.map((r) => [r.key, r]));
    let n = 0;
    const renderRow = (sec, r) => {
      const d = defOf(r.key, s);
      if (!d) return;
      const wrap = el('div', 'wf-row');
      const b = el('button', 'wf-item');
      b.setAttribute('role', 'menuitem');
      b.dataset.wf = r.key;
      n += 1;
      if (n <= 9) b.dataset.num = String(n);
      b.appendChild(elIcon('span', 'wf-ico', CCEIcons.svg(r.icon, 14)));
      const txt = el('span', 'wf-txt');
      const title = el('b', '', r.label);
      const o = mergeOptions(d.wf, s.g, s.p, r.key);
      if (s.p.opts[r.key] || s.g.opts[r.key] || s.p.prompts[r.key]) {
        const dot = el('span', 'wf-dot', s.p.prompts[r.key] ? ' ● edited' : ' ●');
        dot.title = s.p.prompts[r.key] ? 'Prompt edited for this project' : 'Has saved options';
        title.appendChild(dot);
      }
      if (r.custom) title.appendChild(el('span', 'wf-custom', 'custom'));
      txt.appendChild(title);
      const how = o.run === 'now' ? 'runs now' : o.run === 'queue' ? 'goes to the queue' : o.run === 'wait' ? 'you add the details' : (d.wf.fill ? 'you add the details' : 'runs now');
      txt.appendChild(el('span', '', r.hint + ' · ' + how));
      b.appendChild(txt);
      b.addEventListener('click', (e) => {
        // Shift+click puts the prompt in the box instead of sending it.
        const once = e.shiftKey ? { run: 'wait' } : {};
        if (chat.wfCommand && chat.wfCommand.trim()) once.command = [o.command, chat.wfCommand.trim()].filter(Boolean).join('\n');
        close();
        runWorkflow(chat, send, r.key, once);
      });
      const more = el('button', 'wf-more', '⋯');
      more.title = 'Options for ' + r.label;
      more.setAttribute('aria-label', 'Options for ' + r.label);
      more.addEventListener('click', () => drawOptions(r.key, r));
      wrap.appendChild(b);
      wrap.appendChild(more);
      b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); drawOptions(r.key, r); } });
      sec.appendChild(wrap);
    };
    const section = (name, cls, list) => {
      if (!list.length) return;
      const sec = el('div', 'wf-group ' + cls);
      sec.appendChild(el('div', 'wf-group-name', name));
      for (const r of list) renderRow(sec, r);
      menu.appendChild(sec);
    };

    if (!filter) {
      const chains = el('div', 'wf-chains');
      for (const c of CHAINS) {
        const b = el('button', 'wf-chain', c.label);
        b.title = 'Run the first step now and queue the rest';
        b.addEventListener('click', () => {
          close();
          const once = { then: chainFromPreset(c) };
          if (chat.wfCommand && chat.wfCommand.trim()) once.command = chat.wfCommand.trim();
          runWorkflow(chat, send, c.steps[0], once);
        });
        chains.appendChild(b);
      }
      menu.appendChild(chains);
      section('Pinned', 'wf-c-pin', s.p.pinned.concat(s.g.pinned).map((k) => byKey.get(k)).filter(Boolean));
      section('Recent', 'wf-c-recent', s.p.recent.map((k) => byKey.get(k)).filter(Boolean));
    }
    for (const g of GROUPS) {
      const gi = WORKFLOW_MENU.find((x) => x[0] === g);
      section(g, gi ? gi[1] : 'wf-c-build', visible.filter((r) => r.group === g));
    }
    if (!visible.length) menu.appendChild(el('div', 'hint wf-empty', 'No workflow matches.'));

    const foot = el('div', 'wf-foot');
    const add = el('button', 'wf-footbtn', '+ New workflow');
    add.addEventListener('click', () => drawEditor(null));
    foot.appendChild(add);
    const exp = el('button', 'wf-footbtn', 'Export custom');
    exp.addEventListener('click', async () => {
      const list = customList(stores(chat)).map(({ scope, ...c }) => c);
      if (!list.length) return toast('No custom workflows to export');
      const r = await ccx.invoke('clipboard:write', { text: exportCustom(list) });
      toast(r && r.ok ? 'Copied ' + list.length + ' workflow' + (list.length > 1 ? 's' : '') + ' as JSON' : 'Copy failed', r && r.ok ? 'ok' : 'err');
    });
    foot.appendChild(exp);
    const imp = el('button', 'wf-footbtn', 'Import');
    imp.addEventListener('click', async () => {
      const text = await window.askText('Paste exported workflows (JSON)', '', { multiline: true, okLabel: 'Import' });
      if (text === null || !menu) return;
      const st = stores(chat);
      const r = importCustom(text, customList(st).map((c) => c.key));
      if (r.error) return toast(r.error, 'err');
      st.p.custom = st.p.custom.concat(r.workflows);
      saveP(chat, st.p);
      toast('Imported ' + r.workflows.length + ' workflow' + (r.workflows.length > 1 ? 's' : ''), 'ok');
      drawList();
    });
    foot.appendChild(imp);
    menu.appendChild(foot);

    menu.onkeydown = (e) => {
      const items = [...menu.querySelectorAll('.wf-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); chat.wfBtn.focus(); }
      else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (/^[1-9]$/.test(e.key) && i >= 0) { const t = menu.querySelector('.wf-item[data-num="' + e.key + '"]'); if (t) { e.preventDefault(); t.click(); } }
    };
    if (!filter) { const first = menu.querySelector('.wf-item'); if (first) first.focus(); }
  }

  /* ---- options for one workflow ---- */
  function drawOptions(key, row) {
    const s = stores(chat);
    const d = defOf(key, s);
    if (!d) return;
    const { wf } = d;
    const cur = mergeOptions(wf, s.g, s.p, key);
    menu.textContent = '';
    menu.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); drawList(); } };

    const head = el('div', 'wfo-head');
    const back = el('button', 'wf-footbtn', '← Back');
    back.addEventListener('click', () => drawList());
    head.appendChild(back);
    head.appendChild(el('b', '', row.label));
    menu.appendChild(head);

    const form = el('div', 'wfo-form');
    const field = (label, node) => { const w = el('label', 'wfo-field'); w.appendChild(el('span', '', label)); w.appendChild(node); form.appendChild(w); return node; };
    const select = (opts, value) => {
      const sel = el('select');
      for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; sel.appendChild(o); }
      sel.value = value;
      return sel;
    };

    const run = field('When I pick it', select([['', 'Default (' + (wf.fill ? 'wait for my words' : 'run now') + ')'], ['wait', 'Put it in the message box'], ['now', 'Send it now'], ['queue', 'Add it to the queue']], cur.run));
    const command = field('Your command (sent with the workflow)', el('textarea'));
    command.rows = 3;
    command.value = cur.command;
    command.placeholder = 'For example: use vitest, explain for a beginner, only look at src/main';
    const mode = field('Permission mode', select([['', 'Keep current'], ['plan', 'Plan (no edits)'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto']], cur.mode));
    const model = field('Model for this workflow', el('input'));
    model.value = cur.model;
    model.placeholder = 'Keep current';
    const effort = field('Effort', select([['', 'Keep current']].concat((chat.effortLevels || []).map((x) => [x, x])), cur.effort));
    const scope = field('Scope', select([['repo', 'Whole project'], ['diff', 'Current changes (git diff)'], ['staged', 'Staged changes'], ['files', 'Chosen files or folders']], cur.scope));
    const paths = field('Files or folders', el('input'));
    paths.value = cur.scopePaths;
    paths.placeholder = 'src/main, README.md';
    const syncPaths = () => { paths.parentNode.classList.toggle('hidden', scope.value !== 'files'); };
    scope.addEventListener('change', syncPaths);
    syncPaths();
    const checks = el('div', 'wfo-checks');
    const check = (label, on) => { const l = el('label', 'check'); const c = el('input'); c.type = 'checkbox'; c.checked = on; l.appendChild(c); l.appendChild(el('span', '', label)); checks.appendChild(l); return c; };
    const ro = check('Read-only: no file changes (forces plan mode)', cur.readOnly);
    const restore = check('Put the permission mode back after the run', cur.restoreMode);
    form.appendChild(checks);

    // Follow-up chain
    const thenBox = el('div', 'wfo-then');
    thenBox.appendChild(el('span', 'wfo-label', 'Then run (up to 4, each after the one before)'));
    const thenList = cur.then.map((t) => ({ ...t }));
    const addThen = el('button', 'wf-footbtn', '+ Add step');
    const drawThen = () => {
      for (const n of [...thenBox.querySelectorAll('.wfo-then-row')]) n.remove();
      thenList.forEach((t, i) => {
        const r = el('div', 'wfo-then-row');
        const keys = allRows(s).filter((x) => x.key !== key);
        const ks = select(keys.map((x) => [x.key, x.label]), t.key);
        ks.addEventListener('change', () => { t.key = ks.value; });
        const gs = select([['auto', 'Auto'], ['ask', 'Ask first']], t.gate);
        gs.title = 'Auto: runs when the turn ends without an error. Ask first: waits for your OK.';
        gs.addEventListener('change', () => { t.gate = gs.value; });
        const rm = el('button', 'wf-footbtn', '×');
        rm.setAttribute('aria-label', 'Remove step');
        rm.addEventListener('click', () => { thenList.splice(i, 1); drawThen(); });
        r.appendChild(ks); r.appendChild(gs); r.appendChild(rm);
        thenBox.insertBefore(r, addThen);
      });
      addThen.classList.toggle('hidden', thenList.length >= 4);
    };
    addThen.addEventListener('click', () => {
      const first = allRows(s).find((x) => x.key !== key);
      if (first) { thenList.push({ key: first.key, gate: 'auto' }); drawThen(); }
    });
    thenBox.appendChild(addThen);
    form.appendChild(thenBox);
    drawThen();

    const collect = () => cleanOptions({
      run: run.value, command: command.value, mode: mode.value, model: model.value.trim(), effort: effort.value,
      scope: scope.value, scopePaths: paths.value, readOnly: ro.checked, restoreMode: restore.checked, then: thenList,
    });

    // Prompt: shown as text, editable per project
    const pbox = el('div', 'wfo-prompt');
    const pre = el('pre', 'wfo-pre');
    const refreshPre = () => {
      const o = { ...cur, ...collect() };
      const p = planRun(wf, o, { draft: chat.composer.value, busy: chat.busy });
      pre.textContent = buildPrompt(basePrompt(key, stores(chat), chat), wf, o, p.command);
    };
    pbox.appendChild(el('span', 'wfo-label', 'Prompt that will be sent'));
    pbox.appendChild(pre);
    const editBtn = el('button', 'wf-footbtn', 'Edit prompt');
    editBtn.addEventListener('click', async () => {
      const t = await window.askText('Prompt for "' + row.label + '" (this project)', basePrompt(key, stores(chat), chat), { multiline: true, okLabel: 'Save' });
      if (t === null || !menu) return;
      const st = stores(chat);
      if (t.trim()) st.p.prompts[key] = t; else delete st.p.prompts[key];
      saveP(chat, st.p);
      drawOptions(key, row);
    });
    pbox.appendChild(editBtn);
    if (s.p.prompts[key]) {
      const reset = el('button', 'wf-footbtn', 'Reset prompt');
      reset.addEventListener('click', () => { const st = stores(chat); delete st.p.prompts[key]; saveP(chat, st.p); drawOptions(key, row); });
      pbox.appendChild(reset);
    }
    form.appendChild(pbox);
    form.appendChild(el('div', 'hint', historyLine((s.p.history || {})[key])));
    menu.appendChild(form);
    form.addEventListener('input', refreshPre);
    form.addEventListener('change', refreshPre);
    refreshPre();

    const bar = el('div', 'wfo-bar');
    const btn = (label, cls, fn) => { const b = el('button', cls, label); b.addEventListener('click', fn); bar.appendChild(b); return b; };
    btn('Run once with these', 'primary', () => { const o = collect(); close(); runWorkflow(chat, send, key, { ...o, run: o.run || (wf.fill ? 'wait' : 'now') }); });
    btn('Save for this project', '', () => { const st = stores(chat); st.p.opts[key] = collect(); saveP(chat, st.p); toast('Saved for this project', 'ok'); drawList(); });
    btn('Save everywhere', '', () => { const st = stores(chat); st.g.opts[key] = collect(); saveG(st.g); toast('Saved for all projects', 'ok'); drawList(); });
    btn('Reset', '', () => { const st = stores(chat); delete st.p.opts[key]; delete st.g.opts[key]; saveP(chat, st.p); saveG(st.g); drawOptions(key, row); });
    const pinned = s.p.pinned.includes(key) || s.g.pinned.includes(key);
    btn(pinned ? 'Unpin' : 'Pin', '', () => { const st = stores(chat); st.p.pinned = toggleIn(st.p.pinned, key); st.g.pinned = st.g.pinned.filter((k) => k !== key); saveP(chat, st.p); saveG(st.g); drawList(); });
    btn('Hide', '', () => { const st = stores(chat); st.p.hidden = toggleIn(st.p.hidden, key); saveP(chat, st.p); toast('Hidden. Show it again from Settings.'); drawList(); });
    btn('Duplicate', '', () => drawEditor({ label: row.label + ' copy', hint: row.hint, group: row.group, icon: row.icon, prompt: basePrompt(key, s, chat), fill: !!wf.fill, opts: collect() }));
    if (d.custom) {
      btn('Edit', '', () => drawEditor(d.custom));
      btn('Delete', '', () => {
        const st = stores(chat);
        st.p.custom = st.p.custom.filter((c) => c.key !== key);
        st.g.custom = st.g.custom.filter((c) => c.key !== key);
        saveP(chat, st.p); saveG(st.g);
        toast('Deleted ' + row.label);
        drawList();
      });
    }
    menu.appendChild(bar);
  }

  /* ---- create or edit a custom workflow ---- */
  function drawEditor(existing) {
    menu.textContent = '';
    menu.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); drawList(); } };
    const isEdit = !!(existing && existing.key);
    const head = el('div', 'wfo-head');
    const back = el('button', 'wf-footbtn', '← Back');
    back.addEventListener('click', () => drawList());
    head.appendChild(back);
    head.appendChild(el('b', '', isEdit ? 'Edit workflow' : 'New workflow'));
    menu.appendChild(head);
    const form = el('div', 'wfo-form');
    const field = (label, node) => { const w = el('label', 'wfo-field'); w.appendChild(el('span', '', label)); w.appendChild(node); form.appendChild(w); return node; };
    const name = field('Name', el('input')); name.value = (existing && existing.label) || '';
    const hint = field('One-line hint', el('input')); hint.value = (existing && existing.hint) || '';
    const group = field('Group', el('select'));
    for (const g of GROUPS) { const o = el('option', '', g); o.value = g; group.appendChild(o); }
    group.value = (existing && existing.group) || 'Build';
    const icon = field('Icon', el('select'));
    for (const i of ICONS) { const o = el('option', '', i); o.value = i; icon.appendChild(o); }
    icon.value = (existing && existing.icon) || 'bolt';
    const prompt = field('Prompt', el('textarea')); prompt.rows = 6; prompt.value = (existing && existing.prompt) || '';
    const fl = el('label', 'check'); const fill = el('input'); fill.type = 'checkbox'; fill.checked = !!(existing && existing.fill);
    fl.appendChild(fill); fl.appendChild(el('span', '', 'Wait for my details (the prompt ends where I type)')); form.appendChild(fl);
    const where = field('Save', el('select'));
    for (const [v, t] of [['project', 'For this project'], ['global', 'For all projects']]) { const o = el('option', '', t); o.value = v; where.appendChild(o); }
    where.value = (existing && existing.scope) || 'project';
    menu.appendChild(form);
    const bar = el('div', 'wfo-bar');
    const save = el('button', 'primary', 'Save');
    save.addEventListener('click', () => {
      const st = stores(chat);
      const taken = customList(st).map((c) => c.key).concat(Object.keys(WORKFLOWS));
      const r = validateCustom({ ...(existing || {}), label: name.value, hint: hint.value, group: group.value, icon: icon.value, prompt: prompt.value, fill: fill.checked }, taken);
      if (r.error) return toast(r.error, 'err');
      for (const t of [st.p, st.g]) t.custom = t.custom.filter((c) => c.key !== r.value.key);
      (where.value === 'global' ? st.g : st.p).custom.push(r.value);
      saveP(chat, st.p); saveG(st.g);
      toast('Saved ' + r.value.label, 'ok');
      drawList();
    });
    bar.appendChild(save);
    menu.appendChild(bar);
    name.focus();
  }
}
