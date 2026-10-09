// Providers UI — OpenCode-style provider settings.
//
// Owns the "Connect" picker (all models.dev providers, searchable), the provider
// detail panel (Auth / Models / Options / Advanced / Diagnostics tabs), and the
// unified local-runtime model manager. app.js delegates here; el/toast/ccx/$/
// state come from the shared renderer scope.
'use strict';

const ProvidersUI = (() => {
  // uid -> {ok, error, at} from the last Test connection.
  const testResults = new Map();
  // uid -> {status:'idle'|'running'|'done'|'error', msg}
  const oauthState = new Map();

  const catalog = () => (state.providers && state.providers.catalog) || [];
  const instances = () => (state.providers && state.providers.instances) || [];
  const modelsdev = () => (state.providers && state.providers.modelsdev) || { providers: 0, models: 0, source: 'bundled' };
  const byPreset = (id) => catalog().find(c => c.id === id) || null;

  function resolveTpl(tpl, values) {
    return String(tpl || '').replace(/\$\{(\w+)\}/g, (m, k) => {
      const v = values && values[k];
      return v == null || v === '' ? m : String(v);
    });
  }
  function placeholdersIn(tpl) {
    return [...String(tpl || '').matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
  }

  function chip(text, cls) { return el('span', 'chip ' + (cls || ''), text); }
  function capChip(cap) {
    const labels = {
      'native-anthropic': 'Anthropic API', 'openai-compat': 'OpenAI-compatible', oauth: 'OAuth',
      subscription: 'subscription', local: 'local', 'auto-discover': 'auto-discover',
      gateway: 'gateway', 'needs-account-id': 'needs account id', 'env-auth': 'env auth', cloud: 'cloud',
    };
    return chip(labels[cap] || cap, 'cap-' + String(cap).replace(/[^a-z0-9]+/gi, '-'));
  }
  function statusDot(uid) {
    const r = testResults.get(uid);
    const d = el('span', 'pstatus');
    if (!r) { d.textContent = '○'; d.title = 'Not tested yet'; d.classList.add('unknown'); }
    else if (r.ok) { d.textContent = '●'; d.title = 'Connection OK' + (r.modelCount ? ' — ' + r.modelCount + ' models' : ''); d.classList.add('ok'); }
    else { d.textContent = '●'; d.title = r.error || 'Failed'; d.classList.add('err'); }
    return d;
  }

  /* ============================ provider grid ============================ */

  async function render() {
    const grid = document.querySelector('#provider-grid');
    if (!grid) return;
    if (!catalog().length) await refreshCatalog();
    grid.innerHTML = '';
    const banner = document.querySelector('#provider-banner');
    if (banner) {
      banner.innerHTML = '';
      banner.appendChild(el('span', '', 'Providers inject environment variables into new sessions — the claude CLI stays unmodified. '));
      const md = modelsdev();
      const stat = el('span', 'hint', `${md.providers || 0} providers · ${(md.models || 0).toLocaleString()} models from models.dev (${md.source})`);
      banner.appendChild(stat);
      const refresh = el('button', 'btn small ghost', '\u21bb refresh catalog');
      refresh.addEventListener('click', async () => {
        refresh.disabled = true; refresh.textContent = '\u21bb refreshing…';
        const r = await ccx.invoke('modelsdev:refresh');
        refresh.disabled = false; refresh.textContent = '\u21bb refresh catalog';
        if (r.ok) { await refreshCatalog(); toast('Catalog updated — ' + r.providers + ' providers', 'ok'); }
        else toast('Catalog refresh failed: ' + r.error, 'err');
      });
      banner.appendChild(refresh);
    }

    if (!instances().length) {
      grid.appendChild(el('div', 'hint', 'No providers yet — click “+ Add provider”.'));
      return;
    }
    instances().forEach(p => grid.appendChild(providerCard(p)));
  }

  function providerCard(p) {
    const card = el('div', 'card provider-card' + (p.disabled ? ' disabled' : ''));
    const head = el('h4');
    head.appendChild(statusDot(p.uid));
    head.appendChild(el('span', '', p.name));
    if (p.uid === state.providers.defaultUid) head.appendChild(chip('default', 'default'));
    if (p.authType) head.appendChild(chip(p.authType === 'oauth' ? 'OAuth' : 'API key', 'kind-' + p.authType));
    if (p.local) head.appendChild(chip('local', 'kind-stdio'));
    if (p.disabled) head.appendChild(chip('disabled', 'kind-disabled'));
    card.appendChild(head);

    const preset = byPreset(p.presetId);
    if (preset && preset.blurb) card.appendChild(el('div', 'blurb', preset.blurb));
    if (p.baseUrl) card.appendChild(el('div', 'meta', 'URL  ' + p.baseUrl));
    else if (p.protocol === 'anthropic') card.appendChild(el('div', 'meta', 'official Anthropic API'));
    if (p.model) card.appendChild(el('div', 'meta', 'model  ' + p.model + (p.smallFastModel ? '  /  ' + p.smallFastModel : '')));
    if (p.authHint) card.appendChild(el('div', 'meta', (p.authType === 'oauth' ? 'oauth  ' : 'key  ') + p.authHint
      + (p.authExpired ? '  (expired — reconnect)' : '')));
    else card.appendChild(el('div', 'meta auth-none', 'no credential — add a key or sign in'));

    const caps = el('div', 'cap-row');
    (p.capabilities || []).forEach(c => caps.appendChild(capChip(c)));
    if (caps.childElementCount) card.appendChild(caps);

    const row = el('div', 'row');
    const test = el('button', 'btn small', 'Test');
    test.addEventListener('click', () => runTest(p, test));
    row.appendChild(test);
    const edit = el('button', 'btn small primary', 'Edit');
    edit.addEventListener('click', () => openDetail(p.uid));
    row.appendChild(edit);
    if (p.local || /localhost|127\.0\.0\.1/.test(p.baseUrl || '')) {
      const lm = el('button', 'btn small', '\u2699 models');
      lm.title = 'Load / unload models, context size, keep-alive';
      lm.addEventListener('click', () => openLocalManager(p.baseUrl));
      row.appendChild(lm);
    }
    const star = el('button', 'btn small ghost', p.uid === state.providers.defaultUid ? '\u2605 default' : '\u2606 set default');
    star.addEventListener('click', async () => {
      const r = await ccx.invoke('providers:default', { uid: p.uid });
      if (r.ok) { await refreshProviders(); toast('Default provider updated', 'ok'); }
      else toast(r.error, 'err');
    });
    row.appendChild(star);
    row.appendChild(el('span', 'spacer'));
    const dis = el('button', 'btn small ghost', p.disabled ? 'enable' : 'disable');
    dis.addEventListener('click', async () => {
      const r = await ccx.invoke('providers:save', { instance: { uid: p.uid, name: p.name, disabled: !p.disabled } });
      if (r.ok) { await refreshProviders(); }
      else toast(r.error, 'err');
    });
    row.appendChild(dis);
    const del = el('button', 'btn small danger', 'Delete');
    del.addEventListener('click', async () => {
      if (instances().length <= 1) return toast('Keep at least one provider', 'err');
      const r = await ccx.invoke('providers:delete', { uid: p.uid });
      if (r.ok) { await refreshProviders(); toast('Provider removed', 'ok'); }
      else toast(r.error, 'err');
    });
    row.appendChild(del);
    card.appendChild(row);
    return card;
  }

  async function runTest(p, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'testing…'; }
    const r = await ccx.invoke('providers:test', { uid: p.uid });
    testResults.set(p.uid, r);
    if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
    if (r.ok) toast(`OK — ${r.modelCount || 0} models${r.detail ? ' · ' + r.detail : ''}`, 'ok');
    else toast(r.error || 'test failed', 'err');
    if (state.view === 'providers') render();
    return r;
  }

  async function refreshCatalog() {
    const r = await ccx.invoke('catalog:all');
    if (r.ok) {
      state.providers.catalog = r.catalog || [];
      state.providers.modelsdev = r.modelsdev || state.providers.modelsdev;
    } else {
      toast('Could not load provider catalog: ' + r.error, 'err');
    }
  }

  /* ============================ connect picker ============================ */

  async function openConnect() {
    if (!catalog().length) await refreshCatalog();
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal wide');
    modal.appendChild(el('h3', '', 'Connect a provider'));
    modal.appendChild(el('div', 'hint', 'Every models.dev provider is listed. Pick one to add it — you can also add a custom OpenAI-compatible or Anthropic-compatible endpoint.'));

    const search = el('input'); search.type = 'text'; search.placeholder = 'Search 200+ providers…'; search.className = 'provider-search';
    modal.appendChild(search);

    const filters = el('div', 'filter-row');
    let activeFilter = 'all';
    const FILTERS = [['all', 'All'], ['oauth', 'Subscriptions'], ['cloud', 'Cloud'], ['gateway', 'Gateways'], ['local', 'Local']];
    FILTERS.forEach(([id, label]) => {
      const b = el('button', 'chip filter' + (id === 'all' ? ' active' : ''), label);
      b.dataset.filter = id;
      b.addEventListener('click', () => {
        activeFilter = id;
        filters.querySelectorAll('.filter').forEach(x => x.classList.toggle('active', x.dataset.filter === id));
        drawList();
      });
      filters.appendChild(b);
    });
    modal.appendChild(filters);

    const list = el('div', 'connect-list');
    modal.appendChild(list);

    function matches(entry) {
      if (activeFilter === 'oauth' && !/oauth/.test(entry.authKind || '')) return false;
      if (activeFilter === 'local' && !entry.local) return false;
      if (activeFilter === 'gateway' && !(entry.capabilities || []).includes('gateway')) return false;
      if (activeFilter === 'cloud' && (entry.local || /oauth/.test(entry.authKind || ''))) return false;
      const q = (search.value || '').trim().toLowerCase();
      if (!q) return true;
      return (entry.name + ' ' + (entry.display || '') + ' ' + entry.id).toLowerCase().includes(q);
    }

    function drawList() {
      list.innerHTML = '';
      const items = catalog().filter(matches).slice(0, 400);
      if (!items.length) { list.appendChild(el('div', 'hint', 'Nothing matches.')); return; }
      for (const e of items) {
        const row = el('button', 'connect-row');
        const main = el('div', 'connect-main');
        main.appendChild(el('div', 'connect-name', e.display || e.name));
        if (e.blurb) main.appendChild(el('div', 'connect-blurb', e.blurb));
        row.appendChild(main);
        const right = el('div', 'connect-right');
        (e.capabilities || []).slice(0, 2).forEach(c => right.appendChild(capChip(c)));
        if (e.modelCount) right.appendChild(el('span', 'hint', e.modelCount + ' models'));
        row.appendChild(right);
        row.addEventListener('click', () => { overlay.remove(); startConnect(e); });
        list.appendChild(row);
      }
    }
    search.addEventListener('input', drawList);
    drawList();

    const actions = el('div', 'actions');
    const close = el('button', 'btn', 'Cancel');
    close.addEventListener('click', () => overlay.remove());
    actions.appendChild(close);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    document.querySelector('#modal-root').appendChild(overlay);
    search.focus();
  }

  /** Create the instance (asking for placeholder values first) and open it. */
  async function startConnect(entry) {
    const tpl = entry.baseUrlTemplate || '';
    const phKeys = entry.baseUrlTemplate ? placeholdersIn(entry.baseUrlTemplate) : [];
    const placeholders = {};
    if (phKeys.length) {
      const overlay = el('div', 'modal-overlay');
      const modal = el('div', 'modal');
      modal.appendChild(el('h3', '', entry.name));
      modal.appendChild(el('div', 'hint', 'This provider needs a few values baked into its URL.'));
      const inputs = {};
      for (const key of phKeys) {
        const l = el('label', 'fld');
        l.appendChild(el('span', '', key));
        const inp = el('input'); inp.type = 'text';
        const hint = (entry.placeholders || []).find(p => p.key === key);
        inp.placeholder = hint ? (hint.hint || hint.label) : '';
        l.appendChild(inp); modal.appendChild(l); inputs[key] = inp;
      }
      const actions = el('div', 'actions');
      const cancel = el('button', 'btn', 'Cancel');
      cancel.addEventListener('click', () => overlay.remove());
      const ok = el('button', 'btn primary', 'Continue');
      ok.addEventListener('click', async () => {
        for (const [k, inp] of Object.entries(inputs)) placeholders[k] = inp.value.trim();
        overlay.remove();
        await createAndOpen(entry, placeholders, tpl);
      });
      actions.appendChild(cancel); actions.appendChild(ok);
      modal.appendChild(actions);
      overlay.appendChild(modal);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
      document.querySelector('#modal-root').appendChild(overlay);
      inputs[phKeys[0]].focus();
      return;
    }
    await createAndOpen(entry, placeholders, tpl);
  }

  async function createAndOpen(entry, placeholders, tpl) {
    const baseUrl = tpl ? resolveTpl(tpl, placeholders) : (entry.baseUrl || '');
    const payload = {
      presetId: entry.id,
      name: entry.display || entry.name,
      protocol: entry.protocol || 'anthropic',
      baseUrl,
      keyHeader: entry.keyHeader || 'bearer',
      placeholders: Object.keys(placeholders).length ? placeholders : undefined,
      model: entry.defaultModel || '',
      smallFastModel: entry.defaultSmall || '',
      alwaysTranslate: (entry.protocol || 'anthropic') !== 'anthropic',
    };
    const r = await ccx.invoke('providers:save', { instance: payload });
    if (!r.ok) return toast(r.error, 'err');
    await refreshProviders();
    if (entry.oauth && entry.authKind !== 'api-key') openDetail(r.uid, { autoAuth: true });
    else openDetail(r.uid);
  }

  /* ============================ detail panel ============================ */

  function openDetail(uid, opts = {}) {
    const p = instances().find(x => x.uid === uid);
    if (!p) return toast('Provider not found', 'err');
    const entry = byPreset(p.presetId) || {};
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal wide provider-detail');
    const head = el('div', 'detail-head');
    head.appendChild(el('h3', '', p.name));
    head.appendChild(chip(p.protocol === 'anthropic' ? 'Anthropic protocol' : p.protocol, 'kind-' + p.protocol));
    if (p.authType) head.appendChild(chip(p.authType === 'oauth' ? 'OAuth' : 'API key', 'kind-' + p.authType));
    modal.appendChild(head);
    if (entry.blurb) modal.appendChild(el('div', 'blurb', entry.blurb));

    const tabs = el('div', 'tab-row');
    const body = el('div', 'detail-body');
    modal.appendChild(tabs);
    modal.appendChild(body);
    const TABS = [['auth', 'Auth'], ['models', 'Models'], ['options', 'Options'], ['advanced', 'Advanced'], ['diag', 'Diagnostics']];
    let active = opts.tab || 'auth';
    const panes = {};
    function show(id) {
      active = id;
      tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
      body.innerHTML = '';
      body.appendChild(panes[id]());
    }
    for (const [id, label] of TABS) {
      const t = el('button', 'tab' + (id === active ? ' active' : ''), label);
      t.dataset.tab = id;
      t.addEventListener('click', () => show(id));
      tabs.appendChild(t);
    }
    panes.auth = () => authPane(p, entry, reload);
    panes.models = () => modelsPane(p, entry, reload);
    panes.options = () => optionsPane(p, entry, reload);
    panes.advanced = () => advancedPane(p, entry, reload);
    panes.diag = () => diagPane(p, entry);

    show(active);

    const actions = el('div', 'actions');
    const close = el('button', 'btn', 'Close');
    close.addEventListener('click', () => overlay.remove());
    actions.appendChild(close);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    document.querySelector('#modal-root').appendChild(overlay);
    if (opts.autoAuth && entry.oauth) tabs.querySelector('[data-tab="auth"]').click();
    return { reload: () => show(active), close: () => overlay.remove() };

    function reload() { show(active); }
  }

  /** Save a patch onto the provider and refresh the card list. */
  async function savePatch(p, patch) {
    const r = await ccx.invoke('providers:save', { instance: { uid: p.uid, name: p.name, ...patch } });
    if (r.ok) await refreshProviders();
    return r;
  }

  /* -------- Auth tab -------- */
  function authPane(p, entry, reload) {
    const wrap = el('div', 'pane');
    const status = el('div', 'auth-status');
    const paintStatus = () => {
      status.innerHTML = '';
      if (p.authType === 'oauth') {
        const exp = p.authExpires ? new Date(p.authExpires).toLocaleString() : 'unknown';
        status.appendChild(el('span', 'chip kind-oauth', 'OAuth'));
        status.appendChild(el('span', 'hint', 'token ' + (p.authHint || 'stored') + ' · expires ' + exp + (p.authExpired ? ' (expired)' : '')));
      } else if (p.authType === 'api') {
        status.appendChild(el('span', 'chip kind-api', 'API key'));
        status.appendChild(el('span', 'hint', p.authHint || 'stored'));
      } else {
        status.appendChild(el('span', 'chip', 'no credential'));
        status.appendChild(el('span', 'hint', entry.local ? 'local runtime — no key needed' : 'add a key or sign in below'));
      }
    };
    paintStatus();
    wrap.appendChild(status);

    // OAuth sign-in
    if (entry.oauth) {
      const box = el('div', 'auth-box');
      box.appendChild(el('h4', '', entry.oauth.label || 'Sign in'));
      box.appendChild(el('div', 'hint', p.authType === 'oauth'
        ? 'Already signed in. Re-run the flow to switch accounts.'
        : 'Opens the provider\u2019s OAuth page. Tokens are stored encrypted in auth.json and refreshed automatically.'));
      let clientIdInput = null;
      if (entry.oauth.clientIdEnv) {
        const l = el('label', 'fld');
        l.appendChild(el('span', '', 'OAuth application id' + (entry.oauth.clientIdEnv ? ' (or set ' + entry.oauth.clientIdEnv + ')' : '')));
        clientIdInput = el('input'); clientIdInput.type = 'text'; clientIdInput.placeholder = 'application / client id';
        l.appendChild(clientIdInput); box.appendChild(l);
      }
      const btnRow = el('div', 'row');
      const signBtn = el('button', 'btn primary', p.authType === 'oauth' ? 'Reconnect' : ('Sign in with ' + (entry.display || entry.name)));
      signBtn.addEventListener('click', () => beginOAuth(p, entry, clientIdInput ? clientIdInput.value.trim() : '', reload));
      btnRow.appendChild(signBtn);
      box.appendChild(btnRow);
      box.appendChild(el('div', 'hint', 'Note: some subscription logins are experimental for use with the claude engine. The Anthropic subscription flow also writes ~/.claude/.credentials.json.'));
      wrap.appendChild(box);
    }

    // API key
    if (entry.authKind !== 'oauth' || entry.oauth) {
      const keyBox = el('div', 'auth-box');
      keyBox.appendChild(el('h4', '', 'API key'));
      const l = el('label', 'fld');
      l.appendChild(el('span', '', 'Key (stored in auth.json' + (entry.local ? ' — leave blank for local' : '') + ')'));
      const inp = el('input'); inp.type = 'password'; inp.placeholder = p.authHint ? 'leave blank to keep ' + p.authHint : 'paste the API key';
      l.appendChild(inp); keyBox.appendChild(l);
      const row = el('div', 'row');
      const save = el('button', 'btn primary', 'Save key');
      save.addEventListener('click', async () => {
        const key = inp.value.trim();
        if (!key) return toast('Enter a key first', 'err');
        const r = await ccx.invoke('auth:setKey', { uid: p.uid, key });
        if (r.ok) { inp.value = ''; await refreshProviders(); const np = instances().find(x => x.uid === p.uid); Object.assign(p, np || {}); paintStatus(); toast('Key saved', 'ok'); }
        else toast(r.error, 'err');
      });
      row.appendChild(save);
      const clear = el('button', 'btn small danger', 'Clear');
      clear.addEventListener('click', async () => {
        const r = await ccx.invoke('auth:clear', { uid: p.uid });
        if (r.ok) { await refreshProviders(); const np = instances().find(x => x.uid === p.uid); Object.assign(p, np || {}); paintStatus(); toast('Credential cleared', 'ok'); }
        else toast(r.error, 'err');
      });
      row.appendChild(clear);
      keyBox.appendChild(row);
      wrap.appendChild(keyBox);
    }

    // Test
    const testBox = el('div', 'auth-box');
    testBox.appendChild(el('h4', '', 'Test connection'));
    const out = el('div', 'test-out hint', '');
    const trow = el('div', 'row');
    const tbtn = el('button', 'btn', 'Test');
    tbtn.addEventListener('click', async () => {
      tbtn.disabled = true; tbtn.textContent = 'testing…';
      const r = await runTest(p);
      tbtn.disabled = false; tbtn.textContent = 'Test';
      out.textContent = r.ok
        ? 'OK — ' + (r.modelCount || 0) + ' models' + (r.detail ? ' · ' + r.detail : '')
        : (r.error || 'failed');
      out.className = 'test-out ' + (r.ok ? 'ok' : 'err');
    });
    trow.appendChild(tbtn);
    testBox.appendChild(trow); testBox.appendChild(out);
    wrap.appendChild(testBox);
    return wrap;
  }

  /** Run an OAuth flow and show its progress inline. */
  async function beginOAuth(p, entry, clientId, reload) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    modal.appendChild(el('h3', '', 'Sign in — ' + (entry.display || entry.name)));
    const msg = el('div', 'hint', 'Starting…');
    modal.appendChild(msg);
    const link = el('a', 'oauth-link', ''); link.href = '#';
    modal.appendChild(link);
    const codeLine = el('div', 'oauth-code');
    modal.appendChild(codeLine);
    const actions = el('div', 'actions');
    const cancel = el('button', 'btn', 'Cancel');
    actions.appendChild(cancel);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.querySelector('#modal-root').appendChild(overlay);

    let sessionId = null;
    const onCancel = async () => {
      if (sessionId) await ccx.invoke('providers:oauth-cancel', { sessionId });
      overlay.remove();
    };
    cancel.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && e.target !== modal) onCancel(); });

    const r = await ccx.invoke('providers:connect', { presetId: entry.id, clientId });
    if (!r.ok) {
      msg.textContent = r.error || 'could not start sign-in';
      if (r.needsClientId) msg.textContent = r.hint;
      return;
    }
    sessionId = r.sessionId;
    msg.textContent = r.instructions || 'Authorize in the browser.';
    if (r.url) {
      link.textContent = r.url.length > 70 ? r.url.slice(0, 70) + '…' : r.url;
      link.addEventListener('click', (e) => { e.preventDefault(); ccx.invoke('shell:openExternal', { url: r.url }); });
      ccx.invoke('shell:openExternal', { url: r.url });
    }
    if (r.method === 'device' && r.userCode) codeLine.textContent = 'Code: ' + r.userCode;

    let codeInput = null;
    if (r.method === 'code') {
      const l = el('label', 'fld');
      l.appendChild(el('span', '', 'Paste the code shown in the browser'));
      codeInput = el('input'); codeInput.type = 'text';
      l.appendChild(codeInput);
      modal.insertBefore(l, actions);
      const okBtn = el('button', 'btn primary', 'Finish sign-in');
      okBtn.addEventListener('click', async () => {
        okBtn.disabled = true; okBtn.textContent = 'verifying…';
        await finish(r.sessionId, codeInput.value.trim(), p, entry, msg, overlay);
      });
      actions.appendChild(okBtn);
      codeInput.focus();
    } else {
      msg.textContent += ' Waiting for authorization…';
      finish(r.sessionId, null, p, entry, msg, overlay);
    }
  }

  async function finish(sessionId, code, p, entry, msg, overlay) {
    const r = await ccx.invoke('providers:oauth-complete', { sessionId, code, uid: p.uid, name: p.name });
    if (!r.ok) { msg.textContent = 'Sign-in failed: ' + r.error; return; }
    overlay.remove();
    await refreshProviders();
    toast('Signed in — ' + (entry.display || entry.name), 'ok');
    if (state.view === 'providers') render();
    openDetail(p.uid);
  }

  /* -------- Models tab -------- */
  function modelsPane(p, entry, reload) {
    const wrap = el('div', 'pane');
    const mdId = p.modelsDevId || entry.modelsDevId || entry.id;
    wrap.appendChild(el('div', 'hint', 'Pick the models that appear in the chat dropdown. The default model is used for new chats. Metadata (context, cost, tool-calling) comes from models.dev.'));

    const chosen = new Set(p.whitelist && p.whitelist.length ? p.whitelist : (p.models || []));
    const black = new Set(p.blacklist || []);
    let currentModel = p.model || '';

    const search = el('input'); search.type = 'text'; search.placeholder = 'filter models…';
    const toolbar = el('div', 'row');
    toolbar.appendChild(search);
    const loadBtn = el('button', 'btn small', '↻ list from provider');
    toolbar.appendChild(loadBtn);
    wrap.appendChild(toolbar);

    // opencode-style declared models: add any id by hand, even when the
    // provider has no /models endpoint or models.dev doesn't know it.
    const addRow = el('div', 'row');
    const addInp = el('input'); addInp.type = 'text'; addInp.placeholder = 'add model id (e.g. deepseek-v4-flash)';
    const addBtn = el('button', 'btn small', '+ add');
    addRow.appendChild(addInp); addRow.appendChild(addBtn);
    wrap.appendChild(addRow);

    const list = el('div', 'model-list');
    wrap.appendChild(list);

    let catalogModels = [];
    let liveModels = [];
    // Saved + recommended ids always show, whatever the live listing returns.
    const savedIds = new Set([...(p.models || []), ...(p.whitelist || []), ...(entry.recommendedModels || []), ...(p.model ? [p.model] : [])]);
    const addModel = () => {
      const id = addInp.value.trim();
      if (!id) return;
      savedIds.add(id); chosen.add(id); black.delete(id);
      addInp.value = '';
      draw();
    };
    addBtn.addEventListener('click', addModel);
    addInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addModel(); } });
    const rows = new Map();

    function draw() {
      list.innerHTML = '';
      rows.clear();
      const q = (search.value || '').trim().toLowerCase();
      const byId = new Map();
      for (const id of savedIds) byId.set(id, { id, source: 'saved' });
      for (const m of catalogModels) byId.set(m.id, { ...m, source: 'catalog' });
      for (const m of liveModels) byId.set(m.id, { ...(byId.get(m.id) || {}), ...m, source: 'live', live: true });
      const all = [...byId.values()].filter(m => !q || String(m.id).toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q));
      all.sort((a, b) => (b.tool_call ? 1 : 0) - (a.tool_call ? 1 : 0) || String(a.id).localeCompare(String(b.id)));
      if (!all.length) { list.appendChild(el('div', 'hint', loadBtn.dataset.loaded ? 'No models returned.' : 'Click “list from provider”, or search models.dev below.')); }
      for (const m of all.slice(0, 500)) {
        const row = el('label', 'model-row');
        const cb = el('input'); cb.type = 'checkbox';
        // Whitelist semantics: if any selected, treat selection as the whitelist.
        cb.checked = chosen.size ? chosen.has(m.id) : !black.has(m.id);
        cb.addEventListener('change', () => {
          if (cb.checked) { chosen.add(m.id); black.delete(m.id); }
          else { chosen.delete(m.id); black.add(m.id); }
          updateSummary();
        });
        row.appendChild(cb);
        const name = el('span', 'model-name', m.id);
        row.appendChild(name);
        const meta = el('span', 'model-meta');
        if (m.ctx || (m.limit && m.limit.context)) meta.appendChild(chip(Math.round((m.ctx || (m.limit && m.limit.context)) / 1000) + 'K ctx'));
        if (m.tool_call) meta.appendChild(chip('tools', 'cap-tools'));
        if (m.reasoning) meta.appendChild(chip('reasoning'));
        if (m.cost && (m.cost.input || m.cost.output)) meta.appendChild(chip('$' + (m.cost.input || 0) + '/' + (m.cost.output || 0)));
        if (m.live) meta.appendChild(chip('live', 'cap-live'));
        row.appendChild(meta);
        const def = el('button', 'btn small ghost', currentModel === m.id ? '★ default' : '☆ set default');
        def.addEventListener('click', (e) => { e.preventDefault(); currentModel = m.id; draw(); });
        row.appendChild(def);
        rows.set(m.id, row);
        list.appendChild(row);
      }
      updateSummary();
    }

    const summary = el('div', 'hint model-summary');
    wrap.appendChild(summary);
    function updateSummary() {
      summary.textContent = (chosen.size ? chosen.size + ' selected (whitelist)' : 'no whitelist — all except ' + black.size + ' hidden')
        + ' · default: ' + (currentModel || '(provider default)');
    }

    loadBtn.addEventListener('click', async () => {
      loadBtn.disabled = true; loadBtn.textContent = 'loading…';
      const r = await ccx.invoke('provider:listModels', { uid: p.uid });
      loadBtn.disabled = false; loadBtn.textContent = '↻ list from provider'; loadBtn.dataset.loaded = '1';
      if (r.ok) { liveModels = (r.models || []).filter(m => !m.declared).map(m => ({ id: m.id, ctx: m.ctx, live: true })); draw(); if (r.error) toast(r.error, 'err'); }
      else toast('Could not list models: ' + (r.error || ''), 'err');
    });
    search.addEventListener('input', draw);

    const saveRow = el('div', 'row');
    const saveBtn = el('button', 'btn primary', 'Save models');
    saveBtn.addEventListener('click', async () => {
      const r = await savePatch(p, { whitelist: [...chosen], blacklist: [...black], models: [...chosen], model: currentModel });
      if (r.ok) { toast('Models saved', 'ok'); reload(); }
      else toast(r.error, 'err');
    });
    saveRow.appendChild(saveBtn);
    wrap.appendChild(saveRow);

    // Async: pull catalog metadata + live list.
    ccx.invoke('catalog:models', { providerId: mdId }).then((r) => {
      if (r.ok && r.models) { catalogModels = r.models; draw(); }
    });
    ccx.invoke('provider:listModels', { uid: p.uid }).then((r) => {
      if (r.ok && r.models) { liveModels = r.models.map(m => ({ id: m.id, ctx: m.ctx, live: true })); loadBtn.dataset.loaded = '1'; draw(); }
    });
    draw();
    return wrap;
  }

  /* -------- Options tab -------- */
  function optionsPane(p, entry, reload) {
    const wrap = el('div', 'pane');
    const grid = el('div', 'form-grid');

    const mk = (label, value, type = 'text', hint) => {
      const l = el('label', 'fld wide');
      l.appendChild(el('span', '', label));
      const inp = el('input'); inp.type = type; inp.value = value || '';
      l.appendChild(inp);
      if (hint) l.appendChild(el('div', 'hint', hint));
      return { l, inp };
    };

    const name = mk('Display name', p.name);
    const protocol = el('label', 'fld wide');
    protocol.appendChild(el('span', '', 'Transport protocol'));
    const protoSel = el('select');
    [['anthropic', 'Anthropic Messages (native)'], ['openai', 'OpenAI chat completions (adapter)'], ['openai-responses', 'OpenAI Responses (adapter)'], ['gemini', 'Gemini generateContent (adapter)']].forEach(([v, n]) => {
      const o = el('option', '', n); o.value = v; protoSel.appendChild(o);
    });
    protoSel.value = p.protocol || 'anthropic';
    protocol.appendChild(protoSel);
    if (!entry.derived && entry.protocol && entry.protocol !== 'anthropic') protocol.appendChild(el('div', 'hint', 'Preset default: ' + entry.protocol));

    const base = mk('Base URL (empty = official Anthropic API)', p.baseUrl, 'text', entry.editableBaseUrl ? 'Editable for this provider.' : '');
    const model = mk('Default model (one slug)', p.model, 'text', 'Used for new chats unless the chat switches model.');
    const small = mk('Small / background model', p.smallFastModel, 'text', 'Title generation and lightweight tasks.');
    const keyHeader = el('label', 'fld wide');
    keyHeader.appendChild(el('span', '', 'Auth header'));
    const khSel = el('select');
    [['bearer', 'Authorization: Bearer'], ['x-api-key', 'x-api-key'], ['query', 'query param (?key=)'], ['api-key', 'api-key (Azure)']].forEach(([v, n]) => { const o = el('option', '', n); o.value = v; khSel.appendChild(o); });
    khSel.value = p.keyHeader || 'bearer';
    keyHeader.appendChild(khSel);

    const headers = el('label', 'fld wide');
    headers.appendChild(el('span', '', 'Extra HTTP headers (JSON)'));
    const headersTa = el('textarea'); headersTa.rows = 2; headersTa.value = JSON.stringify(p.headers || {}, null, 2);
    headers.appendChild(headersTa);

    // placeholders
    let phInputs = {};
    const phWrap = el('div', 'form-grid');
    const phKeys = entry.baseUrlTemplate ? placeholdersIn(entry.baseUrlTemplate) : [];
    for (const k of phKeys) {
      const l = el('label', 'fld');
      l.appendChild(el('span', '', k));
      const inp = el('input'); inp.type = 'text'; inp.value = (p.placeholders && p.placeholders[k]) || '';
      l.appendChild(inp); phWrap.appendChild(l); phInputs[k] = inp;
    }

    grid.appendChild(name.l);
    grid.appendChild(protocol);
    grid.appendChild(base.l);
    grid.appendChild(model.l);
    grid.appendChild(small.l);
    grid.appendChild(keyHeader);
    if (phKeys.length) grid.appendChild(phWrap);
    grid.appendChild(headers);
    wrap.appendChild(grid);

    const saveBtn = el('button', 'btn primary', 'Save');
    saveBtn.addEventListener('click', async () => {
      let hdrs = {};
      try { hdrs = JSON.parse(headersTa.value || '{}'); } catch { return toast('Extra headers must be valid JSON', 'err'); }
      const ph = {};
      for (const [k, inp] of Object.entries(phInputs)) ph[k] = inp.value.trim();
      const patch = {
        name: name.inp.value.trim() || 'Provider',
        protocol: protoSel.value,
        baseUrl: base.inp.value.trim(),
        model: model.inp.value.split(',')[0].trim(),
        smallFastModel: small.inp.value.split(',')[0].trim(),
        keyHeader: khSel.value,
        headers: hdrs,
        placeholders: Object.keys(ph).length ? ph : undefined,
        alwaysTranslate: protoSel.value !== 'anthropic',
      };
      const r = await savePatch(p, patch);
      if (r.ok) { toast('Saved', 'ok'); reload(); }
      else toast(r.error, 'err');
    });
    wrap.appendChild(saveBtn);
    return wrap;
  }

  /* -------- Advanced tab -------- */
  function advancedPane(p, entry, reload) {
    const wrap = el('div', 'pane');
    wrap.appendChild(el('div', 'hint', 'Lean tools trim the engine\u2019s tool schemas so small local models fit the ~70K context floor. Env extras are passed to the engine\u2019s process.'));

    const leanWrap = el('label', 'fld wide');
    leanWrap.appendChild(el('span', '', 'Lean tool set'));
    const leanSel = el('select');
    const off = el('option', '', 'full tool set (default)'); off.value = ''; leanSel.appendChild(off);
    for (const pr of (state.leanPresets || [])) {
      const o = el('option', '', pr.label + ' — ' + pr.tools.join(', ')); o.value = pr.id; leanSel.appendChild(o);
    }
    leanSel.value = p.leanTools ? (state.leanPresets || []).find(pr => pr.tools.length === p.leanTools.length && pr.tools.every(t => p.leanTools.includes(t)))?.id || '' : '';
    leanWrap.appendChild(leanSel);

    const envWrap = el('label', 'fld wide');
    envWrap.appendChild(el('span', '', 'Extra environment variables (JSON)'));
    const envTa = el('textarea'); envTa.rows = 3; envTa.value = JSON.stringify(p.envExtras || {}, null, 2);
    envWrap.appendChild(envTa);

    wrap.appendChild(leanWrap);
    wrap.appendChild(envWrap);

    const row = el('div', 'row');
    const saveBtn = el('button', 'btn primary', 'Save');
    saveBtn.addEventListener('click', async () => {
      let env = {};
      try { env = JSON.parse(envTa.value || '{}'); } catch { return toast('Env extras must be valid JSON', 'err'); }
      const preset = (state.leanPresets || []).find(pr => pr.id === leanSel.value);
      const r = await savePatch(p, { envExtras: env, leanToolsPreset: preset ? preset.id : '', leanTools: preset ? preset.tools : null });
      if (r.ok) { toast('Saved', 'ok'); reload(); }
      else toast(r.error, 'err');
    });
    row.appendChild(saveBtn);

    const del = el('button', 'btn danger', 'Delete provider');
    del.addEventListener('click', async () => {
      if (instances().length <= 1) return toast('Keep at least one provider', 'err');
      const r = await ccx.invoke('providers:delete', { uid: p.uid });
      if (r.ok) { toast('Removed', 'ok'); await refreshProviders(); document.querySelectorAll('.modal-overlay').forEach(o => o.remove()); }
      else toast(r.error, 'err');
    });
    row.appendChild(del);
    wrap.appendChild(row);
    return wrap;
  }

  /* -------- Diagnostics tab -------- */
  function diagPane(p, entry) {
    const wrap = el('div', 'pane');
    const t = testResults.get(p.uid);
    wrap.appendChild(el('div', 'hint', t
      ? (t.ok ? 'Last test: OK — ' + (t.modelCount || 0) + ' models (' + new Date().toLocaleTimeString() + ')' : 'Last test failed: ' + t.error)
      : 'No test run yet — use the Auth tab.'));
    const kv = el('div', 'diag-kv');
    const put = (k, v) => { const r = el('div', 'diag-row'); r.appendChild(el('span', 'dk', k)); r.appendChild(el('span', 'dv', String(v))); kv.appendChild(r); };
    put('uid', p.uid);
    put('preset', p.presetId);
    put('protocol', p.protocol);
    put('models.dev id', p.modelsDevId || '—');
    put('base URL', p.baseUrl || '(official Anthropic)');
    put('auth', p.authType ? p.authType + ' ' + (p.authHint || '') : 'none');
    if (p.authExpires) put('token expires', new Date(p.authExpires).toLocaleString());
    put('capabilities', (p.capabilities || []).join(', ') || '—');
    put('docs', entry.docsUrl || '—');
    wrap.appendChild(kv);

    const testBtn = el('button', 'btn primary', 'Run test');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true; testBtn.textContent = 'testing…';
      await runTest(p);
      testBtn.disabled = false; testBtn.textContent = 'Run test';
      diagPaneRefresh();
    });
    wrap.appendChild(testBtn);

    const diagOut = el('div', 'diag-kv');
    wrap.appendChild(diagOut);
    const diagBtn = el('button', 'btn small', 'Show resolved session env');
    diagBtn.addEventListener('click', async () => {
      const r = await ccx.invoke('providers:diagnostics', { uid: p.uid });
      diagOut.innerHTML = '';
      if (!r.ok) { diagOut.appendChild(el('div', 'hint', r.error)); return; }
      const put2 = (k, v) => { const row = el('div', 'diag-row'); row.appendChild(el('span', 'dk', k)); row.appendChild(el('span', 'dv', String(v))); diagOut.appendChild(row); };
      put2('credential present', r.hasSecret ? 'yes (' + (r.authType || 'secret') + ')' : 'no');
      put2('session env keys', (r.envKeys || []).join(', ') || '(none)');
      put2('engine gets token', r.carriesToken ? 'yes' : 'no — via proxy');
      put2('routed through proxy', r.usesProxy ? 'yes' : 'no');
    });
    wrap.appendChild(diagBtn);
    function diagPaneRefresh() {
      const body = document.querySelector('.provider-detail .detail-body');
      if (body) { body.innerHTML = ''; body.appendChild(diagPane(p, entry)); }
    }
    if (entry.docsUrl) {
      const a = el('a', '', 'open provider docs');
      a.href = '#'; a.addEventListener('click', (e) => { e.preventDefault(); ccx.invoke('shell:openExternal', { url: entry.docsUrl }); });
      wrap.appendChild(a);
    }
    return wrap;
  }

  /* ============================ local model manager ============================ */

  async function openLocalManager(baseUrl) {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal wide');
    modal.appendChild(el('h3', '', '⚙ Local models'));
    modal.appendChild(el('div', 'hint', 'Load models into memory with a context size, or unload them to free VRAM. Works with Ollama, LM Studio, llama.cpp and vLLM.'));

    const scanRow = el('div', 'row');
    const runtimeSel = el('select'); runtimeSel.style.minWidth = '240px';
    const scanBtn = el('button', 'btn small', '↻ scan');
    scanRow.appendChild(runtimeSel); scanRow.appendChild(scanBtn);
    modal.appendChild(scanRow);

    const ctxSel = el('select');
    [['4096', '4K ctx'], ['8192', '8K ctx'], ['16384', '16K ctx'], ['32768', '32K ctx'], ['65536', '64K ctx'], ['131072', '128K ctx'], ['262144', '256K ctx']].forEach(([v, n]) => { const o = el('option', '', n); o.value = v; ctxSel.appendChild(o); });
    ctxSel.value = String((state.settings && state.settings.localNumCtx) || 131072);
    const kaSel = el('select');
    [['5m', 'keep 5m'], ['30m', 'keep 30m'], ['1h', 'keep 1h'], ['-1', 'keep forever']].forEach(([v, n]) => { const o = el('option', '', n); o.value = v; kaSel.appendChild(o); });
    kaSel.value = '30m';
    const controls = el('div', 'inline');
    controls.appendChild(el('span', 'hint', 'load with:'));
    controls.appendChild(ctxSel); controls.appendChild(kaSel);
    modal.appendChild(controls);

    const loadedBox = el('div', 'settings-card');
    loadedBox.appendChild(el('h4', '', 'Loaded now'));
    const loadedList = el('div', 'skills-list');
    loadedBox.appendChild(loadedList);
    const allBox = el('div', 'settings-card');
    allBox.appendChild(el('h4', '', 'Available'));
    const allList = el('div', 'skills-list');
    allBox.appendChild(allList);
    modal.appendChild(loadedBox); modal.appendChild(allBox);

    const fmtBytes = (n) => {
      if (!n) return '—';
      const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
    };

    let currentBase = baseUrl || '';
    async function scan() {
      const r = await ccx.invoke('localruntimes:scan');
      runtimeSel.innerHTML = '';
      if (!r.ok || !r.runtimes.length) {
        const o = el('option', '', 'no local runtime found'); o.value = ''; runtimeSel.appendChild(o);
        return;
      }
      for (const rt of r.runtimes) {
        const o = el('option', '', rt.name + '  (' + rt.baseUrl + ') — ' + rt.modelCount + ' models');
        o.value = rt.baseUrl; runtimeSel.appendChild(o);
      }
      if (currentBase && r.runtimes.some(rt => rt.baseUrl === currentBase)) runtimeSel.value = currentBase;
      else currentBase = runtimeSel.value;
      draw();
    }

    async function draw() {
      currentBase = runtimeSel.value;
      if (!currentBase) { loadedList.innerHTML = ''; allList.innerHTML = ''; return; }
      loadedList.innerHTML = '<div class="hint">loading…</div>';
      allList.innerHTML = '';
      const r = await ccx.invoke('localruntimes:models', { baseUrl: currentBase });
      if (!r.ok) { loadedList.innerHTML = ''; loadedList.appendChild(el('div', 'hint', 'Failed: ' + (r.error || ''))); return; }
      const loadedNames = new Set((r.loaded || []).map(m => m.name));
      loadedList.innerHTML = '';
      (r.loaded || []).forEach(m => {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', m.name));
        row.appendChild(el('span', 'skill-desc', fmtBytes(m.sizeVram) + (m.expires ? ' · expires ' + new Date(m.expires).toLocaleTimeString() : '')));
        row.appendChild(el('span', 'chip', 'loaded'));
        if ((r.runtime || '') === 'ollama') {
          const unload = el('button', 'btn small danger', 'unload');
          unload.addEventListener('click', async () => { unload.disabled = true; await ccx.invoke('localruntimes:manage', { baseUrl: currentBase, model: m.name, action: 'unload' }); draw(); });
          row.appendChild(unload);
        }
        loadedList.appendChild(row);
      });
      if (!(r.loaded || []).length) loadedList.appendChild(el('div', 'hint', 'Nothing loaded right now.'));
      allList.innerHTML = '';
      (r.available || []).forEach(m => {
        const row = el('div', 'skill-row');
        row.appendChild(el('code', '', m.name));
        row.appendChild(el('span', 'skill-desc', [m.paramSize, m.quant, fmtBytes(m.size), m.ctx ? Math.round(m.ctx / 1000) + 'K ctx' : ''].filter(Boolean).join(' · ')));
        if (loadedNames.has(m.name)) row.appendChild(el('span', 'chip', 'loaded'));
        else {
          const load = el('button', 'btn small primary', 'load');
          load.addEventListener('click', async () => {
            load.disabled = true; load.textContent = 'loading…';
            const rr = await ccx.invoke('localruntimes:manage', { baseUrl: currentBase, model: m.name, action: 'load', numCtx: ctxSel.value, keepAlive: kaSel.value === '-1' ? -1 : kaSel.value });
            if (!rr.ok) toast('Load failed: ' + (rr.error || rr.status || ''), 'err');
            draw();
          });
          row.appendChild(load);
        }
        allList.appendChild(row);
      });
      if (!(r.available || []).length) allList.appendChild(el('div', 'hint', 'No models found — pull one first (ollama pull …).'));
    }

    scanBtn.addEventListener('click', scan);
    runtimeSel.addEventListener('change', draw);
    await scan();

    const actions = el('div', 'actions');
    const close = el('button', 'btn primary', 'Close');
    close.addEventListener('click', () => overlay.remove());
    actions.appendChild(close);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    document.querySelector('#modal-root').appendChild(overlay);
  }

  return { render, openConnect, openDetail, openLocalManager, refreshCatalog, statusDot };
})();

window.ProvidersUI = ProvidersUI;
