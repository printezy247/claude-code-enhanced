// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { $, el, elIcon, fmtBytes, state, toast } from './core.js';
import { fillModeSelect } from './modes.js';
import { createSession } from './tabs.js';
import { Chat } from '../chat/index.js';
import { ProvidersUI } from '../providers/ui.js';
import { chatClis, terminalClis, modelGroups } from './session-models.js';

/* ================= new-session modal ================= */

export function openNewSessionModal() {
  // A double-click must not stack two identical dialogs (each needs its own
  // Cancel/Escape). If one is already up, bring it forward instead.
  const open = document.querySelector('.modal-overlay');
  if (open) { open.remove(); open.style.animation = 'none'; document.body.appendChild(open); return; }
  const overlay = el('div', 'modal-overlay');
  // A dialog must say so: role + aria-modal, or a screen reader treats the
  // backdrop as ordinary content and keeps reading the page behind it. #53
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', 'New session'));

  const grid = el('div', 'form-grid');

  // project dir
  const dirLabel = el('label', 'fld wide');
  dirLabel.appendChild(el('span', '', 'Project directory'));
  const dirRow = el('div', 'inline');
  const dirInput = el('input');
  dirInput.type = 'text';
  dirInput.value = state.settings.defaultCwd || '';
  const browseBtn = el('button', 'btn', 'Browse…');
  browseBtn.addEventListener('click', async () => {
    const r = await ccx.invoke('dialog:pickDir', { defaultPath: dirInput.value });
    if (r.ok && r.path) dirInput.value = r.path;
  });
  dirRow.appendChild(dirInput); dirRow.appendChild(browseBtn);
  dirLabel.appendChild(dirRow);
  grid.appendChild(dirLabel);

  // type: one Chat and one Terminal; the CLI picks which binary runs it.
  const typeLabel = el('label', 'fld');
  typeLabel.appendChild(el('span', '', 'Type'));
  const typeSel = el('select');
  for (const [v, n] of [['chat', 'Chat'], ['terminal', 'Terminal']]) {
    const o = el('option', '', n); o.value = v; typeSel.appendChild(o);
  }
  typeLabel.appendChild(typeSel);
  grid.appendChild(typeLabel);

  const cliLabel = el('label', 'fld');
  cliLabel.appendChild(el('span', '', 'CLI'));
  const cliSel = el('select');
  cliLabel.appendChild(cliSel);
  // A missing CLI is a state of the machine, not an error the user should only
  // discover after Launch: grey the option out and say how to install it.
  const engineHint = el('div', 'hint hidden');
  cliLabel.appendChild(engineHint);
  grid.appendChild(cliLabel);

  // model: the CLI's own default first, then the CCE providers it can run
  const modelLabel = el('label', 'fld wide');
  modelLabel.appendChild(el('span', '', 'Model'));
  const modelSel = el('select');
  modelLabel.appendChild(modelSel);
  const modelHint = el('div', 'hint');
  modelLabel.appendChild(modelHint);
  grid.appendChild(modelLabel);

  let engineList = [];   // every registered engine (engines:list), once detection answers
  let found = null;      // engine ids on PATH
  const fillCli = () => {
    const keep = cliSel.value;
    cliSel.innerHTML = '';
    const list = (typeSel.value === 'chat' ? chatClis : terminalClis)(engineList);
    for (const c of list) {
      const o = el('option', '', (c.id === 'claude' ? '★ ' : '') + c.label);
      o.value = c.id;
      if (c.engine && found && !found.has(c.engine)) { o.disabled = true; o.textContent += ' — not installed'; }
      cliSel.appendChild(o);
    }
    cliSel.value = list.some((c) => c.id === keep) ? keep : 'claude';
  };
  const fillModels = () => {
    const cli = cliSel.value;
    modelSel.innerHTML = '';
    const def = el('option', '', 'CLI default — ' + (cli === 'claude' ? 'claude’s own login and model' : 'the CLI’s own login and model'));
    def.value = '';
    modelSel.appendChild(def);
    for (const g of modelGroups(cli, state.providers.instances, engineList)) {
      const og = el('optgroup');
      og.label = g.provider.name;
      for (const m of g.models) {
        const o = el('option', '', m || 'provider default');
        o.value = JSON.stringify({ uid: g.provider.uid, model: m });
        og.appendChild(o);
      }
      modelSel.appendChild(og);
    }
    modelSel.value = '';
    const eng = engineList.find((e) => e.id === cli);
    modelHint.textContent = eng && !eng.providers
      ? eng.label + ' runs with its own login and models only.'
      : cli === 'claude' ? 'Or run Claude Code through one of your CCE providers.'
        : 'Or run it on any CCE provider (through CCE’s local proxy).';
  };
  ccx.invoke('engines:list').then((r) => {
    const all = engineList = (r && r.engines) || [];
    found = new Set(all.filter((e) => e && e.found).map((e) => e.id));
    const missing = all.filter((e) => e && !e.found);
    fillCli(); sync();
    if (missing.length) {
      engineHint.classList.remove('hidden');
      engineHint.textContent = missing.map((e) => `${e.label} not found — ${e.hint}`).join(' · ');
    }
  }).catch(() => { /* detection is a nicety: launching still reports the error */ });

  // options
  const optRow = el('div', 'wide');
  optRow.style.display = 'flex';
  optRow.style.flexDirection = 'column';
  optRow.style.gap = '8px';

  // permission mode (Claude chat)
  const modeRow = el('div', 'inline');
  modeRow.appendChild(el('span', 'hint', 'Permission mode'));
  const modeSel = el('select');
  modeSel.style.width = '200px';
  const pick = () => { try { return modelSel.value ? JSON.parse(modelSel.value) : null; } catch { return null; } };
  const provOf = () => { const p = pick(); return p ? (state.providers.instances.find((i) => i.uid === p.uid) || null) : null; };
  const fillMode = () => { const keep = modeSel.value; fillModeSelect(modeSel, provOf()); modeSel.value = keep || 'acceptEdits'; if (!modeSel.value) modeSel.value = 'acceptEdits'; };
  modeRow.appendChild(modeSel);
  optRow.appendChild(modeRow);

  const mkCheck = (id, text) => {
    const input = el('input'); input.type = 'checkbox'; input.id = id;
    const label = el('label', 'check');
    label.appendChild(input);
    label.appendChild(el('span', '', text));
    optRow.appendChild(label);
    return { input, label };
  };
  const cont = mkCheck('opt-continue', 'Continue most recent conversation (--continue)');
  const resume = mkCheck('opt-resume', 'Resume this folder’s previous conversation');
  const wt = mkCheck('opt-worktree', 'Isolated git worktree (new branch under .claude/worktrees)');
  const yolo = mkCheck('opt-yolo', 'Skip ALL permission prompts');
  const login = mkCheck('opt-login', 'Send /login after launch (first-time OAuth)');

  const warn = el('div', 'warn-box hidden');
  yolo.input.addEventListener('change', () => warn.classList.toggle('hidden', !yolo.input.checked));
  warn.textContent = 'YOLO mode lets the agent run any command without asking — use only in disposable environments.';
  optRow.appendChild(warn);
  grid.appendChild(optRow);

  // Show only what the chosen type + CLI understands.
  const show = (node, on) => node.classList.toggle('hidden', !on);
  function sync() {
    const chat = typeSel.value === 'chat';
    const cli = cliSel.value;
    show(modelLabel, (chat || cli === 'claude') && cli !== 'shell');
    show(modeRow, chat && cli === 'claude');
    show(resume.label, chat && cli !== 'shell');
    show(wt.label, chat);
    show(cont.label, !chat && cli === 'claude');
    show(login.label, !chat && cli === 'claude');
    show(yolo.label, cli !== 'shell');
    if (cli === 'shell') { yolo.input.checked = false; warn.classList.add('hidden'); }
    fillMode();
  }
  typeSel.addEventListener('change', () => { fillCli(); fillModels(); sync(); });
  cliSel.addEventListener('change', () => { fillModels(); sync(); });
  modelSel.addEventListener('change', fillMode);
  fillCli(); fillModels(); sync();

  modal.appendChild(grid);
  const actions = el('div', 'actions');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  const launch = el('button', 'btn primary', 'Launch');
  launch.addEventListener('click', () => {
    const cwd = dirInput.value.trim();
    const cli = cliSel.value;
    const p = pick();
    // No pick = "CLI default": no CCE provider, the CLI's own login and model.
    const target = p ? { providerUid: p.uid, model: p.model || undefined } : { cliDefault: true };
    overlay.remove();
    if (typeSel.value === 'chat') {
      if (cli === 'claude') {
        Chat.createSession({
          cwd, yolo: yolo.input.checked, ...target,
          permissionMode: modeSel.value,
          resume: resume.input.checked ? 'last' : null,
          worktree: wt.input.checked,
        });
      } else {
        Chat.createSession({
          cwd, yolo: yolo.input.checked, engine: cli, worktree: wt.input.checked, ...(p ? target : {}),
          resume: resume.input.checked ? 'last' : null,
        });
      }
    } else {
      createSession({
        cwd, type: cli, yolo: yolo.input.checked,
        ...(cli === 'claude' ? target : {}),
        continueLast: cont.input.checked && cli === 'claude',
        initText: login.input.checked && cli === 'claude' ? '/login\r' : '',
      });
    }
  });
  actions.appendChild(cancel); actions.appendChild(launch);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  $('#modal-root').appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  dirInput.focus();
}

/* ================= providers view ================= */

export function renderProviders() {
  // The whole providers surface (Connect picker, detail tabs, local manager)
  // lives in providers.js; this stays as the nav entry point.
  if (window.ProvidersUI) return ProvidersUI.render();
  const grid = $('#provider-grid');
  if (grid) grid.innerHTML = '';
}

  function openOllamaManager(p) {    const overlay = el('div', 'modal-overlay');
  // A dialog must say so: role + aria-modal, or a screen reader treats the
  // backdrop as ordinary content and keeps reading the page behind it. #53
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
    const modal = el('div', 'modal');
    modal.appendChild(elIcon('h3', '', CCEIcons.svg('gear', 14) + ' Model manager — ' + p.name));
    modal.appendChild(el('div', 'hint', 'Load models into memory with a context size, or unload them to free VRAM. The context size applies while the model stays loaded — chats use it automatically.'));

    const loadedBox = el('div', 'settings-card');
    loadedBox.appendChild(el('h4', '', 'Loaded now'));
    const loadedList = el('div', 'skills-list');
    loadedBox.appendChild(loadedList);

    const allBox = el('div', 'settings-card');
    allBox.appendChild(el('h4', '', 'All models on the server'));
    const allList = el('div', 'skills-list');
    allBox.appendChild(allList);

    const ctxSel = el('select'); ctxSel.style.width = '140px';
    [['4096', '4K ctx'], ['8192', '8K ctx'], ['16384', '16K ctx'], ['32768', '32K ctx'], ['65536', '64K ctx'], ['131072', '128K ctx'], ['262144', '256K ctx']].forEach(([v, n]) => {
      const o = el('option', '', n); o.value = v; ctxSel.appendChild(o);
    });
    ctxSel.value = '32768';
    const kaSel = el('select'); kaSel.style.width = '140px';
    [['5m', 'keep 5m'], ['30m', 'keep 30m'], ['1h', 'keep 1h'], ['-1', 'keep forever']].forEach(([v, n]) => {
      const o = el('option', '', n); o.value = v; kaSel.appendChild(o);
    });
    kaSel.value = '30m';
    const controls = el('div', 'inline');
    controls.appendChild(el('span', 'hint', 'load with:'));
    controls.appendChild(ctxSel);
    controls.appendChild(kaSel);
    modal.appendChild(controls);
    modal.appendChild(loadedBox);
    modal.appendChild(allBox);

    let loadedNames = new Set();
    const refresh = async () => {
      const [ps, tags] = await Promise.all([
        ccx.invoke('ollama:ps', { uid: p.uid }),
        ccx.invoke('ollama:tags', { uid: p.uid }),
      ]);
      loadedList.innerHTML = '';
      allList.innerHTML = '';
      loadedNames = new Set(ps.ok ? (ps.models || []).map(m => m.name) : []);
      if (!ps.ok) loadedList.appendChild(el('div', 'hint', 'Not an Ollama server (or unreachable): ' + (ps.error || '')));
      (ps.models || []).forEach(m => {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', m.name));
        row.appendChild(el('span', 'skill-desc', fmtBytes(m.sizeVram) + ' in memory' + (m.expires ? ' · expires ' + new Date(m.expires).toLocaleTimeString() : '')));
        row.appendChild(el('span', 'chip', 'loaded'));
        const unload = el('button', 'btn small danger', 'unload');
        unload.addEventListener('click', async () => {
          unload.disabled = true; unload.textContent = '…';
          await ccx.invoke('ollama:manage', { uid: p.uid, model: m.name, action: 'unload' });
          refresh();
        });
        row.appendChild(unload);
        loadedList.appendChild(row);
      });
      if (ps.ok && !(ps.models || []).length) loadedList.appendChild(el('div', 'hint', 'Nothing loaded — models load on demand or via “load” below.'));
      (tags.ok ? tags.models : []).forEach(m => {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', m.name));
        row.appendChild(el('span', 'skill-desc', [m.paramSize, m.quant, fmtBytes(m.size)].filter(Boolean).join(' · ')));
        if (loadedNames.has(m.name)) {
          row.appendChild(el('span', 'chip', 'loaded'));
        } else {
          const load = el('button', 'btn small primary', 'load');
          load.title = 'Load with ' + ctxSel.options[ctxSel.selectedIndex].text + ', ' + kaSel.options[kaSel.selectedIndex].text;
          load.addEventListener('click', async () => {
            load.disabled = true; load.textContent = 'loading…';
            const r = await ccx.invoke('ollama:manage', {
              uid: p.uid, model: m.name, action: 'load',
              numCtx: ctxSel.value, keepAlive: kaSel.value === '-1' ? -1 : kaSel.value,
            });
            if (!r.ok || r.status >= 400) toast('Load failed (' + (r.status || r.error) + ')', 'err');
            refresh();
          });
          row.appendChild(load);
        }
        allList.appendChild(row);
      });
      if (!tags.ok || !(tags.models || []).length) allList.appendChild(el('div', 'hint', 'No models found: ' + (tags.error || 'is the server running?')));
    };
    ctxSel.addEventListener('change', refresh);
    kaSel.addEventListener('change', refresh);
    refresh();

    const actions = el('div', 'actions');
    const close = el('button', 'btn primary', 'Close');
    close.addEventListener('click', () => overlay.remove());
    actions.appendChild(close);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    $('#modal-root').appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  window.openOllamaManager = openOllamaManager;

  export function openProviderEditor(instance) {  const editing = !!instance;
  const presetId = instance ? instance.presetId : 'anthropic-oauth';
  const preset = state.providers.presets.find(p => p.id === presetId) || state.providers.presets[0];

  const overlay = el('div', 'modal-overlay');
  // A dialog must say so: role + aria-modal, or a screen reader treats the
  // backdrop as ordinary content and keeps reading the page behind it. #53
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', editing ? 'Edit provider' : 'Add provider'));

  const grid = el('div', 'form-grid');

  // preset picker
  const pLabel = el('label', 'fld wide');
  pLabel.appendChild(el('span', '', 'Preset'));
  const pSel = el('select');
  state.providers.presets.forEach(p => {
    const o = el('option', '', p.name); o.value = p.id; pSel.appendChild(o);
  });
  pSel.value = presetId;
  pLabel.appendChild(pSel);
  const blurb = el('div', 'hint', preset.blurb);
  let currentProtocol = (instance && instance.protocol) || preset.protocol || 'anthropic';
  let baseUrlInputEl = null;
  const presetDisplay = (p) => p.display || (p.name.includes('·') ? p.name.split('·')[1].trim() : p.name);
  // openai-protocol presets are key-only: the auth-token field is hidden and the
  // base URL is preset-managed unless the preset flags it editable (Cloudflare's
  // ACCOUNT_ID placeholder, NaraRouter's user-confirmed URL).
  const syncFields = () => {
    const ps = state.providers.presets.find(p => p.id === pSel.value) || preset;
    tokenField.style.display = currentProtocol === 'openai' ? 'none' : '';
    if (baseUrlInputEl) {
      const managed = currentProtocol === 'openai' && !!baseUrlInputEl.value && !ps.editableBaseUrl;
      baseUrlInputEl.readOnly = managed;
      baseUrlInputEl.style.opacity = managed ? '0.75' : '1';
      const lbl = baseUrlField.querySelector('span');
      if (lbl) lbl.textContent = managed
        ? 'Base URL (managed by preset — API key only)'
        : (currentProtocol === 'openai' ? 'Base URL (preset default — edit if your provider differs)' : 'Base URL (empty = official Anthropic API)');
    }
    if (curCard) curCard.style.display = currentProtocol === 'openai' ? '' : 'none';
  };
  pSel.addEventListener('change', () => {
    const np = state.providers.presets.find(p => p.id === pSel.value);
    if (!np) return;
    blurb.textContent = np.blurb;
    currentProtocol = np.protocol || 'anthropic';
    // Adopt the preset's template values. The previous code assigned .value on
    // the `let` string variables instead of these inputs, so switching preset
    // never populated anything.
    baseUrlInputEl.value = np.baseUrl || '';
    modelField.querySelector('input').value = np.model || '';
    smallField.querySelector('input').value = np.smallFastModel || '';
    const cur = nameInput.value.trim();
    if (!cur || state.providers.presets.some(p => presetDisplay(p) === cur)) nameInput.value = presetDisplay(np);
    if (curCard) { curList.innerHTML = ''; if (currentProtocol === 'openai' && baseUrlInputEl.value) loadCur(); }
    syncFields();
  });
  pLabel.appendChild(blurb);
  grid.appendChild(pLabel);

  // name
  const nLabel = el('label', 'fld wide');
  nLabel.appendChild(el('span', '', 'Display name'));
  const nameInput = el('input');
  nameInput.value = instance ? instance.name : (preset.name.includes('·') ? preset.name.split('·')[1].trim() : preset.name);
  nLabel.appendChild(nameInput);
  grid.appendChild(nLabel);

  const mkField = (labelText, id, value, type = 'text') => {
    const l = el('label', 'fld');
    l.appendChild(el('span', '', labelText));
    const inp = el('input'); inp.type = type; inp.id = id;
    if (value) inp.value = value;
    l.appendChild(inp);
    return l;
  };

  let baseUrl = instance ? instance.baseUrl : (preset.baseUrl || '');
  let model = instance ? instance.model : (preset.model || '');
  let smallFast = instance ? instance.smallFastModel : (preset.smallFastModel || '');

  let curatedSel = new Set((instance && instance.models) || []);
  let leanSel = null;
  let leanCustomWrap = null;
  let leanCustomBoxes = [];
  if (state.leanPresets && state.leanPresets.length) {
    const lf = el('label', 'fld');
    lf.appendChild(el('span', '', 'Lean tools — cut the tool list for small local models (smaller base prompt)'));
    leanSel = el('select');
    const off = el('option', '', 'full tool set (default)'); off.value = ''; leanSel.appendChild(off);
    for (const pr of state.leanPresets) {
      const o = el('option', '', pr.label + ' — ' + pr.tools.join(', ')); o.value = pr.id; leanSel.appendChild(o);
    }
    const custom = el('option', '', 'custom — pick tools below'); custom.value = 'custom'; leanSel.appendChild(custom);
    // A hand-picked list matches no preset; show it as custom with its boxes ticked. #12
    const current = (instance && instance.leanTools) || [];
    const matched = current.length
      ? (state.leanPresets.find(p => p.tools.length === current.length && p.tools.every(t => current.includes(t))) || {}).id
      : '';
    leanSel.value = matched || (current.length ? 'custom' : '');
    lf.appendChild(leanSel);
    grid.appendChild(lf);
    // Per-tool checklist, visible only for the custom preset. #12
    leanCustomWrap = el('div', 'lean-custom');
    const tools = (state.leanAllTools && state.leanAllTools.length) ? state.leanAllTools : [];
    for (const t of tools) {
      const cb = el('input'); cb.type = 'checkbox'; cb.value = t;
      cb.checked = current.includes(t);
      if (!current.length) cb.checked = ['Read', 'Grep', 'Glob', 'Bash', 'TodoWrite', 'AskUserQuestion'].includes(t);
      const l = el('label', 'check lean-tool');
      l.appendChild(cb); l.appendChild(el('span', 'mono', t));
      leanCustomWrap.appendChild(l);
      leanCustomBoxes.push(cb);
    }
    leanCustomWrap.appendChild(el('div', 'hint', 'MCP tools (mcp__*) are dynamic per session and always stay on. Unticking the tools a model needs will break it — when in doubt, keep Read, Bash, TodoWrite and AskUserQuestion (how the model asks you a question).'));
    leanCustomWrap.style.display = leanSel.value === 'custom' ? '' : 'none';
    leanSel.addEventListener('change', () => {
      leanCustomWrap.style.display = leanSel.value === 'custom' ? '' : 'none';
    });
    grid.appendChild(leanCustomWrap);
  }
  const baseUrlField = mkField('Base URL (empty = official Anthropic API)', 'f-base', baseUrl, 'text');
  baseUrlInputEl = baseUrlField.querySelector('input');
  grid.appendChild(baseUrlField);

  const tokenField = mkField(
    'Auth token (ANTHROPIC_AUTH_TOKEN)' + (instance && instance.hasAuthToken ? ' — leave blank to keep' : ''),
    'f-token', '', 'password');
  grid.appendChild(tokenField);

  const keyField = mkField(
    'API key (ANTHROPIC_API_KEY)' + (instance && instance.hasApiKey ? ' — leave blank to keep' : ''),
    'f-key', '', 'password');
  grid.appendChild(keyField);

  const modelField = mkField('Model — ONE slug (switch models anytime via the in-chat dropdown)', 'f-model', model);
  grid.appendChild(modelField);

  const smallField = mkField('Small/fast model (ANTHROPIC_SMALL_FAST_MODEL)', 'f-small', smallFast);
  grid.appendChild(smallField);

  // model curation (openai-protocol providers): choose what appears in the chat
  // dropdown. Always created so switching protocol mid-dialog can reveal it.
  let curCard = null, curList = null, loadCur = null;
  {
    curCard = el('label', 'fld wide');
    curCard.appendChild(el('span', '', 'Model selection — tick the models that appear in the chat dropdown (optional; empty = show all)'));
    const loadBtn = el('button', 'btn small', '↻ load model list');
    loadBtn.style.margin = '4px 0';
    curCard.appendChild(loadBtn);
    curList = el('div', 'skills-list');
    curList.style.maxHeight = '200px';
    curList.style.overflow = 'auto';
    curCard.appendChild(curList);
    grid.appendChild(curCard);
    loadCur = async () => {
      loadBtn.disabled = true; loadBtn.textContent = 'loading…';
      const r = await ccx.invoke('provider:listModels', {
        baseUrl: baseUrlInputEl.value.trim(),
        apiKey: keyField.querySelector('input').value.trim() || tokenField.querySelector('input').value.trim(),
        protocol: currentProtocol,
      });
      loadBtn.disabled = false; loadBtn.textContent = '↻ load model list';
      curList.innerHTML = '';
      if (!r.ok) { curList.appendChild(el('div', 'hint', 'Failed: ' + (r.error || 'no models'))); return; }
      const entries = (r.models || []).map(m => typeof m === 'string' ? { id: m, ctx: null } : m).slice(0, 300);
      if (!entries.length) { curList.appendChild(el('div', 'hint', 'No models returned by the provider.')); return; }
      for (const m of entries) {
        const row = el('label', 'check');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = curatedSel.has(m.id);
        cb.addEventListener('change', () => { cb.checked ? curatedSel.add(m.id) : curatedSel.delete(m.id); });
        row.appendChild(cb);
        row.appendChild(el('span', '', m.id + (m.ctx ? '  · ' + Number(m.ctx).toLocaleString() + ' ctx' : '')));
        curList.appendChild(row);
      }
      if (!curList.childElementCount) curList.appendChild(el('div', 'hint', 'No models returned.'));
    };
    loadBtn.addEventListener('click', loadCur);
    if (currentProtocol === 'openai' && baseUrlInputEl.value) loadCur();
  }
  syncFields();

  const xLabel = el('label', 'fld wide');
  xLabel.appendChild(el('span', '', 'Extra environment variables (JSON, optional) — e.g. {"ANTHROPIC_CUSTOM_HEADERS":"…"}'));
  const xInput = el('textarea');
  xInput.value = instance && instance.envExtras ? JSON.stringify(instance.envExtras, null, 2) : '{}';
  xLabel.appendChild(xInput);
  grid.appendChild(xLabel);

  modal.appendChild(grid);

  const actions = el('div', 'actions');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  const save = el('button', 'btn primary', 'Save');
  save.addEventListener('click', async () => {
    let envExtras = {};
    try { envExtras = JSON.parse(xInput.value || '{}'); }
    catch { return toast('Extra env vars must be valid JSON', 'err'); }
    const payload = {
      uid: instance ? instance.uid : undefined,
      presetId: pSel.value,
      protocol: currentProtocol,
      models: [...curatedSel],
      // Per-provider lean tool allowlist, for small local models. #41 #12
      leanToolsPreset: leanSel ? leanSel.value : (instance && instance.leanTools ? '__keep' : ''),
      leanToolsCustom: leanSel && leanSel.value === 'custom'
        ? leanCustomBoxes.filter(cb => cb.checked).map(cb => cb.value)
        : undefined,
      name: nameInput.value.trim() || 'Provider',
      baseUrl: baseUrlField.querySelector('input').value.trim(),
      model: modelField.querySelector('input').value.trim(),
      smallFastModel: smallField.querySelector('input').value.trim(),
      envExtras,
    };
    const tok = tokenField.querySelector('input').value;
    const key = keyField.querySelector('input').value;
    if (tok) payload.authToken = tok; else if (instance && instance.hasAuthToken) payload.keepAuthToken = true;
    if (key) payload.apiKey = key; else if (instance && instance.hasApiKey) payload.keepApiKey = true;

    const r = await ccx.invoke('providers:save', { instance: payload });
    if (r.ok) {
      overlay.remove();
      await refreshProviders();
      toast('Provider saved', 'ok');
    } else toast(r.error, 'err');
  });
  actions.appendChild(cancel); actions.appendChild(save);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  $('#modal-root').appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  nameInput.focus();
}

export async function refreshProviders() {
  const r = await ccx.invoke('providers:all');
  if (r.ok) {
    state.providers = { presets: r.presets, catalog: r.catalog || state.providers.catalog || [], modelsdev: r.modelsdev || state.providers.modelsdev, instances: r.instances, defaultUid: r.defaultUid };
    if (r.leanPresets) state.leanPresets = r.leanPresets;
    if (r.leanAllTools) state.leanAllTools = r.leanAllTools;
    if (state.view === 'providers') renderProviders();
  }
}
