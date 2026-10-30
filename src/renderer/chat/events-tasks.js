// Split from events.js (Phase 3.7): background tasks and the hook audit. Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { scrollDownSoft } from './transcript.js';
import { el, esc } from './util.js';

/* ---------------- background tasks ---------------- */

export function onTaskEvent(chat, msg) {
  // Bound the live task map so a long session cannot grow it forever.
  if (chat.bgTasks && chat.bgTasks.size > 50) {
    const oldest = chat.bgTasks.keys().next().value;
    chat.bgTasks.delete(oldest);
  }
  // background_tasks_changed is a LEVEL, not an edge: every payload is the
  // complete set of live tasks. Pairing task_started/task_notification edges
  // instead meant one dropped frame left a task card spinning forever — this
  // replaces the set wholesale, so the indicator cannot wedge. #48
  if (msg.subtype === 'background_tasks_changed') {
    const live = new Set();
    for (const t of (msg.tasks || [])) {
      live.add(t.task_id);
      let row = chat.bgTasks.get(t.task_id);
      if (!row) {
        row = bgTaskRow(chat, t.task_id, t);
        chat.bgTasks.set(t.task_id, row);
      }
      row.label = t.description || row.label;
      bgTaskPaint(row, t);
      if (t.subagent_type && !row.chipText) {
        const chip = row.node.querySelector('.chip');
        if (chip) { chip.textContent = t.subagent_type; row.chipText = t.subagent_type; }
      }
    }
    // Anything no longer in the level has ended.
    for (const [tid, row] of chat.bgTasks) {
      if (!live.has(tid)) {
        row.dot.className = 'tool-dot done';
        row.title.textContent = '✓ ' + row.label;
        row.stop?.remove();
        chat.bgTasks.delete(tid);
      }
    }
    return;
  }
  if (msg.subtype === 'task_notification') {
    const t = chat.bgTasks.get(msg.task_id);
    if (t) {
      const good = msg.status === 'completed';
      t.dot.className = 'tool-dot ' + (good ? 'done' : 'err');
      t.title.textContent = (good ? '✓ ' : '✗ ') + t.label;
      t.stop?.remove();
      if (msg.summary) t.title.title = String(msg.summary).slice(0, 600);
    } else {
      chat.msgs.appendChild(el('div', 'sys-note',
        (msg.status === 'completed' ? '✓ background task done' : '✗ background task ' + msg.status)
        + (msg.summary ? ' — ' + String(msg.summary).slice(0, 140) : '')));
      scrollDownSoft(chat);
    }
    chat.bgTasks.delete(msg.task_id);
    return;
  }
  let t = chat.bgTasks.get(msg.task_id);
  if (!t) {
    t = bgTaskRow(chat, msg.task_id, msg);
    scrollDownSoft(chat);
  }
  t.label = msg.description || t.label;
  bgTaskPaint(t, msg);
  if (msg.subtype === 'task_started' && !msg.is_backgrounded) t.stop.remove();  // foreground task: turn blocks on it anyway
}

/** One background-task card. Shared by the edge events and the level payload. */
function bgTaskRow(chat, taskId, info) {
  const node = el('div', 'tool-card kind-agent bg-task');
  const head = el('div', 'tool-head');
  const dot = el('span', 'tool-dot running');
  const ico = elIcon('span', 'tool-ico', CCEIcons.svg('bot', 15));
  const title = el('span', 'tool-title mono', '');
  const chip = el('span', 'chip', info.subagent_type || 'task');
  head.appendChild(dot); head.appendChild(ico); head.appendChild(title); head.appendChild(chip);
  const stop = elIcon('button', 'btn small', CCEIcons.svg('stop', 12) + ' stop');
  stop.title = 'Stop this background task';
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    const rr = await ccx.invoke('chat:stopTask', { id: chat.id, taskId });
    if (!rr.ok) { toast(rr.error, 'err'); stop.disabled = false; }
  });
  head.appendChild(stop);
  node.appendChild(head);
  chat.msgs.appendChild(node);
  const row = { node, dot, title, stop, label: info.description || 'background task', chipText: '' };
  chat.bgTasks.set(taskId, row);
  return row;
}

/** Paint a task card from either a task_* event or a background_tasks_changed entry. */
function bgTaskPaint(row, info) {
  const usage = info.usage ? ' · ' + Math.round((info.usage.total_tokens || 0) / 1000) + 'k tok' : '';
  row.title.innerHTML = CCEIcons.svg('clock', 13) + ' ' + esc(row.label
    + (info.last_tool_name ? ' — ' + info.last_tool_name : '')
    + (info.status ? ' · ' + info.status : '') + usage);
  if (info.summary) row.title.title = String(info.summary).slice(0, 600);
}

/* ---------------- hooks (live audit) ---------------- */

export function onHookEvent(chat, msg) {
  if (msg.subtype === 'hook_started') {
    chat.hooks.push({
      id: msg.hook_id, at: Date.now(), event: msg.hook_event,
      name: msg.hook_name, outcome: 'running',
    });
    if (chat.hooks.length > 200) chat.hooks.shift();
  } else {
    const prev = chat.hooks.find(h => h.id === msg.hook_id);
    const done = {
      event: msg.hook_event, name: msg.hook_name, outcome: msg.outcome || '',
      exit: msg.exit_code, err: msg.stderr ? String(msg.stderr).slice(0, 200) : '',
      at: Date.now(),
    };
    if (prev) Object.assign(prev, done);
    else { chat.hooks.push({ id: msg.hook_id, ...done }); if (chat.hooks.length > 200) chat.hooks.shift(); }
  }
  renderHooks(chat);
}

export function renderHooks(chat) {
  const list = chat.hooksHost && chat.hooksHost.isConnected ? chat.hooksHost.__list : null;
  if (!list) return;
  list.innerHTML = '';
  if (!chat.hooks.length) { list.appendChild(el('div', 'hint', 'none yet')); return; }
  for (const h of [...chat.hooks].reverse().slice(0, 40)) {
    const row = el('div', 'skill-row');
    row.appendChild(el('code', '', h.event || '?'));
    row.appendChild(el('span', 'skill-desc', (h.name || '') + (h.exit != null ? ' → exit ' + h.exit : '')));
    const ok = h.outcome === 'running' ? '' : (h.outcome === 'success' ? 'mcp-ok' : 'mcp-err');
    row.appendChild(el('span', 'chip ' + ok, h.outcome || ''));
    if (h.err) row.appendChild(el('span', 'skill-desc', h.err));
    list.appendChild(row);
  }
}
