// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { $, state, toast } from '../app/core.js';
import { fillModeSelect, uiMode } from '../app/modes.js';
import { doCompact } from './slash.js';
import { setStatusLine } from './status.js';
import { basename, chats, el } from './util.js';

/* ---------------- composer extras (#32) ---------------- */

/**
 * Effort is a dropdown listing only what the model accepts (OpenCode's
 * "variants"): a model with no effort setting shows no picker at all, and a
 * model with low/medium/high shows just those. Re-run after every model or
 * provider change.
 */
export async function refreshEffort(chat) {
  const sel = chat.effortBtn;
  if (!sel) return;
  let levels = [];
  try {
    const r = await ccx.invoke('chat:effort-levels', { id: chat.id });
    if (r && r.ok && Array.isArray(r.levels)) levels = r.levels;
  } catch { /* no levels: hide the picker */ }
  chat.effortLevels = levels;
  sel.innerHTML = '';
  if (!levels.length) {
    sel.classList.add('hidden');
    if (chat.effort) { chat.effort = ''; ccx.invoke('chat:effort', { id: chat.id, effort: '' }).catch(() => {}); }
    return;
  }
  for (const v of ['', ...levels]) {
    const o = el('option', '', 'effort: ' + (v || 'auto'));
    o.value = v;
    sel.appendChild(o);
  }
  if (chat.effort && !levels.includes(chat.effort)) {
    // The new model does not have the level the old one was on.
    chat.effort = '';
    ccx.invoke('chat:effort', { id: chat.id, effort: '' }).catch(() => {});
  }
  sel.value = chat.effort || '';
  sel.classList.remove('hidden');
  if (chat.syncModelBtn) chat.syncModelBtn();
}

export async function setEffort(chat, next) {
  const prev = chat.effort || '';
  chat.effort = next || '';
  const r = await ccx.invoke('chat:effort', { id: chat.id, effort: chat.effort });
  if (!r || !r.ok) {
    toast((r && r.error) || 'effort not supported here', 'err');
    chat.effort = prev;
    if (chat.effortBtn) chat.effortBtn.value = prev;
  } else if (chat.effort) toast('effort → ' + chat.effort, 'ok');
  if (chat.syncModelBtn) chat.syncModelBtn();
}

/* ---------------- model selector ---------------- */

/* ---------------- searchable model + provider picker ---------------- */

const modelInfoCache = new Map();

/** Catalog facts for a picker value ('' = provider default, '__pm:uid\u0001model' = another provider). */
async function modelInfoFor(chat, value) {
  const pm = String(value || '').startsWith('__pm:');
  const [uid, m] = pm ? value.slice(5).split('\u0001') : [null, value];
  const key = (pm ? uid : (chat.provider && chat.provider.uid) || '') + '\u0001' + (m || '');
  if (modelInfoCache.has(key)) return modelInfoCache.get(key);
  let info = null;
  try {
    const r = await ccx.invoke('chat:model-info', { id: chat.id, uid: pm ? uid : undefined, model: m || '' });
    if (r && r.ok) info = r;
  } catch { /* offline catalog: stay quiet */ }
  modelInfoCache.set(key, info);
  return info;
}

const fmtCtx = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1e3) + 'k');

function infoLine(info) {
  if (!info) return 'no catalog entry for this model';
  const bits = [];
  if (info.context) bits.push(fmtCtx(info.context) + ' context');
  bits.push(info.vision === false ? '⚠ no images' : info.vision ? 'images' : '');
  bits.push(info.tools === false ? '⚠ no tool calls' : info.tools ? 'tools' : '');
  bits.push(info.reasoning ? 'reasoning' : '');
  return bits.filter(Boolean).join(' · ') || 'no catalog entry for this model';
}

/** The visible model control; the hidden <select> stays the single source of truth. */
export function wireModelPicker(chat) {
  const sel = chat.modelSel, btn = chat.modelBtn;
  if (!btn) return;
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    // One chip for model and effort: "model · high".
    btn.querySelector('.mb-label').textContent = (o ? o.textContent : 'model') + (chat.effort ? ' · ' + chat.effort : '');
    btn.title = (o ? o.textContent + ' — ' : '') + 'change model or provider';
  };
  // Code all over this file sets sel.value directly; keep the button in step.
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); sync(); } });
  chat.syncModelBtn = sync;
  sync();
  btn.addEventListener('click', () => openModelPicker(chat));
}

function openModelPicker(chat) {
  document.querySelector('.model-pop')?.remove();
  const sel = chat.modelSel;
  const rows = [];
  for (const n of sel.children) {
    if (n.tagName === 'OPTGROUP') for (const o of n.children) rows.push({ value: o.value, label: o.textContent, group: n.label });
    else rows.push({ value: n.value, label: n.textContent, group: '' });
  }
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('cce.recentModels') || '[]'); } catch { /* none */ }
  const pop = el('div', 'model-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Choose a model');
  const q = el('input', 'model-q');
  q.type = 'text'; q.placeholder = 'Search models and providers…'; q.setAttribute('aria-label', 'Search models');
  const list = el('div', 'model-list');
  list.setAttribute('role', 'listbox');
  const cap = el('div', 'model-cap hint', '');
  pop.append(q, list, cap);
  document.body.appendChild(pop);
  const r = chat.modelBtn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 400)) + 'px';
  pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';

  let shown = [], active = 0;
  const close = () => { pop.remove(); document.removeEventListener('mousedown', away, true); };
  const away = (e) => { if (!pop.contains(e.target) && e.target !== chat.modelBtn && !chat.modelBtn.contains(e.target)) close(); };
  document.addEventListener('mousedown', away, true);
  const pick = (row) => {
    close();
    if (row.value && row.value !== '__custom') {
      try { localStorage.setItem('cce.recentModels', JSON.stringify([row.value, ...recent.filter((v) => v !== row.value)].slice(0, 5))); } catch { /* quota */ }
    }
    sel.value = row.value;
    sel.dispatchEvent(new Event('change'));
  };
  const paintCap = async () => {
    const row = shown[active];
    if (!row) { cap.textContent = ''; return; }
    cap.textContent = '…';
    const info = row.value === '__custom' ? null : await modelInfoFor(chat, row.value);
    if (shown[active] === row) cap.textContent = row.value === '__custom' ? 'type any model id the provider serves' : infoLine(info);
    cap.classList.toggle('warn', /⚠/.test(cap.textContent));
  };
  const paint = () => {
    const term = q.value.trim().toLowerCase();
    list.textContent = '';
    const match = (x) => !term || (x.label + ' ' + x.group).toLowerCase().includes(term);
    const recents = term ? [] : recent.map((v) => rows.find((x) => x.value === v)).filter(Boolean);
    shown = [];
    const section = (title, items) => {
      if (!items.length) return;
      if (title) list.appendChild(el('div', 'model-group', title));
      for (const x of items) {
        const b = el('button', 'model-row' + (x.value === sel.value ? ' current' : ''), x.label);
        b.type = 'button'; b.setAttribute('role', 'option');
        const i = shown.push(x) - 1;
        b.dataset.i = String(i);
        list.appendChild(b);
      }
    };
    section(recents.length ? 'Recent' : '', recents);
    const groups = new Map();
    for (const x of rows.filter(match)) { if (!groups.has(x.group)) groups.set(x.group, []); groups.get(x.group).push(x); }
    for (const [g, items] of groups) section(g || (term ? 'Matches' : 'This provider'), items);
    if (!shown.length) list.appendChild(el('div', 'hint model-empty', 'No model matches. Use "Custom…" to type an id.'));
    active = Math.max(0, shown.findIndex((x) => x.value === sel.value && !term));
    mark();
  };
  const mark = () => {
    list.querySelectorAll('.model-row').forEach((b) => b.classList.toggle('active', Number(b.dataset.i) === active));
    list.querySelector('.model-row.active')?.scrollIntoView({ block: 'nearest' });
    paintCap();
  };
  list.addEventListener('mousemove', (e) => { const b = e.target.closest('.model-row'); if (b && Number(b.dataset.i) !== active) { active = Number(b.dataset.i); mark(); } });
  list.addEventListener('click', (e) => { const b = e.target.closest('.model-row'); if (b) pick(shown[Number(b.dataset.i)]); });
  q.addEventListener('input', paint);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (shown[active]) pick(shown[active]); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); chat.modelBtn.focus(); e.preventDefault(); e.stopPropagation(); }
  });
  paint();
  q.focus();
}

/**
 * Before a model or provider switch: will the transcript fit, and can the
 * target read the images already in it? Returns false to cancel the switch.
 */
export async function guardSwitch(chat, value) {
  if (!value || value === '__custom') return true;
  const info = await modelInfoFor(chat, value);
  if (!info) return true;
  const used = (chat.ctxUsage && chat.ctxUsage.totalTokens) || 0;
  if (info.context && used > info.context * 0.9) {
    const compact = window.confirm('This conversation uses about ' + fmtCtx(used) + ' tokens, but the new model holds ' + fmtCtx(info.context)
      + '.\n\nOK = compact the conversation first, then switch.\nCancel = decide next.');
    if (compact) { await doCompact(chat); return true; }
    return window.confirm('Switch anyway? The next message may be rejected for being too long.');
  }
  if (info.vision === false && chat.sentImages) {
    return window.confirm('The new model cannot read images, and this conversation contains some. They will be replaced by a note. Switch anyway?');
  }
  if (info.tools === false) toast('⚠ ' + (info.model || 'This model') + ' cannot call tools: it will answer in text only, with no file or shell access', 'err');
  return true;
}

export function fillModelSelector(chat) {
  try { fillModelSelectorInner(chat); } finally { if (chat.syncModelBtn) chat.syncModelBtn(); }
}

function fillModelSelectorInner(chat) {
  const sel = chat.modelSel;
  sel.innerHTML = '';
  const add = (value, label) => { const o = el('option', '', label); o.value = value; sel.appendChild(o); };
  const p = chat.provider;
  // One picker for provider AND model (like OpenCode): every OTHER saved
  // provider is a group of its own models, and choosing one switches this
  // chat onto that provider and model, keeping the conversation. They come
  // AFTER this provider's own models, so the select shows the current one.
  const addOthers = () => {
    const provs = (state && state.providers && state.providers.instances) || [];
    const modelsOf = (pr) => [...new Set([pr.model, ...(pr.whitelist && pr.whitelist.length ? pr.whitelist : (pr.models || []))]
      .map((m) => (m && typeof m === 'object' ? (m.id || m.name) : m)).filter(Boolean))].slice(0, 40);
    for (const pr of provs) {
      if (p && pr.uid === p.uid) continue;
      const pg = document.createElement('optgroup');
      pg.label = (pr.name || pr.uid) + ' — switch provider';
      const list = modelsOf(pr);
      if (!list.length) list.push('');
      for (const m of list) {
        const o = el('option', '', (m || 'provider default') + '  ·  ' + basename(pr.name || pr.uid));
        o.value = '__pm:' + pr.uid + '\u0001' + m;
        pg.appendChild(o);
      }
      sel.appendChild(pg);
    }
  };
  // A third-party provider does not serve Claude model names. Offering
  // Opus/Sonnet/Haiku there sent a name it lacks; the proxy then substituted
  // another model, so the pick looked ignored. List the provider's own models.
  const thirdParty = !!(p && p.baseUrl && !/(^|\.)anthropic\.com/i.test(String(p.baseUrl)));
  if (thirdParty) {
    const own = [...new Set([p.model, ...(p.whitelist && p.whitelist.length ? p.whitelist : (p.models || [])), chat.model]
      .filter(Boolean))];
    add('', p.model ? 'provider default · ' + p.model : 'provider default (none set)');
    own.forEach(m => add(m, m + '  ·  ' + basename(p.name)));
    add('__custom', 'Custom…');
    addOthers();
    sel.value = chat.model && own.includes(chat.model) ? chat.model : '';
    return;
  }
  add('', 'provider default');
  if (p && p.model) add(p.model, p.model + ' (' + basename(p.name) + ')');
  add('opus', 'Opus');
  add('sonnet', 'Sonnet');
  add('haiku', 'Haiku');
  add('__custom', 'Custom…');
  addOthers();
  sel.value = [...sel.options].some((o) => o.value === chat.model) ? chat.model : '';
  // Ask the engine what it actually supports; append anything we missed. The
  // hard-coded aliases above stay as a fallback before the first turn. #39
  ccx.invoke('chat:supported-models', { id: chat.id }).then((r) => {
    if (!r || !r.ok || !r.models || !r.models.length) return;
    const have = new Set([...sel.options].map(o => o.value));
    const group = document.createElement('optgroup');
    group.label = 'from the claude engine';
    let n = 0;
    for (const m of r.models) {
      const id2 = m.value || m.id || m.name;
      if (!id2 || have.has(id2)) continue;
      const o = el('option', '', m.displayName || m.label || id2 + (m.contextWindow ? ' · ' + (m.contextWindow >= 1000000 ? Math.round(m.contextWindow / 1000000) + 'M' : Math.round(m.contextWindow / 1000) + 'K') : ''));
      o.value = id2;
      group.appendChild(o);
      n++;
    }
    if (n) sel.insertBefore(group, sel.querySelector('[value="__custom"]'));
  }).catch(() => {});
}

// Switch model: pre-warm it on the provider first (a local Ollama model must
// load into memory, which otherwise exceeds the CLI's confirm timeout).
export async function switchModel(chat, model) {
  model = String(model || '').split(',')[0].trim();
  const prev = chat.model;
  try {
    if (model && chat.provider && chat.provider.baseUrl) {
      toast('loading ' + model + ' into memory…');
    }
    const r = await ccx.invoke('chat:set-model', { id: chat.id, model });
    if (r.ok) {
      chat.model = r.model || model;
      if (window.refreshOverview) window.refreshOverview(chat.id, 300);
      if (r.model && r.model !== model) toast('model name corrected → ' + r.model);
      setStatusLine(chat);
      refreshEffort(chat);
      toast('Model → ' + (chat.model || 'provider default'), 'ok');
    } else {
      const e = String(r.error || '');
      if (r.blocked) toast(e, 'err');
      else if (/Free usage limit|not in the Free plan/i.test(e)) toast('Ollama Cloud quota/plan limit — wait for the window to reset or upgrade at ollama.com/upgrade', 'err');
      else toast(e, 'err');
      chat.modelSel.value = prev || '';
    }
  } catch (e) {
    toast(String(e.message || e), 'err');
    chat.modelSel.value = prev || '';
  }
}

// Switch this chat to another saved provider. The main process recreates the
// engine session on the target provider and resumes the conversation, which
// means a NEW chat id — this tab re-keys itself onto it so nothing else in
// the app (tab registry, statusbar, event routing) notices. #feat-provider-toggle
export async function switchProvider(chat, uid, model) {
  if (chat.provider && chat.provider.uid === uid) { fillModelSelector(chat); return; }
  const name = ((state.providers.instances || []).find(p => p.uid === uid) || {}).name || uid;
  toast('switching provider → ' + name + '…');
  let r = null;
  try { r = await ccx.invoke('chat:set-provider', { id: chat.id, uid, model: model || '' }); }
  catch (e) { r = { ok: false, error: String(e.message || e) }; }
  if (!r || !r.ok) {
    toast((r && r.error) || 'provider switch failed', 'err');
    fillModelSelector(chat);
    return;
  }
  // Re-key: the old engine session is gone; this pane now IS the new chat.
  const oldId = chat.id;
  // Remembered until the new provider answers a turn: if it fails first, the error offers a way back.
  chat.switchedFrom = chat.provider && chat.provider.uid ? { uid: chat.provider.uid, name: chat.provider.name, model: chat.model || '' } : null;
  chats.delete(oldId);
  chat.id = r.id;
  chats.set(r.id, chat);
  if (window.refreshOverview) window.refreshOverview(chat.id, 300);
  if (window.rekeyTab) window.rekeyTab(oldId, r.id);
  chat.provider = r.provider;
  chat.model = r.model || '';
  chat.autoPolicy = !!r.autoPolicy;
  chat.mode = uiMode(r.permissionMode || chat.mode, chat.provider, chat.autoPolicy);
  // The old session's exit event can land during the swap and mark the tab
  // dead — the chat is alive again on the new engine.
  chat.alive = true;
  chat.tabEl.classList.remove('dead');
  chat.providerEl.textContent = basename(chat.provider.name);
  const mgr = chat.headerEl.querySelector('.chat-mgr-btn');
  if (mgr) mgr.classList.toggle('hidden', !(chat.provider && chat.provider.baseUrl));
  fillModelSelector(chat);
  fillModeSelect(chat.modeSel, chat.provider);
  chat.modeSel.value = chat.mode;
  chat.modelSel.value = [...chat.modelSel.options].some(o => o.value === chat.model) ? chat.model : '';
  setStatusLine(chat);
  chat.effort = '';
  refreshEffort(chat);
  discoverModels(chat);
  toast('Provider → ' + chat.provider.name + ' — this conversation now goes to that provider', 'ok');
}

// Ask the provider what models it actually serves (OpenCode-style discovery)
// and add them as a group — covers Ollama, LM Studio, llama.cpp, LiteLLM…
const TOOL_TIER = {
  'gpt-oss:120b-cloud': '★★★ top free tool-caller · 131K ctx ✓',
  'kimi-k3:cloud': '★★★ best overall (Pro) · 1M ctx',
  'nemotron-3-ultra:cloud': '★★☆ deep (slow) · 128K ✓',
  'nemotron-3-super:cloud': '★★☆ daily driver · 128K ✓',
  'YuriiFominYoung/opus-4.8:latest': '★★☆ (= nemotron super)',
  'glm-5.3:cloud': '★★★ (Pro) · 1M',
  'kimi-k2.7-code:cloud': '★★★ coding (Pro)',
  'gemma4:31b-cloud': '★☆☆ fast general · 128K ✓',
  'gpt-oss:20b-cloud': '★☆☆ light tasks · 131K ✓',
  'nemotron-3-nano:30b-cloud': '★☆☆ background · 64K ⚠',
  'FableForge-AI/mythos-v2-8b:q4_k_m': '★★★ local tool-caller · ⚠ ctx too small for claude chat',
  'qwen3-4b-64k:latest': '★☆☆ · ⚠ 64K ctx < claude prompt',
  'granite4.1:8b': '★☆☆ · load 131K ctx via ⚙ for claude chat',
  'granite4.1:3b': '★☆☆ · ⚠ small ctx',
};

const CCE_CTX_FLOOR = 70000;

 // claude engine base prompt — smaller ctx cannot serve chats
// Model reliability: how often a model produced a usable tool call on this
// machine. Surfaced in the picker so a weak model is visible, not a mystery. #43
function toolReliability(model) {
  const s = readStats();
  const n = s.models && s.models[model];
  if (!n || !n.calls) return null;
  return Math.round((n.ok / n.calls) * 100);
}

function readStats() {
  try { return JSON.parse(localStorage.getItem('cce.toolstats') || '{}'); }
  catch { return {}; }
}

export function noteToolOutcome(model, ok) {
  if (!model) return;
  try {
    const s = readStats();
    s.models = s.models || {};
    const e = s.models[model] || { calls: 0, ok: 0 };
    e.calls++;
    if (ok) e.ok++;
    s.models[model] = e;
    localStorage.setItem('cce.toolstats', JSON.stringify(s));
  } catch { /* private mode */ }
}

export async function discoverModels(chat) {
  if (!chat.provider || !chat.provider.baseUrl) return;
  const r = await ccx.invoke('provider:listModels', { uid: chat.provider.uid });
  if (!r.ok || !r.models || !r.models.length) return;
  let list = r.models.map(m => typeof m === 'string' ? { id: m, ctx: null } : m);
  // Enrich with models.dev metadata so cloud models without a context_length
  // (OpenAI, Anthropic-protocol relays) get a ctx for the floor filter and a
  // cost/tool-calling hint. #43
  const mdId = chat.provider.modelsDevId || chat.provider.presetId;
  if (mdId && list.some(m => m.ctx == null)) {
    try {
      const cm = await ccx.invoke('catalog:models', { providerId: mdId });
      const byId = new Map((cm.models || []).map(m => [m.id, m]));
      list = list.map((m) => {
        const meta = byId.get(m.id);
        if (!meta) return m;
        return { ...m, ctx: m.ctx != null ? m.ctx : ((meta.limit && meta.limit.context) || null), cost: meta.cost, tool_call: meta.tool_call };
      });
    } catch { /* metadata is optional */ }
  }
  const curated = (r.curated && r.curated.length) ? new Set(r.curated) : null;
  if (curated) list = list.filter(m => curated.has(m.id));   // user-curated selection wins
  // hide models that cannot host the claude prompt (context below the floor)
  const viable = list.filter(m => m.ctx === null || m.ctx >= CCE_CTX_FLOOR);
  const hidden = list.length - viable.length;
  // dedupe against existing options
  const existing = new Set([...chat.modelSel.options].map(o => o.value));
  const fresh = viable.filter(m => !existing.has(m.id));
  if (!fresh.length && !hidden) return;
  const group = document.createElement('optgroup');
  group.label = (curated ? 'your selected models (' + fresh.length + ')' : 'models for claude chat (' + fresh.length + ')')
    + (hidden ? ' — ' + hidden + ' hidden: context too small' : '');
  for (const m of fresh) {
    const o = el('option', '', m.id + (TOOL_TIER[m.id] ? '  ·  ' + TOOL_TIER[m.id] : ''));
    o.value = m.id;
    const rel = toolReliability(m.id);
    if (rel !== null) o.textContent += (TOOL_TIER[m.id] ? ' · ' : '  ·  ') + 'tools ' + rel + '%';
    group.appendChild(o);
  }
  if (fresh.length) chat.modelSel.insertBefore(group, chat.modelSel.querySelector('[value="__custom"]'));
  if (window.__CCE_SMOKE) console.log('[models-discovered]', fresh.length, 'hidden:', hidden);
}

export function openCustomModel(chat) {
  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal');
  modal.appendChild(el('h3', '', 'Custom model id'));
  const label = el('label', 'fld');
  label.appendChild(el('span', '', 'Model id sent to the provider (e.g. glm-4.6, kimi-for-coding, qwen3-coder:30b)'));
  const inp = el('input'); inp.type = 'text'; inp.placeholder = 'leave empty for provider default';
  label.appendChild(inp);
  modal.appendChild(label);
  const actions = el('div', 'actions');
  const cancel = el('button', 'btn', 'Cancel');
  cancel.addEventListener('click', () => { overlay.remove(); chat.modelSel.value = chat.model || ''; });
  const ok = el('button', 'btn primary', 'Use model');
  ok.addEventListener('click', async () => {
    const model = inp.value.trim();
    overlay.remove();
    await switchModel(chat, model);
    if (model && ![...chat.modelSel.options].some(o => o.value === model)) {
      const o = el('option', '', model);
      o.value = model;
      chat.modelSel.insertBefore(o, chat.modelSel.querySelector('[value="__custom"]'));
    }
    chat.modelSel.value = model;
  });
  actions.appendChild(cancel); actions.appendChild(ok);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  $('#modal-root').appendChild(overlay);
  inp.focus();
}
