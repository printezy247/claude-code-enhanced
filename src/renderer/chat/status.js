// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { persistPending, renderQueued } from './composer.js';
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
  chat.contBtn.classList.toggle('hidden', busy || !chat.lastResult || !chat.alive);
  updateBusyUi(chat);
  if (busy) { chat.statusLine.textContent = 'working…'; startContextPolling(chat); }
  else {
    if (chat.ctxTimer) { stopContextPolling(chat); pollContext(chat); }
    setStatusLine(chat);
    // Auto-dispatch next queued message if any
    if (chat.pendingMsgs && chat.pendingMsgs.length > 0) {
      const next = chat.pendingMsgs.shift();
      persistPending(chat);
      renderQueued(chat);
      const nextText = typeof next === 'string' ? next : (next && next.text) || '';
      const nextBlocks = typeof next === 'object' && next ? next.blocks : null;
      setTimeout(() => {
        if (!chat.alive) return;
        ccx.invoke('chat:send', { id: chat.id, text: nextText, blocks: nextBlocks })
          .then((r) => { if (!r || !r.ok) setBusy(chat, false); })
          .catch(() => setBusy(chat, false));
      }, 50);
    }
  }
}

export function setStatusLine(chat) {
  // A local or relayed provider reports Anthropic-derived cost for work it
  // never billed, so "$0.0204" against Ollama was actively misleading. #15
  const metered = !chat.provider || !chat.provider.baseUrl;
  const parts = [chat.model ? 'model: ' + chat.model : 'model: provider default', 'mode: ' + modeLabel(chat.mode)];
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
    const mAuth = auth === 'none'
      ? (keyProvider ? 'provider key' : 'no auth — /login in a terminal tab')
      : auth;
    chat.statusRight.textContent = (chat.init.model || '') + ' · ' + mAuth;
    // The row is only for a problem: model, mode, cost and turns live in the footbar and Overview.
    const row = chat.statusLine.closest('.chat-statusline');
    if (row) row.classList.toggle('has-warn', /no auth/.test(mAuth));
    chat.providerEl.textContent = chat.provider ? basename(chat.provider.name) : 'default env';
  }
}
