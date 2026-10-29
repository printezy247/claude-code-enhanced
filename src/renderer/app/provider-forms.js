// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { $, el, elIcon, fmtBytes, state, toast } from './core.js';
import { fillModeSelect } from './modes.js';
import { createSession } from './tabs.js';
import { Chat } from '../chat/index.js';
import { ProvidersUI } from '../providers/ui.js';

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

  // type
  const typeLabel = el('label', 'fld');
  typeLabel.appendChild(el('span', '', 'Type'));
  const typeSel = el('select');
  // Third element: the external engine an option needs on PATH, if any.
  const TYPES = [
    ['chat', 'Chat — desktop-style (Agent SDK)'],
    ['claude', 'Terminal — claude TUI'],
    ['codex', 'Terminal — codex TUI', 'codex'],
    ['gemini', 'Terminal — gemini TUI', 'gemini'],
    ['opencode', 'Terminal — opencode TUI', 'opencode'],
    ['shell', 'Terminal — shell'],
  ];
  TYPES.forEach(([v, n]) => {
    const o = el('option', '', n); o.value = v; typeSel.appendChild(o);
  });
  typeSel.value = 'chat';
  typeLabel.appendChild(typeSel);
  // A missing CLI is a state of the machine, not an error the user should only
  // discover after Launch: grey the option out and say how to install it.
  const engineHint = el('div', 'hint hidden');
  typeLabel.appendChild(engineHint);
  ccx.invoke('engines:list').then((r) => {
    const found = new Set(((r && r.engines) || []).filter((e) => e && e.found).map((e) => e.id));
    const missing = ((r && r.engines) || []).filter((e) => e && !e.found);
    for (const o of [...typeSel.options]) {
      const engine = (TYPES.find((t) => t[0] === o.value) || [])[2];
      if (!engine || found.has(engine)) continue;
      o.disabled = true;
      o.textContent += ' — not installed';
    }
    if (missing.length) {
      engineHint.classList.remove('hidden');
      engineHint.textContent = missing.map((e) => `${e.label} not found — ${e.hint}`).join(' · ');
    }
  }).catch(() => { /* detection is a nicety: launching still reports the error */ });
  grid.appendChild(typeLabel);

  // provider
  const provLabel = el('label', 'fld');
  provLabel.appendChild(el('span', '', 'Provider'));
  const provSel = el('select');
  state.providers.instances.forEach(p => {
    const o = el('option', '', (p.uid === state.providers.defaultUid ? '★ ' : '') + p.name);
    o.value = p.uid;
    provSel.appendChild(o);
  });
  if (state.providers.defaultUid) provSel.value = state.providers.defaultUid;
  provLabel.appendChild(provSel);
  grid.appendChild(provLabel);

  // options
  const optRow = el('div', 'wide');
  optRow.style.display = 'flex';
  optRow.style.flexDirection = 'column';
  optRow.style.gap = '8px';

  // permission mode (chat)
  const modeRow = el('div', 'inline');
  modeRow.appendChild(el('span', 'hint', 'Permission mode'));
  const modeSel = el('select');
  modeSel.style.width = '200px';
  const provOf = () => state.providers.instances.find(p => p.uid === provSel.value) || null;
  fillModeSelect(modeSel, provOf());
  modeSel.value = 'acceptEdits';
  provSel.addEventListener('change', () => fillModeSelect(modeSel, provOf()));
  modeRow.appendChild(modeSel);
  optRow.appendChild(modeRow);

  const contCheck = el('input'); contCheck.type = 'checkbox'; contCheck.id = 'opt-continue';
  const contLabel = el('label', 'check');
  contLabel.appendChild(contCheck);
  contLabel.appendChild(el('span', '', 'Terminal: continue most recent conversation (--continue)'));
  optRow.appendChild(contLabel);

  const resumeCheck = el('input'); resumeCheck.type = 'checkbox'; resumeCheck.id = 'opt-resume';
  const resumeLabel = el('label', 'check');
  resumeLabel.appendChild(resumeCheck);
  resumeLabel.appendChild(el('span', '', 'Chat: resume this folder\u2019s previous conversation'));
  optRow.appendChild(resumeLabel);

  const wtCheck = el('input'); wtCheck.type = 'checkbox'; wtCheck.id = 'opt-worktree';
  const wtLabel = el('label', 'check');
  wtLabel.appendChild(wtCheck);
  wtLabel.appendChild(el('span', '', 'Chat: isolated git worktree (new branch under .claude/worktrees)'));
  optRow.appendChild(wtLabel);

  const yoloCheck = el('input'); yoloCheck.type = 'checkbox'; yoloCheck.id = 'opt-yolo';
  const yoloLabel = el('label', 'check');
  yoloLabel.appendChild(yoloCheck);
  yoloLabel.appendChild(el('span', '', 'Skip ALL permission prompts (--dangerously-skip-permissions)'));
  optRow.appendChild(yoloLabel);

  const loginCheck = el('input'); loginCheck.type = 'checkbox'; loginCheck.id = 'opt-login';
  const loginLabel = el('label', 'check');
  loginLabel.appendChild(loginCheck);
  loginLabel.appendChild(el('span', '', 'Terminal: send /login after launch (first-time OAuth)'));
  optRow.appendChild(loginLabel);

  const warn = el('div', 'warn-box hidden');
  yoloCheck.addEventListener('change', () => warn.classList.toggle('hidden', !yoloCheck.checked));
  warn.textContent = 'YOLO mode lets the agent run any command without asking — use only in disposable environments.';
  optRow.appendChild(warn);
  grid.appendChild(optRow);

  modal.appendChild(grid);
  const actions = el('div', 'actions');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.addEventListener('click', () => overlay.remove());
  const launch = el('button', 'btn primary', 'Launch');
  launch.addEventListener('click', () => {
    const opts = {
      cwd: dirInput.value.trim(),
      providerUid: provSel.value || null,
      yolo: yoloCheck.checked,
    };
    overlay.remove();
    if (typeSel.value === 'chat') {
      Chat.createSession({
        ...opts,
        permissionMode: modeSel.value,
        resume: resumeCheck.checked ? 'last' : null,
        worktree: wtCheck.checked,
      });
    } else {
      createSession({
        ...opts,
        type: typeSel.value,
        continueLast: contCheck.checked,
        initText: loginCheck.checked && typeSel.value === 'claude' ? '/login\r' : '',
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
