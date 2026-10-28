// Chat upgrade, phase 3 (0.9.92): options on the existing workflow picker,
// including "your command" sent along with the workflow.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const w = await import('../src/renderer/chat/wfoptions.js');
const { WORKFLOWS, WORKFLOW_MENU, CHAINS } = await import('../src/renderer/chat/wfdata.js');

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const fillWf = { fill: true, prompt: () => 'Task: ' };
const nowWf = { fill: false, prompt: () => 'Review.' };

describe('option merge', () => {
  it('later layers win field by field: built-in, global, project, once', () => {
    const g = { ...w.emptyStore(), opts: { review: { mode: 'plan', effort: 'low' } } };
    const p = { ...w.emptyStore(), opts: { review: { effort: 'high' } } };
    const o = w.mergeOptions({ readOnly: true }, g, p, 'review', { command: 'be brief' });
    expect(o).toMatchObject({ readOnly: true, mode: 'plan', effort: 'high', command: 'be brief', restoreMode: true });
  });
  it('drops values the form cannot produce', () => {
    expect(w.cleanOptions({ run: 'x', scope: 'nope', mode: 'root', then: [{ key: 'a', gate: 'weird' }, null] })).toEqual({ then: [{ key: 'a', gate: 'auto' }] });
    expect(w.cleanOptions({ then: Array.from({ length: 9 }, (_, i) => ({ key: 'k' + i })) }).then.length).toBe(4);
  });
  it('survives corrupt storage', () => {
    const st = mem(); st.setItem('k', '{bad');
    expect(w.loadStore(st, 'k')).toEqual(w.emptyStore());
  });
});

describe('your command is sent with the workflow', () => {
  it('a workflow that asks for details gets the command right after the prompt', () => {
    const o = w.mergeOptions(fillWf, w.emptyStore(), w.emptyStore(), 'x', {});
    const plan = w.planRun(fillWf, { ...o, command: 'the login bug' }, {});
    expect(plan).toMatchObject({ destination: 'send', needsWords: false });
    expect(w.buildPrompt('Task: ', fillWf, o, plan.command)).toBe('Task: the login bug');
  });
  it('a self-contained workflow gets it as extra instructions', () => {
    const o = w.mergeOptions(nowWf, w.emptyStore(), w.emptyStore(), 'x', {});
    expect(w.buildPrompt('Review.', nowWf, o, 'only src/main')).toBe('Review.\n\nExtra instructions from the user: only src/main');
  });
  it('without a command a "fill" workflow still waits in the box', () => {
    expect(w.planRun(fillWf, { run: '', command: '' }, {})).toMatchObject({ destination: 'composer', needsWords: true });
  });
  it('"put it in the box" never sends, even with a command', () => {
    expect(w.planRun(nowWf, { run: 'wait', command: 'x' }, {}).destination).toBe('composer');
  });
});

describe('what a click does', () => {
  it('a typed draft is used as the command by a fill workflow, never lost', () => {
    const p = w.planRun(fillWf, { run: '' }, { draft: 'my bug' });
    expect(p.command).toBe('my bug');
    expect(p.askAboutDraft).toBe(false);
  });
  it('a self-contained workflow asks before it would overwrite a draft', () => {
    expect(w.planRun(nowWf, { run: '' }, { draft: 'half typed' }).askAboutDraft).toBe(true);
    expect(w.planRun(nowWf, { run: '' }, { draft: '  ' }).askAboutDraft).toBe(false);
  });
  it('a busy chat queues instead of sending', () => {
    expect(w.planRun(nowWf, { run: '' }, { busy: true }).destination).toBe('queue');
    expect(w.planRun(nowWf, { run: 'queue' }, {}).destination).toBe('queue');
  });
});

describe('scope, read-only, mode', () => {
  it('adds one scope line and the read-only rule', () => {
    const o = { ...w.BASE_OPTIONS, scope: 'staged', readOnly: true };
    const t = w.buildPrompt('Review.', nowWf, o, '');
    expect(t).toContain('only the staged changes');
    expect(t).toContain(w.READ_ONLY_LINE);
    expect(w.scopeLine({ scope: 'files', scopePaths: 'src/a.js' })).toContain('src/a.js');
    expect(w.scopeLine({ scope: 'files', scopePaths: '' })).toBe('');
  });
  it('read-only forces plan; leaving plan is allowed; auto is never downgraded', () => {
    expect(w.neededMode({ mode: 'acceptEdits' }, { readOnly: true }, 'auto')).toBe('plan');
    expect(w.neededMode({ mode: 'acceptEdits' }, {}, 'plan')).toBe('acceptEdits');
    expect(w.neededMode({ mode: 'acceptEdits' }, {}, 'auto')).toBe('');
    expect(w.neededMode({ mode: 'plan' }, {}, 'auto')).toBe('plan');
  });
  it('built-in defaults: security and explain are read-only', () => {
    expect(WORKFLOWS.security.readOnly && WORKFLOWS.explain.readOnly).toBe(true);
    expect(WORKFLOWS.derisk.readOnly && WORKFLOWS['verify-live'].readOnly).toBe(true);
  });
});

describe('data', () => {
  it('every menu row has a workflow, and the new ones are in', () => {
    for (const [, , rows] of WORKFLOW_MENU) for (const [key] of rows) expect(WORKFLOWS[key]).toBeTruthy();
    for (const k of ['upgrade-plan', 'derisk', 'verify-live', 'release']) expect(WORKFLOW_MENU.flat(3).includes(k)).toBe(true);
  });
  it('ready-made chains point at real workflows', () => {
    for (const c of CHAINS) for (const k of c.steps) expect(WORKFLOWS[k]).toBeTruthy();
    expect(w.chainFromPreset(CHAINS[0]).length).toBe(CHAINS[0].steps.length - 1);
    expect(w.chainSteps([{ key: 'nope' }, { key: 'build', gate: 'ask' }], WORKFLOWS)).toEqual([{ key: 'build', ask: true }]);
  });
});

describe('pins, recent, history, filter', () => {
  it('keeps 3 recents newest first', () => {
    let s = w.emptyStore();
    for (const k of ['a', 'b', 'c', 'd', 'b']) s = w.noteRecent(s, k);
    expect(s.recent).toEqual(['b', 'd', 'c']);
  });
  it('records runs and how they ended', () => {
    let s = w.recordRun(w.emptyStore(), 'x', 'start', 5);
    s = w.recordRun(s, 'x', 'error');
    expect(s.history.x).toMatchObject({ runs: 1, last: 5, end: 'error' });
    expect(w.historyLine(undefined)).toBe('Never run here');
  });
  it('trims history to 50 workflows', () => {
    let s = w.emptyStore();
    for (let i = 0; i < 60; i++) s = w.recordRun(s, 'k' + i, 'start', i);
    expect(Object.keys(s.history).length).toBe(50);
  });
  it('filters by name and hint, toggles pin', () => {
    const rows = [{ key: 'a', label: 'Code review', hint: 'findings' }, { key: 'b', label: 'Docs', hint: 'readme' }];
    expect(w.filterRows(rows, 'REVIEW').map((r) => r.key)).toEqual(['a']);
    expect(w.filterRows(rows, '').length).toBe(2);
    expect(w.toggleIn(['a'], 'a')).toEqual([]);
    expect(w.toggleIn([], 'a')).toEqual(['a']);
  });
});

describe('custom workflows', () => {
  it('validates, keeps keys unique, and round-trips through export and import', () => {
    expect(w.validateCustom({ label: '', prompt: 'x' }).error).toBeTruthy();
    expect(w.validateCustom({ label: 'A', prompt: '' }).error).toBeTruthy();
    const a = w.validateCustom({ label: 'My flow', prompt: 'Do it', fill: true, group: 'Nope' }).value;
    expect(a).toMatchObject({ key: 'custom-my-flow', group: 'Build', fill: true });
    const b = w.validateCustom({ label: 'My flow', prompt: 'Again' }, [a.key]).value;
    expect(b.key).not.toBe(a.key);
    const back = w.importCustom(w.exportCustom([a, b]), []);
    expect(back.workflows.map((x) => x.label)).toEqual(['My flow', 'My flow']);
    expect(new Set(back.workflows.map((x) => x.key)).size).toBe(2);
    expect(w.customToWorkflow(a).prompt()).toBe('Do it');
  });
  it('bad imports give an error and never throw', () => {
    expect(w.importCustom('{nope', []).error).toBeTruthy();
    expect(w.importCustom('{"a":1}', []).error).toBeTruthy();
    expect(w.importCustom('{"cceWorkflows":1,"workflows":[{"label":""}]}', []).error).toBeTruthy();
  });
});

const ipc = () => ({
  'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
  'chat:send': { ok: true },
  'chat:set-mode': { ok: true },
});
const sends = (h) => h.calls.filter((c) => c.channel === 'chat:send');

async function open() {
  const h = loadRenderer({ ipc: ipc() });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  chat.wfBtn.click();
  return { h, chat, doc: h.window.document };
}
const item = (doc, key) => doc.querySelector('.wf-item[data-wf="' + key + '"]');

describe('the picker in the chat', () => {
  it('has a command box and a filter, and lists the new workflows', async () => {
    const { doc } = await open();
    expect(doc.querySelector('.wf-command')).toBeTruthy();
    expect(doc.querySelector('.wf-filter')).toBeTruthy();
    for (const k of ['derisk', 'release', 'upgrade-plan', 'verify-live']) expect(item(doc, k)).toBeTruthy();
  });
  it('sends the typed command together with a self-contained workflow', async () => {
    const { h, doc } = await open();
    const box = doc.querySelector('.wf-command');
    box.value = 'only look at src/main';
    box.dispatchEvent(new h.window.Event('input'));
    item(doc, 'commit').click();
    await flush(6);
    const text = sends(h)[0].payload.text;
    expect(text).toContain('Prepare this work for review');
    expect(text).toContain('Extra instructions from the user: only look at src/main');
  });
  it('a workflow that asks for details sends once a command is given', async () => {
    const { h, doc } = await open();
    const box = doc.querySelector('.wf-command');
    box.value = 'the login page crashes';
    box.dispatchEvent(new h.window.Event('input'));
    item(doc, 'bugfix').click();
    await flush(6);
    expect(sends(h)[0].payload.text.endsWith('The bug / error: the login page crashes')).toBe(true);
  });
  it('without a command it only fills the box, and Shift+click never sends', async () => {
    const { h, chat, doc } = await open();
    item(doc, 'bugfix').click();
    await flush(4);
    expect(sends(h).length).toBe(0);
    expect(chat.composer.value).toContain('The bug / error: ');
    chat.composer.value = '';
    chat.wfBtn.click();
    item(h.window.document, 'commit').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
    await flush(4);
    expect(sends(h).length).toBe(0);
    expect(chat.composer.value).toContain('Prepare this work for review');
  });
  it('a busy chat queues the workflow instead of overwriting the box', async () => {
    const { h, chat, doc } = await open();
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    chat.composer.value = '';
    item(doc, 'docs').click();
    await flush(4);
    expect(chat.pendingMsgs.length).toBe(1);
    expect(chat.pendingMsgs[0].label).toBe('Update docs');
    expect(chat.composer.value).toBe('');
  });
  it('a draft is used as the task of a fill workflow', async () => {
    const { h, chat, doc } = await open();
    chat.composer.value = 'the cart total is wrong';
    item(doc, 'bugfix').click();
    await flush(6);
    expect(sends(h)[0].payload.text.endsWith('The bug / error: the cart total is wrong')).toBe(true);
  });
  it('options: saved for the project, shown as a dot, and reset', async () => {
    const { h, chat, doc } = await open();
    doc.querySelector('.wf-item[data-wf="commit"]').parentNode.querySelector('.wf-more').click();
    const sel = [...doc.querySelectorAll('.wfo-field select')].find((s) => [...s.options].some((o) => o.value === 'queue'));
    sel.value = 'wait';
    sel.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    [...doc.querySelectorAll('.wfo-bar button')].find((b) => b.textContent === 'Save for this project').click();
    const st = JSON.parse(h.window.localStorage.getItem(w.storeKey('/tmp')));
    expect(st.opts.commit.run).toBe('wait');
    expect(item(doc, 'commit').textContent).toContain('●');
    expect(item(doc, 'commit').textContent).toContain('you add the details');
    // picking it now only fills the box
    item(doc, 'commit').click();
    await flush(4);
    expect(sends(h).length).toBe(0);
    expect(chat.composer.value).toContain('Prepare this work');
  });
  it('a chain queues its follow-ups, and Stop clears them', async () => {
    const { h, chat, doc } = await open();
    [...doc.querySelectorAll('.wf-chain')].find((b) => b.textContent.startsWith('Bug')).click();
    await flush(6);
    expect(sends(h).length).toBe(0);   // bugfix waits for its details
    expect(chat.pendingMsgs.map((i) => i.label)).toEqual(['Test & fix', 'Commit & PR draft']);
    expect(chat.pendingMsgs.every((i) => i.chain)).toBe(true);
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    chat.stopBtn.click();
    expect(chat.pendingMsgs.length).toBe(0);
  });
  it('filters, and pins from the options', async () => {
    const { h, doc } = await open();
    const f = doc.querySelector('.wf-filter');
    f.value = 'risk';
    f.dispatchEvent(new h.window.Event('input'));
    expect([...doc.querySelectorAll('.wf-item')].map((b) => b.dataset.wf)).toEqual(['derisk']);
  });
  it('a read-only workflow switches to plan and the mode comes back after the turn', async () => {
    const { h, chat, doc } = await open();
    item(doc, 'security').click();
    await flush(8);
    expect(h.calls.some((c) => c.channel === 'chat:set-mode' && c.payload.mode === 'plan')).toBe(true);
    expect(chat.restoreAfterTurn).toMatchObject({ mode: 'acceptEdits' });
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: false });
    await flush(8);
    expect(h.calls.filter((c) => c.channel === 'chat:set-mode').pop().payload.mode).toBe('acceptEdits');
  });
  it('a custom workflow can be created and then run', async () => {
    const { h, chat, doc } = await open();
    [...doc.querySelectorAll('.wf-foot button')].find((b) => b.textContent === '+ New workflow').click();
    const [name] = doc.querySelectorAll('.wfo-form input');
    name.value = 'Tidy imports';
    doc.querySelector('.wfo-form textarea').value = 'Sort and remove unused imports.';
    doc.querySelector('.wfo-bar .primary').click();
    expect(item(doc, 'custom-tidy-imports')).toBeTruthy();
    item(doc, 'custom-tidy-imports').click();
    await flush(6);
    expect(sends(h)[0].payload.text).toBe('Sort and remove unused imports.');
    expect(chat.alive).toBe(true);
  });
});
