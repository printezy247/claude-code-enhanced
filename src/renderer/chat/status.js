// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { queueRules, renderQueued, scheduleWake, setQueue } from './qpanel.js';
import { holdText, nextAction } from './queue.js';
import { pollContext, publishTabState, startContextPolling, stopContextPolling } from './session.js';
import { basename, fmtTok, modeLabel } from './util.js';

export function updateBusyUi(chat) {
  if (window.refreshOverview) window.refreshOverview(chat.id, 300);   // status: working / idle
  if (!chat.sendBtn) return;
  const isBusy = !!chat.busy;
  if (chat.busyModeBtn) {
    chat.busyModeBtn.classList.toggle('hidden', !isBusy);
    const mode = chat.busyMode || 'queue';
    chat.busyModeBtn.innerHTML = mode === 'steer'
      ? '<span class="busy-mode-badge steer">↯ Steer</span>'
      : '<span class="busy-mode-badge queue">⏭ Queue</span>';
    chat.busyModeBtn.title = mode === 'steer'
      ? 'Steer mode: Claude reads it after its current step (Enter). Click to switch to Queue.'
      : 'Queue mode: Runs after turn completes (Enter). Click to switch to Steer.';
  }
  const mode = chat.busyMode || 'queue';
  if (isBusy) {
    const hasText = Boolean((chat.composer && chat.composer.value.trim()) || chat.pendingImages.length);
    if (hasText) {
      chat.sendBtn.innerHTML = CCEIcons.svg(mode === 'steer' ? 'bolt' : 'play', 15);
      chat.sendBtn.title = mode === 'steer'
        ? 'Steer (Enter) · Ctrl+Enter to queue'
        : 'Queue (Enter) · Ctrl+Enter to steer';
      chat.sendBtn.classList.remove('busy');
      chat.sendBtn.classList.toggle('mode-steer', mode === 'steer');
      chat.sendBtn.classList.toggle('mode-queue', mode === 'queue');
    } else {
      chat.sendBtn.innerHTML = CCEIcons.svg('square', 15);
      chat.sendBtn.title = 'Stop (Esc)';
      chat.sendBtn.classList.add('busy');
      chat.sendBtn.classList.remove('mode-steer', 'mode-queue');
    }
  } else {
    chat.sendBtn.innerHTML = CCEIcons.svg('send', 15);
    chat.sendBtn.title = 'Send (Enter)';
    chat.sendBtn.classList.remove('busy', 'mode-steer', 'mode-queue');
  }
}

export function setBusy(chat, busy) {
  // Late status frames from the dead engine must not resurrect a handed-off tab.
  if (chat.handedOff && busy) return;
  chat.busy = busy;
  publishTabState(chat);
  chat.dot.classList.toggle('busy', busy);
  chat.stopBtn.classList.toggle('hidden', !busy);
  if (chat.takeBtn) chat.takeBtn.classList.toggle('hidden', !busy);
  chat.contBtn.classList.toggle('hidden', busy || !chat.lastResult || !chat.alive);
  updateBusyUi(chat);
  if (busy) { chat.statusLine.textContent = 'working…'; startContextPolling(chat); }
  else {
    if (chat.ctxTimer) { stopContextPolling(chat); pollContext(chat); }
    setStatusLine(chat);
    drainQueue(chat);
  }
}

/** Restore a mode, model or effort a queued item changed for its own turn. */
async function restoreOverrides(chat) {
  const r = chat.restoreAfterTurn;
  if (!r) return;
  chat.restoreAfterTurn = null;
  try {
    if (r.mode && r.mode !== chat.mode) { const x = await ccx.invoke('chat:set-mode', { id: chat.id, mode: r.mode }); if (x.ok) { chat.mode = r.mode; if (chat.modeSel) chat.modeSel.value = r.mode; } }
    if (r.model !== undefined && r.model !== chat.model) { const x = await ccx.invoke('chat:set-model', { id: chat.id, model: r.model }); if (x.ok) chat.model = x.model || r.model; }
    if (r.effort !== undefined && r.effort !== chat.effort) { chat.effort = r.effort; await ccx.invoke('chat:effort', { id: chat.id, effort: r.effort }); }
  } catch { /* the chat keeps what it has */ }
}

/** A queued item's own mode, model or effort, remembered so they can be put back. */
export async function applyOverrides(chat, item) {
  const snap = {};
  try {
    if (item.mode && item.mode !== chat.mode) {
      const x = await ccx.invoke('chat:set-mode', { id: chat.id, mode: item.mode });
      if (x.ok) { snap.mode = chat.mode; chat.mode = item.mode; if (chat.modeSel) chat.modeSel.value = item.mode; }
    }
    if (item.model && item.model !== chat.model) {
      const prev = chat.model;
      const x = await ccx.invoke('chat:set-model', { id: chat.id, model: item.model });
      if (x.ok) { snap.model = prev; chat.model = x.model || item.model; }
    }
    if (item.effort && item.effort !== chat.effort) {
      snap.effort = chat.effort || '';
      chat.effort = item.effort;
      await ccx.invoke('chat:effort', { id: chat.id, effort: item.effort });
    }
  } catch { /* run it with what the chat has */ }
  if (Object.keys(snap).length) chat.restoreAfterTurn = snap;
}

function notifyQueue(chat, text) {
  try {
    if (document.hasFocus()) return;
    if (window.state && window.state.settings && window.state.settings.notifyOnDone === false) return;
    if (typeof Notification !== 'undefined') new Notification('Claude Code Enhanced', { body: text, silent: false });
  } catch { /* no notification support */ }
}

/**
 * Run the next queued item when the chat is idle, unless a rule holds it.
 * Safe to call at any time: it does nothing while the chat is busy.
 */
export async function drainQueue(chat) {
  if (!chat.alive || chat.busy) return;
  await restoreOverrides(chat);
  const list = chat.pendingMsgs || [];
  const act = nextAction(list, {
    paused: chat.queuePaused,
    lastTurnError: chat.lastTurnError && !chat.queueOverride,
    permWaiting: chat.permCount > 0 && !chat.queueOverride,
    spendWarn: chat.spendWarn && !chat.queueOverride,
    testsFailed: chat.lastTurnTests && !chat.queueOverride,
    rules: queueRules(),
  });
  if (!act) {
    if (chat.queueRanAny) { chat.queueRanAny = false; notifyQueue(chat, 'The queue is done.'); }
    chat.queueHeld = null;
    return;
  }
  if (act.hold) {
    const first = chat.queueHeld !== act.hold;
    chat.queueHeld = act.hold === 'paused' ? null : act.hold;
    renderQueued(chat);
    if (act.hold === 'scheduled') scheduleWake(chat);
    else if (first && act.hold !== 'paused') notifyQueue(chat, holdText(act.hold));
    return;
  }
  chat.queueHeld = null;
  chat.queueOverride = false;
  const next = act.run;
  chat.queueRanAny = true;
  setQueue(chat, list.slice(1));
  await applyOverrides(chat, next);
  setTimeout(() => {
    if (!chat.alive) return;
    chat.lastTurnError = false;
    chat.lastTurnTests = false;
    ccx.invoke('chat:send', { id: chat.id, text: next.text, blocks: next.blocks })
      .then((r) => { if (!r || !r.ok) setBusy(chat, false); })
      .catch(() => setBusy(chat, false));
  }, 50);
}

/**
 * What the status bar says about sign-in. The engine reports apiKeySource 'none'
 * for an account (claude.ai) login too, since no API key is involved, so 'none'
 * alone is not a problem: "no auth" is shown only after a sign-in actually failed.
 */
export function authLabel(apiKeySource, keyProvider, authFailed) {
  if (apiKeySource !== 'none') return apiKeySource;
  if (keyProvider) return 'provider key';
  return authFailed ? 'no auth — /login in a terminal tab' : 'account login';
}

export function setStatusLine(chat) {
  // A local or relayed provider reports Anthropic-derived cost for work it
  // never billed, so "$0.0204" against Ollama was actively misleading. #15
  const metered = !chat.provider || !chat.provider.baseUrl;
  const parts = [chat.model ? 'model: ' + chat.model : (chat.provider ? 'model: provider default' : 'model: CLI default' + (chat.init && chat.init.model ? ' (' + chat.init.model + ')' : '')), 'mode: ' + modeLabel(chat.mode, chat.caps && chat.caps.modes)];
  if (metered && chat.spent > 0.0001) parts.push('session $' + chat.spent.toFixed(4));
  if (chat.lastResult) {
    const r = chat.lastResult;
    if (metered && typeof r.total_cost_usd === 'number' && r.total_cost_usd > 0) parts.push('$' + r.total_cost_usd.toFixed(4));
    parts.push((r.num_turns != null ? r.num_turns : 0) + ' turns', Math.round((r.duration_ms || 0) / 1000) + 's');
    const u = r.usage || {};
    if (u.input_tokens != null) parts.push('↑' + (metered ? '' : '~') + fmtTok(u.input_tokens) + ' ↓' + (metered ? '' : '~') + fmtTok(u.output_tokens)
      + (u.cache_read_input_tokens ? ' ⚡' + fmtTok(u.cache_read_input_tokens) + ' cached' : ''));
  }
  chat.statusLine.textContent = parts.join('  ·  ');
  if (chat.init) {
    const auth = chat.init.apiKeySource;
    // The key lives in cce's own store now (authType/authHint), so the old
    // flags were false and a working provider read "no auth — /login".
    const keyProvider = !!(chat.provider && (chat.provider.hasApiKey || chat.provider.hasAuthToken
      || chat.provider.authType || chat.provider.authHint || chat.provider.baseUrl));
    const mAuth = authLabel(auth, keyProvider, chat.authFailed);
    chat.statusRight.textContent = (chat.init.model || '') + ' · ' + mAuth;
    // The row is only for a problem: model, mode, cost and turns live in the footbar and Overview.
    const row = chat.statusLine.closest('.chat-statusline');
    if (row) row.classList.toggle('has-warn', /no auth/.test(mAuth));
    chat.providerEl.textContent = chat.provider ? basename(chat.provider.name) : 'default env';
  }
}
