// Options for the workflow picker as plain data: merging saved options,
// building the final prompt, the chain, custom workflows, history. No DOM.

export const RUN_MODES = ['wait', 'now', 'queue'];
export const SCOPES = ['repo', 'diff', 'staged', 'files'];
export const MODES = ['', 'plan', 'acceptEdits', 'auto'];
export const GROUPS = ['Understand', 'Plan', 'Build', 'Verify', 'Ship'];
export const FINISHES = ['', 'test', 'summary'];

/** The last step a workflow adds to its prompt, so the run ends by proving its result. */
export const FINISH_LINES = {
  test: 'When you are done: run the project\'s tests and checks, and show the result. If something fails, say so plainly.',
  summary: 'When you are done: give a short summary of what changed, which files, and anything left to do.',
};

const MAX_CHAIN = 4;
const MAX_HISTORY = 50;

export const BASE_OPTIONS = {
  run: '', mode: '', model: '', effort: '', scope: 'repo', scopePaths: '',
  command: '', readOnly: false, restoreMode: true, finish: '', then: [],
};

export function emptyStore() {
  return { opts: {}, prompts: {}, pinned: [], hidden: [], custom: [], recent: [], history: {} };
}

/** Short stable id for a folder, used in storage keys. */
export function hashCwd(cwd) {
  let h = 5381;
  for (const ch of String(cwd || '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

export const storeKey = (cwd) => (cwd ? 'cce.wf.' + hashCwd(cwd) : 'cce.wf');

export function loadStore(storage, key) {
  try {
    const v = JSON.parse(storage.getItem(key) || 'null');
    return v && typeof v === 'object' ? { ...emptyStore(), ...v } : emptyStore();
  } catch { return emptyStore(); }
}

export function saveStore(storage, key, store) {
  try { storage.setItem(key, JSON.stringify(store)); return true; } catch { return false; }
}

/** Keep only values the options form can produce. */
export function cleanOptions(o = {}) {
  const out = {};
  if (RUN_MODES.includes(o.run)) out.run = o.run;
  if (MODES.includes(o.mode) && o.mode) out.mode = o.mode;
  if (typeof o.model === 'string' && o.model) out.model = o.model.slice(0, 120);
  if (typeof o.effort === 'string' && o.effort) out.effort = o.effort.slice(0, 20);
  if (SCOPES.includes(o.scope) && o.scope !== 'repo') out.scope = o.scope;
  if (typeof o.scopePaths === 'string' && o.scopePaths.trim()) out.scopePaths = o.scopePaths.slice(0, 500);
  if (typeof o.command === 'string' && o.command.trim()) out.command = o.command.slice(0, 4000);
  if (typeof o.readOnly === 'boolean') out.readOnly = o.readOnly;
  if (typeof o.restoreMode === 'boolean') out.restoreMode = o.restoreMode;
  if (FINISHES.includes(o.finish) && o.finish) out.finish = o.finish;
  if (Array.isArray(o.then)) {
    out.then = o.then.filter((t) => t && typeof t.key === 'string').slice(0, MAX_CHAIN)
      .map((t) => ({ key: t.key, gate: t.gate === 'ask' ? 'ask' : 'auto' }));
  }
  return out;
}

/**
 * Built-in default, then global saved, then project saved, then this run only.
 * Later wins field by field.
 */
export function mergeOptions(wf, globalStore, projectStore, key, once = {}) {
  const builtin = { readOnly: !!(wf && wf.readOnly) };
  return {
    ...BASE_OPTIONS,
    ...builtin,
    ...cleanOptions((globalStore.opts || {})[key]),
    ...cleanOptions((projectStore.opts || {})[key]),
    ...cleanOptions(once),
  };
}

export function scopeLine(o) {
  if (o.scope === 'diff') return 'Scope: only the current uncommitted changes (git diff).';
  if (o.scope === 'staged') return 'Scope: only the staged changes (git diff --staged).';
  if (o.scope === 'files' && o.scopePaths) return 'Scope: only these files or folders: ' + o.scopePaths.trim() + '.';
  return '';
}

export const READ_ONLY_LINE = 'Read-only: do not create, edit or delete any file, and do not run commands that change state.';

/**
 * The text that goes to the chat: the workflow prompt, the scope, the
 * read-only rule, and the user's own command (from planRun).
 * A workflow that waits for details ends with "…: " so the command goes right
 * after it. A self-contained one gets the command as extra instructions.
 */
export function buildPrompt(base, wf, o, command = '') {
  const cmd = String(command || '').trim();
  const lines = [scopeLine(o), o.readOnly ? READ_ONLY_LINE : '', FINISH_LINES[o.finish] || ''].filter(Boolean);
  let text = String(base);
  if (wf.fill) {
    text += cmd;
    if (lines.length) text += (cmd ? '\n\n' : '') + lines.join('\n');
  } else {
    if (lines.length) text += '\n\n' + lines.join('\n');
    if (cmd) text += '\n\nExtra instructions from the user: ' + cmd;
  }
  return text;
}

/**
 * Decide what a click does.
 * - wait: put the prompt in the box, the user adds words and sends
 * - now: send it
 * - queue: add it to the queue (used when the chat is busy)
 * A workflow that needs details and has none always waits. The returned
 * command is what buildPrompt() receives as its last argument.
 */
export function planRun(wf, o, { draft = '', busy = false } = {}) {
  const d = String(draft || '').trim();
  // A workflow that asks for details takes the draft as its command.
  const command = [o.command, wf.fill ? d : ''].map((x) => String(x || '').trim()).filter(Boolean).join('\n');
  const needsWords = !!wf.fill && !command;
  // With your command (or a draft) a "fill" workflow has all it needs, so it sends.
  let run = o.run || (needsWords ? 'wait' : 'now');
  if (needsWords) run = 'wait';
  let destination = run === 'wait' ? 'composer' : 'send';
  if (run === 'queue' || (busy && destination === 'send')) destination = 'queue';
  // A self-contained workflow would overwrite a half-typed message: ask first.
  return { run, destination, command, needsWords, askAboutDraft: !!d && !wf.fill };
}

/** The mode this run needs: read-only and plan workflows go to plan; leaving plan is allowed. */
export function neededMode(wf, o, currentMode) {
  if (o.readOnly) return 'plan';
  if (o.mode) return o.mode;
  if (wf.mode === 'plan') return 'plan';
  if (currentMode === 'plan' && wf.mode) return wf.mode;
  return '';
}

/** Follow-up workflows as queue items' descriptions. */
export function chainSteps(then, WORKFLOWS) {
  return (then || []).filter((t) => WORKFLOWS[t.key]).slice(0, MAX_CHAIN).map((t) => ({ key: t.key, ask: t.gate === 'ask' }));
}

export function chainFromPreset(preset) {
  return preset.steps.slice(1).map((key) => ({ key, gate: 'auto' }));
}

/** Pin, hide, recent. */
export function toggleIn(list, key) {
  return list.includes(key) ? list.filter((k) => k !== key) : list.concat(key);
}

export function noteRecent(store, key) {
  return { ...store, recent: [key].concat(store.recent.filter((k) => k !== key)).slice(0, 3) };
}

export function recordRun(store, key, end, now = Date.now()) {
  const h = { ...(store.history[key] || { runs: 0 }) };
  if (end === 'start') { h.runs += 1; h.last = now; h.end = 'running'; } else { h.end = end; }
  const history = { ...store.history, [key]: h };
  const keys = Object.keys(history);
  if (keys.length > MAX_HISTORY) {
    keys.sort((a, b) => (history[a].last || 0) - (history[b].last || 0));
    for (const k of keys.slice(0, keys.length - MAX_HISTORY)) delete history[k];
  }
  return { ...store, history };
}

export function historyLine(h) {
  if (!h || !h.runs) return 'Never run here';
  return h.runs + (h.runs === 1 ? ' run' : ' runs') + ' · last ' + new Date(h.last).toLocaleString() + ' · ' + (h.end || 'finished');
}

/** Filter menu rows by name and hint. */
export function filterRows(rows, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => (r.label + ' ' + r.hint + ' ' + r.key).toLowerCase().includes(s));
}

/** A custom workflow from the editor, or null with the reason. */
export function validateCustom(c, takenKeys = []) {
  const label = String((c && c.label) || '').trim();
  const prompt = String((c && c.prompt) || '').trim();
  if (!label) return { error: 'Give the workflow a name.' };
  if (!prompt) return { error: 'The prompt is empty.' };
  const base = 'custom-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const key = (c.key && String(c.key).startsWith('custom-')) ? c.key : base;
  let unique = key;
  let n = 2;
  while (takenKeys.includes(unique) && unique !== c.key) unique = key + '-' + n++;
  return {
    value: {
      key: unique,
      label: label.slice(0, 60),
      hint: String(c.hint || '').slice(0, 100),
      group: GROUPS.includes(c.group) ? c.group : 'Build',
      icon: String(c.icon || 'bolt').slice(0, 20),
      prompt: prompt.slice(0, 20000),
      fill: !!c.fill,
      mode: MODES.includes(c.mode) ? c.mode : '',
      opts: cleanOptions(c.opts || {}),
    },
  };
}

/** Custom workflow as a runnable definition. */
export function customToWorkflow(c) {
  return { mode: c.mode || 'acceptEdits', fill: !!c.fill, readOnly: !!(c.opts && c.opts.readOnly), prompt: () => c.prompt, custom: true };
}

export function exportCustom(list) {
  return JSON.stringify({ cceWorkflows: 1, workflows: list }, null, 2);
}

/** Read an export. Bad input gives an error, never a throw. */
export function importCustom(text, taken = []) {
  let v;
  try { v = JSON.parse(text); } catch { return { error: 'That is not valid JSON.' }; }
  if (!v || v.cceWorkflows !== 1 || !Array.isArray(v.workflows)) return { error: 'That file is not a workflow export.' };
  const out = [];
  const used = taken.slice();
  for (const c of v.workflows.slice(0, 100)) {
    const r = validateCustom({ ...c, key: undefined }, used);
    if (r.value) { out.push(r.value); used.push(r.value.key); }
  }
  return out.length ? { workflows: out } : { error: 'No usable workflows in that file.' };
}
