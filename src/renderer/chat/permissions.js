// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { uiMode } from '../app/modes.js';
import { publishTabState } from './session.js';
import { setBusy } from './status.js';
import { toolIcon } from './tools.js';
import { scrollDownSoft } from './transcript.js';
import { el, esc, fmtDur, md, modeLabel } from './util.js';

// Live countdown per card. An unanswered request auto-denies, so say so
// instead of letting the card sit until the engine gives up. One interval per
// card: a shared timer cancelled whichever card was answered. #2
function startPermCountdown(chat, card, head, evt) {
  if (!evt.expiresAt) return;
  const cd = el('span', 'perm-countdown', '');
  head.appendChild(cd);
  const timer = setInterval(() => {
    const left = evt.expiresAt - Date.now();
    if (left <= 0) {
      clearInterval(timer);
      card.remove();
      chat.permCount = Math.max(0, (chat.permCount || 1) - 1);
      updatePermBadge(chat);
      toast('Permission request timed out — auto-denied', 'err');
      return;
    }
    cd.textContent = '⏳ auto-deny in ' + fmtDur(left);
  }, 1000);
  timer.unref && timer.unref();
  card.dataset.timer = '1';
  card._permTimer = timer;
  cd.textContent = '⏳ auto-deny in ' + fmtDur(Math.max(0, evt.expiresAt - Date.now()));
}

/** Stop a card's countdown. Takes the card, not the chat. */
export function endPermCountdown(card) {
  if (card && card._permTimer) {
    clearInterval(card._permTimer);
    card._permTimer = null;
  }
}

export function clearPermission(chat, requestId, note) {
  // Remove every card whose id matches (or all, when no id is given).
  const cards = [...chat.permSlot.querySelectorAll('.perm-card')];
  let removed = 0;
  for (const card of cards) {
    if (requestId && card.dataset.rid !== requestId) continue;
    endPermCountdown(card);
    card.remove();
    removed++;
    chat.permCount = Math.max(0, (chat.permCount || 0) - 1);
  }
  if (removed) updatePermBadge(chat);
  if (note && removed) toast(note, 'err');
}

export function showPermission(chat, evt) {
  // Do NOT clear the slot: several requests can be pending at once (parallel
  // tool calls, subagents) and the old single-card behaviour dropped all but
  // the last, leaving the rest to time out. Each card owns its own timer. #2
  const { requestId, toolName, input = {} } = evt;
  if (toolName === 'AskUserQuestion') return showAskQuestion(chat, evt);
  chat.permCount = (chat.permCount || 0) + 1;
  updatePermBadge(chat);
  const card = el('div', 'perm-card' + (toolName === 'ExitPlanMode' ? ' plan' : ''));
  card.dataset.rid = requestId;
  const head = el('div', 'perm-head');
  head.appendChild(elIcon('span', 'tool-ico', toolIcon(toolName)));

  // Use the engine's own prompt sentence when it sends one; only fall back to
  // reconstructing from the tool name. #28
  const title = evt.title || ('Claude wants to use ' + toolName);
  const t = el('span', '', '');
  t.appendChild(el('b', '', title));
  head.appendChild(t);
  if (chat.permCount > 1) head.appendChild(el('span', 'chip', chat.permCount + ' pending'));
  card.appendChild(head);

  if (toolName === 'ExitPlanMode') {
    const planBody = el('div', 'perm-plan md');
    planBody.innerHTML = md(input.plan || '(no plan text)');
    card.appendChild(planBody);
  } else {
    if (evt.description) card.appendChild(el('div', 'perm-desc', evt.description));
    if (evt.decisionReason) card.appendChild(el('div', 'hint', 'why: ' + evt.decisionReason));
    if (evt.blockedPath) card.appendChild(el('div', 'hint', 'blocked path: ' + evt.blockedPath));
    card.appendChild(renderToolInput(toolName, input));
    if (Array.isArray(evt.suggestions) && evt.suggestions.length) {
      card.appendChild(el('div', 'hint', 'Session rule: ' + describeSuggestions(evt.suggestions)));
    }
  }

  startPermCountdown(chat, card, head, evt);
  const actions = el('div', 'perm-actions');
  const setMode = async (mode) => {
    const r = await ccx.invoke('chat:set-mode', { id: chat.id, mode });
    if (r.ok) {
      chat.autoPolicy = !!r.autoPolicy;
      chat.mode = uiMode(r.permissionMode || mode, chat.provider, chat.autoPolicy, chat.caps && chat.caps.modes);
      chat.modeSel.value = chat.mode;
      toast('Mode → ' + modeLabel(chat.mode, chat.caps && chat.caps.modes), 'ok');
    }
  };
  const finish = () => {
    endPermCountdown(card);   // an answered card must not time out later
    card.remove();
    chat.permCount = Math.max(0, (chat.permCount || 1) - 1);
    updatePermBadge(chat);
  };
  const mk = (label, cls, decision, afterMode, tip) => {
    const b = el('button', 'btn ' + cls, label);
    if (tip) b.title = tip;
    b.addEventListener('click', async () => {
      finish();
      const r = await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision });
      if (!r || !r.ok) { toast((r && r.error) || 'failed to send permission answer', 'err'); setBusy(chat, false); return; }
      if (afterMode) await setMode(afterMode);
      setBusy(chat, true);
    });
    return b;
  };
  if (toolName === 'ExitPlanMode') {
    actions.appendChild(mk('✓ approve + accept edits', 'primary', 'allow', 'acceptEdits'));
    actions.appendChild(mk('✓ approve + auto', '', 'allow', 'auto'));
    // Keep planning, with a way to say why: the deny message reaches the
    // model, so the desktop app's "keep planning" is really feedback. #40
    const feedback = el('input', 'perm-feedback');
    feedback.type = 'text';
    feedback.placeholder = 'Keep planning — what should change? (optional)';
    actions.appendChild(feedback);
    const keep = el('button', 'btn', '✗ keep planning');
    keep.addEventListener('click', async () => {
      const why = feedback.value.trim();
      finish();
      const r = await ccx.invoke('chat:permission-answer', {
        id: chat.id, requestId, decision: 'deny',
        message: why || 'Keep planning. Do not start implementing yet.',
      });
      if (!r || !r.ok) { toast((r && r.error) || 'failed to send permission answer', 'err'); setBusy(chat, false); return; }
      setBusy(chat, true);
    });
    actions.appendChild(keep);
  } else {
    actions.appendChild(mk('Allow once', 'primary', 'allow', null,
      'Approve just this call. Nothing else is remembered.'));
    // Only offer the persistent choice when the engine gave a scoped rule for
    // it; a bare toolName rule would approve every future use. #3
    if (!evt.suppressAlwaysAllowRule && Array.isArray(evt.suggestions) && evt.suggestions.length) {
      actions.appendChild(mk('Allow for this session', '', 'always', null,
        'Adds: ' + describeSuggestions(evt.suggestions)));
    }
    actions.appendChild(mk('Deny', 'danger', 'deny'));
  }
  card.appendChild(actions);
  chat.permSlot.appendChild(card);
  card.scrollIntoView({ block: 'nearest' });
}

/** Human summary of what "always allow" will actually grant. #28 */
function describeSuggestions(suggestions) {
  const parts = [];
  for (const s of suggestions.slice(0, 2)) {
    for (const r of (s.rules || [])) {
      parts.push(r.ruleContent ? r.toolName + ' ' + r.ruleContent : r.toolName);
    }
  }
  return parts.join(' · ') || 'this tool';
}

/** Readable summary of a tool's input instead of a raw JSON dump. #28 */
function renderToolInput(toolName, input) {
  const wrap = el('div', 'perm-tool-input');
  // A connector call carries a URL, and that URL can carry a credential.
  // The card is what the user screenshots, so the secret is masked here.
  // #p5-connector-url
  const shown = (window.CCESecrets && window.CCESecrets.maskToolInput)
    ? window.CCESecrets.maskToolInput(input)
    : input;
  if (toolName === 'Bash' && input.command) {
    // The command is the whole point of the prompt: show it large, not as JSON.
    wrap.appendChild(el('pre', 'perm-command mono', String(input.command).slice(0, 2000)));
    if (input.description) wrap.appendChild(el('div', 'hint', input.description));
  } else if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName) && input.file_path) {
    wrap.appendChild(el('div', 'perm-path mono', String(input.file_path)));
  } else if ((toolName === 'Grep' || toolName === 'Glob') && input.pattern) {
    wrap.appendChild(el('div', 'perm-path mono', String(input.pattern)));
  } else if (toolName === 'WebFetch' && input.url) {
    wrap.appendChild(el('div', 'perm-path mono', String(shown.url || input.url)));
  }
  const det = el('details', 'tool-json');
  det.appendChild(el('summary', '', 'raw input'));
  det.appendChild(el('pre', 'tool-io mono', (JSON.stringify(shown == null ? {} : shown, null, 2) || '{}').slice(0, 1200)));
  wrap.appendChild(det);
  return wrap;
}

function updatePermBadge(chat) {
  const n = chat.permCount || 0;
  chat.permSlot.classList.toggle('has-many', n > 1);
  if (n > 1) {
    chat.permSlot.title = n + ' permission requests pending — each needs its own answer';
  } else {
    chat.permSlot.removeAttribute('title');
  }
  publishTabState(chat);   // a pending prompt is what "waiting on you" means
}

// AskUserQuestion arrives as a permission request, but it is a question, not
// an action: draw real options and send the picked labels back as answers.
// The engine reads them from updatedInput.answers, keyed by question text.
function showAskQuestion(chat, evt) {
  const { requestId, input = {} } = evt;
  // Counted like any other pending card so the badge and "N pending" chip
  // stay truthful while a question is on screen.
  chat.permCount = (chat.permCount || 0) + 1;
  updatePermBadge(chat);
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const answers = {};
  const card = el('div', 'perm-card ask');
  const head = el('div', 'perm-head');
  head.appendChild(elIcon('span', 'tool-ico', toolIcon('AskUserQuestion')));
  const t = el('span', '', '');
  t.innerHTML = '<b>Claude has questions</b> — answer to continue';
  head.appendChild(t);
  card.appendChild(head);

  qs.forEach((q) => {
    const box = el('div', 'ask-q');
    if (q.header) box.appendChild(el('span', 'ask-chip', q.header));
    box.appendChild(el('div', 'ask-text', q.question));
    const opts = Array.isArray(q.options) ? q.options : [];
    if (!opts.length) {
      // free-form question (text/number kind) — no option list
      const inp = el('input', 'ask-input');
      inp.type = q.kind === 'number' ? 'number' : 'text';
      inp.placeholder = q.placeholder || 'Type your answer';
      inp.addEventListener('input', () => {
        const v = inp.value.trim();
        if (v) answers[q.question] = v; else delete answers[q.question];
        sync();
      });
      box.appendChild(inp);
    } else {
      const row = el('div', 'ask-opts');
      opts.forEach((o) => {
        const b = el('button', 'ask-opt');
        b.appendChild(el('b', '', o.label));
        if (o.description) b.appendChild(el('span', '', o.description));
        if (o.preview) {
          const det = el('details', 'ask-preview');
          det.appendChild(el('summary', '', 'preview'));
          det.appendChild(el('pre', '', String(o.preview).slice(0, 1500)));
          det.addEventListener('click', (e) => e.stopPropagation());
          b.appendChild(det);
        }
        b.addEventListener('click', () => {
          if (q.multiSelect) {
            const cur = Array.isArray(answers[q.question]) ? answers[q.question] : [];
            const i = cur.indexOf(o.label);
            if (i >= 0) cur.splice(i, 1); else cur.push(o.label);
            if (cur.length) answers[q.question] = cur; else delete answers[q.question];
            b.classList.toggle('sel', i < 0);
          } else {
            answers[q.question] = o.label;
            row.querySelectorAll('.ask-opt').forEach(x => x.classList.remove('sel'));
            b.classList.add('sel');
          }
          sync();
        });
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    card.appendChild(box);
  });

  const actions = el('div', 'perm-actions');
  const send = el('button', 'btn primary', 'Send answers');
  const skip = el('button', 'btn danger', 'Skip');
  const sync = () => { send.disabled = qs.some(q => answers[q.question] === undefined); };
  const finish = () => {
    endPermCountdown(card);
    card.remove();
    chat.permCount = Math.max(0, (chat.permCount || 1) - 1);
    updatePermBadge(chat);
  };
  card.dataset.rid = requestId;
  startPermCountdown(chat, card, head, evt);
  send.addEventListener('click', async () => {
    finish();
    const r = await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision: 'allow', answers });
    if (!r || !r.ok) { toast((r && r.error) || 'failed to send answers', 'err'); setBusy(chat, false); return; }
    setBusy(chat, true);
  });
  skip.addEventListener('click', async () => {
    finish();
    const r = await ccx.invoke('chat:permission-answer', { id: chat.id, requestId, decision: 'deny' });
    if (!r || !r.ok) { toast((r && r.error) || 'failed to send answers', 'err'); setBusy(chat, false); return; }
    setBusy(chat, true);
  });
  actions.appendChild(send);
  actions.appendChild(skip);
  card.appendChild(actions);
  sync();
  chat.permSlot.appendChild(card);
  card.scrollIntoView({ block: 'nearest' });
}

/* ---------------- MCP elicitation cards (#feat-elicitation) ----------------
   Connectors ask for input mid-call: 'url' mode = open this URL and
   authorize; 'form' mode = structured fields from the server's JSON schema.
   The main process parks the SDK callback until the card is answered. */

// A connector prompt blocks the turn like a permission does, so it counts
// toward the tab's "needs you" state; a background chat used to time out on it
// unnoticed.
export function dropElicCard(chat, card) {
  if (!card.isConnected) return;
  card.remove();
  chat.elicCount = Math.max(0, (chat.elicCount || 1) - 1);
  publishTabState(chat);
}

export function clearElicitation(chat, requestId, note) {
  for (const card of chat.permSlot.querySelectorAll('.elic')) {
    if (card.dataset.rid !== requestId) continue;
    dropElicCard(chat, card);
    if (note) {
      const n = el('div', 'sys-note', note);
      chat.msgs.appendChild(n);
      scrollDownSoft(chat);
    }
    return;
  }
}

export function showElicitation(chat, evt) {
  const card = el('div', 'perm-card elic');
  card.dataset.rid = evt.requestId;
  card.dataset.elid = evt.elicitationId || '';
  const head = el('div', 'perm-head');
  head.appendChild(elIcon('span', 'tool-ico', toolIcon('mcp__connector')));
  const t = el('span', '');
  t.innerHTML = '<b>' + esc(evt.displayName || evt.serverName || 'connector') + '</b> wants to connect';
  head.appendChild(t);
  card.appendChild(head);
  if (evt.message) card.appendChild(el('div', 'elic-msg', evt.message));
  if (evt.description) card.appendChild(el('div', 'hint', evt.description));

  const collect = () => {   // form-mode: read inputs into the accept payload
    const out = {};
    for (const inp of card.querySelectorAll('[data-key]')) {
      const key = inp.dataset.key;
      if (inp.type === 'checkbox') out[key] = inp.checked;
      else if (inp.value !== '') out[key] = inp.type === 'number' ? Number(inp.value) : inp.value;
    }
    return out;
  };

  const answer = async (action) => {
    dropElicCard(chat, card);
    const r = await ccx.invoke('chat:elicit-answer', {
      id: chat.id, requestId: evt.requestId, action,
      content: action === 'accept' ? collect() : undefined,
    }).catch(() => null);
    if (!r || !r.ok) toast((r && r.error) || 'failed to answer connector prompt', 'err');
  };

  if (evt.mode === 'url') {
    // OAuth handshake: open the URL in the real browser; the connector
    // resolves once the user finishes there.
    const row = el('div', 'perm-actions');
    const open = el('button', 'btn primary', 'Open authorization page');
    open.addEventListener('click', () => ccx.invoke('shell:openExternal', { url: evt.url }));
    if (evt.url) open.title = evt.url;
    const done = el('button', 'btn', 'I have authorized');
    done.addEventListener('click', () => answer('accept'));
    const no = el('button', 'btn danger', 'Decline');
    no.addEventListener('click', () => answer('decline'));
    const cancel = el('button', 'btn ghost', 'Cancel');
    cancel.addEventListener('click', () => answer('cancel'));
    row.appendChild(open); row.appendChild(done); row.appendChild(no); row.appendChild(cancel);
    card.appendChild(row);
    if (evt.url) {
      const u = el('div', 'elic-url mono', evt.url.slice(0, 160));
      u.title = evt.url;
      card.appendChild(u);
    }
  } else {
    // form mode: render the requestedSchema (MCP input schema: object with
    // typed properties) as inputs; only primitive fields are supported.
    const props = (evt.requestedSchema && evt.requestedSchema.properties) || {};
    const required = new Set(Array.isArray(evt.requestedSchema && evt.requestedSchema.required) ? evt.requestedSchema.required : []);
    const fill = el('div', 'elic-form');
    for (const key of Object.keys(props)) {
      const spec = props[key] || {};
      const lab = el('label', 'elic-field');
      lab.appendChild(el('span', 'elic-key', (spec.title || key) + (required.has(key) ? ' *' : '')));
      let inp;
      if (Array.isArray(spec.enum) && spec.enum.length) {
        inp = document.createElement('select');
        inp.appendChild(el('option', '', ''));
        for (const e of spec.enum) { const o = el('option', '', String(e)); o.value = String(e); inp.appendChild(o); }
      } else if (spec.type === 'boolean') {
        inp = el('input'); inp.type = 'checkbox';
      } else if (spec.type === 'number' || spec.type === 'integer') {
        inp = el('input'); inp.type = 'number';
      } else {
        inp = el('input'); inp.type = 'text';
      }
      if (spec.description) inp.placeholder = String(spec.description).slice(0, 80);
      inp.dataset.key = key;
      lab.appendChild(inp);
      fill.appendChild(lab);
    }
    card.appendChild(fill);
    const row = el('div', 'perm-actions');
    const send = el('button', 'btn primary', 'Submit');
    send.disabled = [...card.querySelectorAll('[data-key]')].some(i =>
      required.has(i.dataset.key) && i.type !== 'checkbox' && !i.value);
    send.addEventListener('click', () => answer('accept'));
    const no = el('button', 'btn danger', 'Decline');
    no.addEventListener('click', () => answer('decline'));
    const cancel = el('button', 'btn ghost', 'Cancel');
    cancel.addEventListener('click', () => answer('cancel'));
    row.appendChild(send); row.appendChild(no); row.appendChild(cancel);
    card.appendChild(row);
    fill.addEventListener('input', () => {
      send.disabled = [...fill.querySelectorAll('[data-key]')].some(i =>
        required.has(i.dataset.key) && i.type !== 'checkbox' && !i.value);
    });
  }
  chat.permSlot.appendChild(card);
  chat.elicCount = (chat.elicCount || 0) + 1;
  publishTabState(chat);
  card.scrollIntoView({ block: 'nearest' });
}
