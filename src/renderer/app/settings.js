// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { $, applyTheme, el, state, toast } from './core.js';
import { updateStatusbar } from './tabs.js';

/* ================= settings view ================= */

/** Parse the `model=number` per-line force-context box into {model: ctx}. */
export function parseForceCtx(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(.+?)\s*=\s*(\d+)\s*$/);
    if (!m) continue;
    const ctx = Number(m[2]);
    if (ctx >= 4096 && ctx <= 4000000) out[m[1].trim().toLowerCase()] = ctx;
  }
  return out;
}

export function renderSettings() {
  const body = $('#settings-body');
  if (body.childElementCount) return;
  body.innerHTML = '';
  const s = state.settings;

  // claude binary
  const c1 = el('div', 'settings-card');
  c1.appendChild(el('h4', '', 'Claude CLI'));
  const claudePathRow = el('div', 'inline');
  const pathInput = el('input'); pathInput.type = 'text'; pathInput.value = s.claudePath || '';
  pathInput.placeholder = 'auto-detect (~/.local/bin/claude, /usr/local/bin/claude …)';
  const redetect = el('button', 'btn', 'Auto-detect');
  redetect.addEventListener('click', async () => { pathInput.value = ''; await saveSettings({ claudePath: '' }); });
  claudePathRow.appendChild(pathInput); claudePathRow.appendChild(redetect);
  c1.appendChild(claudePathRow);
  const claudeStatus = el('div', 'hint');
  const ci = state.info && state.info.claude;
  claudeStatus.textContent = ci && ci.found ? `Detected: ${ci.path} (${ci.version})` : 'claude CLI not found — install it with: curl -fsSL https://claude.ai/install.sh | bash';
  c1.appendChild(claudeStatus);
  body.appendChild(c1);

  // terminal
  const c2 = el('div', 'settings-card');
  c2.appendChild(el('h4', '', 'Terminal'));
  const fontRow = el('div', 'inline');
  fontRow.appendChild(el('span', 'hint', 'Font size'));
  const fontInput = el('input'); fontInput.type = 'text'; fontInput.value = String(s.fontSize); fontInput.style.width = '70px';
  fontRow.appendChild(fontInput);
  fontRow.appendChild(el('span', 'hint', 'Scrollback lines'));
  const sbInput = el('input'); sbInput.type = 'text'; sbInput.value = String(s.scrollback); sbInput.style.width = '90px';
  fontRow.appendChild(sbInput);
  c2.appendChild(fontRow);
  c2.appendChild(el('div', 'hint', 'Font size applies to new sessions; scrollback to new sessions. Copy: Ctrl+Shift+C · Paste: Ctrl+Shift+V · New tab: Ctrl+Shift+T'));
  const pathRow = el('div', 'inline');
  pathRow.appendChild(el('span', 'hint', 'Agent PATH'));
  const pathState = el('span', 'hint mono', (s.loginEnv && s.loginEnv.PATH ? s.loginEnv.PATH.split(':').length + ' dirs' : 'from login shell'));
  pathState.title = (s.loginEnv && s.loginEnv.PATH) || '';
  const pathBtn = el('button', 'btn small', 'Refresh PATH');
  pathBtn.title = 'Re-read your login shell (picks up tools installed while the app is running). Applies to new sessions.';
  pathBtn.addEventListener('click', async () => {
    pathBtn.disabled = true;
    const r = await ccx.invoke('env:refresh');
    pathBtn.disabled = false;
    if (r.ok) {
      state.settings.loginEnv = { PATH: r.PATH };
      pathState.textContent = r.PATH.split(':').length + ' dirs';
      pathState.title = r.PATH;
      toast('PATH refreshed — new sessions see newly installed tools', 'ok');
    } else toast(r.error, 'err');
  });
  pathRow.appendChild(pathState); pathRow.appendChild(pathBtn);
  c2.appendChild(pathRow);
  body.appendChild(c2);

  // privacy
  const c3 = el('div', 'settings-card');
  c3.appendChild(el('h4', '', 'Privacy'));
  const telCheck = el('input'); telCheck.type = 'checkbox'; telCheck.checked = !!s.disableTelemetry;
  const telLabel = el('label', 'check');
  telLabel.appendChild(telCheck);
  telLabel.appendChild(el('span', '', 'Disable claude telemetry, error reporting and auto-updates in launched sessions'));
  c3.appendChild(telLabel);
  body.appendChild(c3);

  // chat behaviour
  const c3b = el('div', 'settings-card');
  c3b.appendChild(el('h4', '', 'Chat behaviour'));
  const nudgeCheck = el('input'); nudgeCheck.type = 'checkbox'; nudgeCheck.id = 'opt-autonudge';
  nudgeCheck.checked = s.autoNudge !== false;
  nudgeCheck.addEventListener('change', () => saveSettings({ autoNudge: nudgeCheck.checked }));
  const nudgeLabel = el('label', 'check');
  nudgeLabel.appendChild(nudgeCheck);
  nudgeLabel.appendChild(el('span', '', 'Auto-continue when a model stops after saying what it will do next'));
  c3b.appendChild(nudgeLabel);
  const welcomeCheck = el('input'); welcomeCheck.type = 'checkbox'; welcomeCheck.id = 'opt-welcomechat';
  welcomeCheck.checked = !!s.autoOpenWelcomeChat;
  welcomeCheck.addEventListener('change', () => saveSettings({ autoOpenWelcomeChat: welcomeCheck.checked }));
  const welcomeLabel = el('label', 'check');
  welcomeLabel.appendChild(welcomeCheck);
  welcomeLabel.appendChild(el('span', '', 'Open a chat in the default folder on start (off: start on the home page)'));
  c3b.appendChild(welcomeLabel);
  c3b.appendChild(el('div', 'hint', 'Some models end a turn on “Let me …” without making the tool call, so the chat just goes quiet. When this is on, cce sends one automatic reminder per prompt; the ▶ continue button is always available.'));
  const cmRow = el('label', 'check');
  cmRow.appendChild(el('span', '', 'context-mode plugin in chats'));
  const cmSel = el('select', 'skills-search');
  cmSel.id = 'opt-contextmode';
  for (const [v, t] of [['auto', 'Claude models only'], ['on', 'Every model'], ['off', 'Never']]) {
    const o = el('option', '', t); o.value = v; cmSel.appendChild(o);
  }
  cmSel.value = s.contextMode || 'auto';
  cmSel.addEventListener('change', () => saveSettings({ contextMode: cmSel.value }));
  cmRow.appendChild(cmSel);
  c3b.appendChild(cmRow);
  c3b.appendChild(el('div', 'hint', 'context-mode hides command output behind a search index. Claude searches it; other models usually re-run the same command over and over. Applies to new chats.'));
  // Shell-output filter: the main process compacts big command output before
  // it is handed to the model, so a noisy build log stops costing tokens.
  const ofRow = el('label', 'check');
  ofRow.appendChild(el('span', '', 'compact shell output sent to the model'));
  const ofSel = el('select', 'skills-search');
  ofSel.id = 'opt-outputfilter';
  for (const [v, t] of [['on', 'Compacted — head + tail, repeated lines collapsed'], ['off', 'Full output (engine\'s own limit)']]) {
    const o = el('option', '', t); o.value = v; ofSel.appendChild(o);
  }
  ofSel.value = s.outputFilter || 'on';
  ofSel.style.maxWidth = '340px';
  ofSel.addEventListener('change', () => saveSettings({ outputFilter: ofSel.value }));
  ofRow.appendChild(ofSel);
  c3b.appendChild(ofRow);
  const ofMaxRow = el('label', 'fld');
  ofMaxRow.appendChild(el('span', '', 'characters of shell output the model may read'));
  const ofMax = el('input');
  ofMax.type = 'number';
  ofMax.id = 'opt-outputfilter-max';
  ofMax.min = '500';
  ofMax.max = '100000';
  ofMax.step = '500';
  ofMax.value = String(s.outputFilterMaxChars || 8000);
  // The stylesheet only dresses text/password inputs, so the number box gets
  // the same look inline.
  ofMax.style.width = '160px';
  ofMax.style.background = 'var(--bg2)';
  ofMax.style.color = 'var(--text)';
  ofMax.style.border = '1px solid var(--border)';
  ofMax.style.borderRadius = '8px';
  ofMax.style.padding = '8px 10px';
  ofMax.style.fontSize = '13px';
  ofMax.addEventListener('change', () => {
    const n = Math.max(500, Math.min(100000, Number(ofMax.value) || 8000));
    ofMax.value = String(n);
    saveSettings({ outputFilterMaxChars: n });
  });
  ofMaxRow.appendChild(ofMax);
  c3b.appendChild(ofMaxRow);
  c3b.appendChild(el('div', 'hint', 'The card in the chat still shows the full output — only what the model reads is compacted, so long build logs cost fewer tokens. The budget is how many characters of a command’s output the model may see. Applies to new chats.'));
  const idleRow = el('label', 'fld');
  idleRow.appendChild(el('span', '', 'seconds of silence before a stalled reply is stopped'));
  const idle = el('input');
  idle.type = 'number';
  idle.id = 'opt-stream-idle';
  idle.min = '30';
  idle.max = '1800';
  idle.step = '30';
  idle.value = String(s.streamIdleSeconds || 180);
  idle.style.width = '160px';
  idle.style.background = 'var(--bg2)';
  idle.style.color = 'var(--text)';
  idle.style.border = '1px solid var(--border)';
  idle.style.borderRadius = '8px';
  idle.style.padding = '8px 10px';
  idle.style.fontSize = '13px';
  idle.addEventListener('change', () => {
    const n = Math.max(30, Math.min(1800, Number(idle.value) || 180));
    idle.value = String(n);
    saveSettings({ streamIdleSeconds: n });
  });
  idleRow.appendChild(idle);
  c3b.appendChild(idleRow);
  c3b.appendChild(el('div', 'hint', 'A reply that is still being thought through keeps the connection alive on its own. Raise this for a slow local model that goes quiet for minutes between words. Applies to new chats.'));
  body.appendChild(c3b);

  // Sites the agent may fetch without asking. Any other site asks first, so a
  // web page cannot make the agent send data to an address of its choosing.
  const c3w = el('div', 'settings-card');
  c3w.appendChild(el('h4', '', 'Web fetch'));
  const wfLabel = el('label', 'fld');
  wfLabel.appendChild(el('span', '', 'sites the agent may read without asking (one per line)'));
  const wf = el('textarea', 'force-ctx');
  wf.id = 'opt-webfetch-domains';
  wf.rows = 4;
  wf.spellcheck = false;
  wf.placeholder = 'docs.python.org\n*.github.com';
  wf.value = (Array.isArray(s.webFetchDomains) ? s.webFetchDomains : []).join('\n');
  wf.addEventListener('change', () => saveSettings({ webFetchDomains: wf.value }));
  wfLabel.appendChild(wf);
  c3w.appendChild(wfLabel);
  c3w.appendChild(el('div', 'hint', 'A fetch of any other site shows a permission card; “Always allow” on it adds the site here. “*.example.com” covers its subdomains, not example.com itself. Web search is not affected. Applies to new chats.'));
  body.appendChild(c3w);

  // sandbox
  const c4 = el('div', 'settings-card');
  c4.appendChild(el('h4', '', 'Sandboxed command execution'));
  c4.appendChild(el('div', 'hint', 'Runs every Bash command in a Bubblewrap sandbox with restricted filesystem and network access (claude code sandbox). Requires: sudo apt install bubblewrap. Applies to new chats.'));
  const sbEnabled = el('input'); sbEnabled.type = 'checkbox'; sbEnabled.id = 'sb-enabled'; sbEnabled.checked = !!(s.sandbox && s.sandbox.enabled);
  const sbEnabledLabel = el('label', 'check');
  sbEnabledLabel.appendChild(sbEnabled);
  sbEnabledLabel.appendChild(el('span', '', 'Enable sandbox for new chats'));
  c4.appendChild(sbEnabledLabel);
  const sbAuto = el('input'); sbAuto.type = 'checkbox'; sbAuto.id = 'sb-auto'; sbAuto.checked = !(s.sandbox && s.sandbox.autoAllowBashIfSandboxed === false);
  const sbAutoLabel = el('label', 'check');
  sbAutoLabel.appendChild(sbAuto);
  sbAutoLabel.appendChild(el('span', '', 'Auto-approve sandboxed bash (safe: it is isolated)'));
  c4.appendChild(sbAutoLabel);
  const sbUnsand = el('input'); sbUnsand.type = 'checkbox'; sbUnsand.id = 'sb-unsand'; sbUnsand.checked = !!(s.sandbox && s.sandbox.allowUnsandboxedCommands);
  const sbUnsandLabel = el('label', 'check');
  sbUnsandLabel.appendChild(sbUnsand);
  sbUnsandLabel.appendChild(el('span', '', 'Allow commands to request escaping the sandbox (still asks you)'));
  c4.appendChild(sbUnsandLabel);
  const sbLocal = el('input'); sbLocal.type = 'checkbox'; sbLocal.id = 'sb-local'; sbLocal.checked = !(s.sandbox && s.sandbox.allowLocalBinding === false);
  const sbLocalLabel = el('label', 'check');
  sbLocalLabel.appendChild(sbLocal);
  sbLocalLabel.appendChild(el('span', '', 'Allow local port binding (dev servers, localhost tests)'));
  c4.appendChild(sbLocalLabel);
  const domLabel = el('label', 'fld');
  domLabel.appendChild(el('span', '', 'Network allowlist — domains the sandbox may reach (comma-separated, empty = ask per permission rules)'));
  const sbDomains = el('input'); sbDomains.type = 'text';
  sbDomains.value = (s.sandbox && Array.isArray(s.sandbox.allowedDomains) ? s.sandbox.allowedDomains.join(', ') : '');
  sbDomains.placeholder = 'registry.npmjs.org, github.com, pypi.org';
  domLabel.appendChild(sbDomains);
  c4.appendChild(domLabel);
  body.appendChild(c4);

  // session caps + model fallbacks (Agent SDK options)
  const c5 = el('div', 'settings-card');
  c5.appendChild(el('h4', '', 'Session caps & model'));
  c5.appendChild(el('div', 'hint', 'Applied to new chats. Leave blank for no cap.'));
  const mkFld = (labelText, value, placeholder) => {
    const l = el('label', 'fld');
    l.appendChild(el('span', '', labelText));
    const inp = el('input'); inp.type = 'text'; inp.value = value || ''; inp.placeholder = placeholder || '';
    l.appendChild(inp);
    c5.appendChild(l);
    return inp;
  };
  const budInput = mkFld('Max spend per session (USD)', s.maxBudgetUsd, 'e.g. 5');
  const turnsInput = mkFld('Max turns per session', s.maxTurns, 'e.g. 40');
  const fbInput = mkFld('Fallback model (used when the main model is overloaded)', s.fallbackModel, 'e.g. gpt-oss:120b-cloud');
  const tbInput = mkFld('Thinking budget (tokens, blank = model default)', s.thinkingBudget, 'e.g. 8192');
  const efInput = mkFld('Effort level (blank = model default)', s.effort, 'low / medium / high');
  const m1 = el('label', 'check');
  const m1c = el('input'); m1c.type = 'checkbox'; m1c.checked = !!s.context1m;
  m1.appendChild(m1c);
  m1.appendChild(el('span', '', '1M-token context window (models that support it)'));
  c5.appendChild(m1);
  const st = el('label', 'check');
  const stc = el('input'); stc.type = 'checkbox'; stc.checked = s.showThinking !== false;
  st.appendChild(stc);
  st.appendChild(el('span', '', 'Show thinking (ask Claude models for thinking summaries)'));
  c5.appendChild(st);
  body.appendChild(c5);

  // updates (release ping)
  const c7 = el('div', 'settings-card');
  c7.appendChild(el('h4', '', 'Updates'));
  const upRow = el('div', 'row');
  const upBtn = el('button', 'btn small', 'Check for updates');
  const upState = el('span', 'hint', 'installed: v' + ((state.info && state.info.appVersion) || '?'));
  upBtn.addEventListener('click', async () => {
    upBtn.disabled = true;
    const r = await ccx.invoke('update:check');
    upBtn.disabled = false;
    if (!r.ok) { upState.textContent = r.error; return; }
    if (!r.latest) { upState.textContent = 'v' + r.current + ' · ' + r.note; return; }
    const newer = r.latest !== r.current;
    upState.textContent = newer
      ? 'v' + r.current + ' → v' + r.latest + ' available'
      : 'v' + r.current + ' is the latest release';
    if (newer && r.url) {
      const a = el('a', '', ' open release page');
      a.href = '#';
      a.addEventListener('click', (e) => { e.preventDefault(); ccx.invoke('shell:openExternal', { url: r.url }); });
      upState.appendChild(a);
    }
  });
  upRow.appendChild(upBtn);
  upRow.appendChild(upState);
  c7.appendChild(upRow);
  const diagRow = el('div', 'row');
  const diagBtn = el('button', 'btn small ghost', 'Copy diagnostics');
  diagBtn.title = 'Copy a redacted diagnostics report to the clipboard (for bug reports)';
  diagBtn.addEventListener('click', async () => {
    const prov = await ccx.invoke('providers:all');
    const auth = await ccx.invoke('auth:status');
    const info = state.info || {};
    const s = state.settings || {};
    const lines = [
      'Claude Code Enhanced — diagnostics report',
      'version: ' + (info.appVersion || '?'),
      'electron: ' + (info.electron || '?'),
      'claude CLI: ' + JSON.stringify((info.claude || {})),
      'providers: ' + (prov && prov.instances ? prov.instances.length : 0),
      'defaultProviderUid: ' + (s.defaultProviderUid || 'none'),
      'closeToTray: ' + s.closeToTray,
      'outputFilter: ' + (s.outputFilter || 'off'),
      'outputFilterMaxChars: ' + (s.outputFilterMaxChars || 0),
      'localNumCtx: ' + (s.localNumCtx || 73728),
      'auth: ' + JSON.stringify(auth || {}),
      'timestamp: ' + new Date().toISOString(),
    ];
    try { await ccx.invoke('clipboard:write', { text: lines.join('\n') }); toast('Diagnostics copied to clipboard', 'ok'); }
    catch (e) { toast('Failed to copy diagnostics', 'err'); }
  });
  diagRow.appendChild(diagBtn);
  c7.appendChild(diagRow);
  body.appendChild(c7);

  // local models (Ollama)
  const c8 = el('div', 'settings-card');
  c8.appendChild(el('h4', '', 'Local models (Ollama)'));
  c8.appendChild(el('div', 'hint', 'Preferred context window when pre-warming local Ollama models for new chats. The claude engine base prompt needs ≥70K tokens. Sizes that do not fit in free RAM are stepped down automatically (a too-large cache kills the model runner) — 4GB-VRAM machines usually top out near 70K. Values below 70K make local models reject claude chats.'));
  const lctxRow = el('div', 'inline');
  lctxRow.appendChild(el('span', 'hint', 'num_ctx for new chats'));
  const localCtxSel = el('select'); localCtxSel.style.width = '220px';
  [['16384', '16K'], ['32768', '32K'], ['73728', '72K (recommended: fits the engine prompt)'], ['131072', '128K (needs ~14 GB RAM for a 4B model)'], ['262144', '256K']].forEach(([v, n]) => {
    const o = el('option', '', n); o.value = v; localCtxSel.appendChild(o);
  });
  localCtxSel.value = String(s.localNumCtx || 73728);
  lctxRow.appendChild(localCtxSel);
  c8.appendChild(lctxRow);
  // Per-model context override: skips the 70K floor for that model. Warn, don't
  // block — a small model may still serve simple turns, and it is the user's call. #11
  const forceLbl = el('label', 'fld');
  forceLbl.appendChild(el('span', '', 'Force context per model — one `model=number` per line. The engine usually rejects turns past the model\u2019s real context, so use this only for models you know.'));
  const forceInput = el('textarea', 'force-ctx');
  forceInput.rows = 2;
  forceInput.placeholder = 'qwen3-4b=32768';
  forceInput.value = Object.entries(s.forceCtx || {}).map(([k, v]) => k + '=' + v).join('\n');
  forceLbl.appendChild(forceInput);
  c8.appendChild(forceLbl);
  body.appendChild(c8);

  // appearance (#47) + window behaviour (#46) + notifications (#36)
  const c9 = el('div', 'settings-card');
  c9.appendChild(el('h4', '', 'Appearance & window'));
  const themeRow = el('div', 'inline');
  themeRow.appendChild(el('span', 'hint', 'Theme'));
  const themeSel = el('select'); themeSel.style.width = '160px';
  for (const [v, n] of [['dark', 'dark'], ['light', 'light']]) {
    const o = el('option', '', n); o.value = v; themeSel.appendChild(o);
  }
  themeSel.value = s.theme === 'light' ? 'light' : 'dark';
  applyTheme(themeSel.value);
  themeRow.appendChild(themeSel);
  c9.appendChild(themeRow);
  const trayCheck = el('input'); trayCheck.type = 'checkbox'; trayCheck.checked = !!s.closeToTray;
  const trayLabel = el('label', 'check');
  trayLabel.appendChild(trayCheck);
  trayLabel.appendChild(el('span', '', 'Close to tray — keep chats running when the window is closed'));
  c9.appendChild(trayLabel);
  const notifyCheck = el('input'); notifyCheck.type = 'checkbox'; notifyCheck.checked = s.notifyOnDone !== false;
  const notifyLabel = el('label', 'check');
  notifyLabel.appendChild(notifyCheck);
  notifyLabel.appendChild(el('span', '', 'Notify when a turn finishes while the window is in the background'));
  c9.appendChild(notifyLabel);
  body.appendChild(c9);

  // lean tools (#41) + provider failover chain (#42)
  const c10 = el('div', 'settings-card');
  c10.appendChild(el('h4', '', 'Small local models'));
  c10.appendChild(el('div', 'hint',
    'The claude engine ships a large base prompt (skills + plugins ≈ 68K tokens). Cutting the tool list is the only real way to make a 3-4B model fit — every tool schema is prompt. Per-provider overrides live in Providers → ⚙ on the provider card.'));
  const leanSel = el('select'); leanSel.style.width = '260px';
  const oOff = el('option', '', 'full tool set (default)'); oOff.value = ''; leanSel.appendChild(oOff);
  for (const p of (state.leanPresets || [])) {
    const o = el('option', '', p.label + ' — ' + p.tools.length + ' tools'); o.value = p.id; leanSel.appendChild(o);
  }
  leanSel.value = s.leanToolsPreset || '';
  c10.appendChild(leanSel);
  const preset = (state.leanPresets || []).find(p => p.id === leanSel.value);
  if (preset) c10.appendChild(el('div', 'hint', 'Allowed: ' + preset.tools.join(', ')));

  const fo = el('label', 'fld');
  fo.appendChild(el('span', '', 'Provider failover chain (retry a failed turn on the next provider)'));
  const chain = Array.isArray(s.failoverChain) ? s.failoverChain : [];
  const chainWrap = el('div', 'chain-wrap');
  state.providers.instances.forEach((p) => {
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = chain.includes(p.uid); cb.dataset.uid = p.uid;
    const l = el('label', 'check');
    l.appendChild(cb);
    l.appendChild(el('span', '', p.name));
    chainWrap.appendChild(l);
  });
  if (!state.providers.instances.length) chainWrap.appendChild(el('div', 'hint', 'no providers configured'));
  fo.appendChild(chainWrap);
  c10.appendChild(fo);
  body.appendChild(c10);

  // save
  const saveBtn = el('button', 'btn primary', 'Save settings');
  saveBtn.style.alignSelf = 'flex-start';
  saveBtn.addEventListener('click', async () => {
    await saveSettings({
      claudePath: pathInput.value.trim(),
      fontSize: Math.max(8, Math.min(24, parseInt(fontInput.value, 10) || 14)),
      scrollback: Math.max(500, Math.min(200000, parseInt(sbInput.value, 10) || 5000)),
      disableTelemetry: telCheck.checked,
      maxBudgetUsd: parseFloat(budInput.value) || 0,
      maxTurns: parseInt(turnsInput.value, 10) || 0,
      fallbackModel: fbInput.value.trim(),
      thinkingBudget: parseInt(tbInput.value, 10) || 0,
      effort: efInput.value.trim(),
      context1m: m1c.checked,
      showThinking: stc.checked,
      localNumCtx: Number(localCtxSel.value) || 73728,
      forceCtx: parseForceCtx(forceInput.value),
      theme: themeSel.value,
      closeToTray: trayCheck.checked,
      notifyOnDone: notifyCheck.checked,
      // Store the preset id, resolved to a tool list in main so the renderer
      // never has to send a tool array it could get wrong.
      leanToolsPreset: leanSel.value,
      failoverChain: [...chainWrap.querySelectorAll('input[type=checkbox]')]
        .filter(cb => cb.checked).map(cb => cb.dataset.uid),
      sandbox: {
        enabled: sbEnabled.checked,
        autoAllowBashIfSandboxed: sbAuto.checked,
        allowUnsandboxedCommands: sbUnsand.checked,
        allowLocalBinding: sbLocal.checked,
        allowedDomains: sbDomains.value.split(',').map(x => x.trim()).filter(Boolean),
      },
    });
    for (const sess of state.sessions.values()) {
      sess.term.options.fontSize = state.settings.fontSize;
      sess.term.options.scrollback = state.settings.scrollback;
      sess.fit.fit();
    }
  });
  body.appendChild(saveBtn);
}

async function saveSettings(patch) {
  const r = await ccx.invoke('settings:set', { settings: patch });
  if (r.ok) {
    state.settings = r.settings;
    state.info = { ...state.info, claude: r.claude };
    renderClaudeBanner();
    updateStatusbar(state.sessions.get(state.activeId) || { provider: null, alive: true, cwd: '' });
    toast('Settings saved', 'ok');
  } else toast(r.error, 'err');
}

export function renderClaudeBanner() {
  const banner = $('#claude-banner');
  const ci = state.info && state.info.claude;
  if (!ci || !ci.found) {
    banner.classList.remove('hidden');
    banner.textContent = 'claude CLI not found — ';
    const b = el('button', 'btn small primary', 'install it now');
    b.title = 'Opens a terminal tab running: curl -fsSL https://claude.ai/install.sh | bash';
    b.addEventListener('click', () => {
      window.createSession({ cwd: '~', type: 'shell', initText: 'curl -fsSL https://claude.ai/install.sh | bash\r' });
    });
    banner.appendChild(b);
    const re = el('button', 'btn small', 're-check');
    re.title = 'Probe for the claude CLI again (e.g. right after installing or updating it)';
    re.addEventListener('click', async () => {
      const r = await ccx.invoke('app:info', { refresh: true });
      if (r && r.ok) {
        state.info = { ...state.info, claude: r.claude };
        renderClaudeBanner();
        if (r.claude && r.claude.found) toast('claude found: ' + r.claude.version, 'ok');
      }
    });
    banner.appendChild(re);
    banner.appendChild(el('span', '', ' (or set the path in Settings)'));
  } else banner.classList.add('hidden');
}
