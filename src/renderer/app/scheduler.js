// Scheduled prompts: the list on the Board and the timer that runs due tasks.
// Each run is a read-only side session, so no step can need an approval nobody is there to give.
import { $, el, state, toast } from './core.js';
import { runSide } from '../chat/btw.js';
import { dueTasks, loadTasks, newTask, parseWhen, recordRun, saveTasks } from '../chat/schedule.js';

const running = new Set();
let wired = false;

function activeFolder() {
  const meta = window.__tabs && window.__tabs.get(state.activeId);
  return (meta && meta.cwd) || (state.settings && state.settings.defaultCwd) || '';
}

export async function runTask(id) {
  if (running.has(id)) return;
  const task = loadTasks().find((t) => t.id === id);
  if (!task) return;
  running.add(id);
  renderSchedule();
  const r = await runSide({ cwd: task.cwd, question: task.prompt });
  running.delete(id);
  const list = loadTasks();
  const i = list.findIndex((t) => t.id === id);
  if (i >= 0) { list[i] = recordRun(list[i], r, Date.now()); saveTasks(list); }
  renderSchedule();
}

export function renderSchedule() {
  const host = $('#sched-list');
  if (!host) return;
  if (!wired) {
    wired = true;
    $('#sched-add')?.addEventListener('click', () => {
      const when = $('#sched-when').value;
      const prompt = $('#sched-prompt').value;
      if (!prompt.trim()) return toast('Write the prompt to run', 'err');
      if (!parseWhen(when)) return toast('When: "every 30m" (5 minutes or more), "hourly" or "daily 09:00"', 'err');
      saveTasks(loadTasks().concat(newTask({ name: $('#sched-name').value, prompt, cwd: activeFolder(), when })));
      $('#sched-name').value = ''; $('#sched-prompt').value = ''; $('#sched-when').value = '';
      renderSchedule();
    });
  }
  host.textContent = '';
  const tasks = loadTasks();
  if (!tasks.length) host.appendChild(el('div', 'meta', 'Nothing scheduled. Prompts run while CCE is open, read-only, in the folder that was open when you added them.'));
  for (const t of tasks) {
    const row = el('div', 'card sched-row');
    const head = el('h4');
    head.appendChild(el('span', '', t.name));
    head.appendChild(el('span', 'chip ' + (running.has(t.id) ? 'mcp-ok' : t.enabled ? 'mcp-off' : 'mcp-warn'), running.has(t.id) ? 'running' : t.enabled ? t.when : 'off'));
    row.appendChild(head);
    row.appendChild(el('div', 'meta', (t.cwd || '') + ' · ' + t.prompt.slice(0, 120)));
    const last = (t.history || [])[0];
    if (last) row.appendChild(el('div', last.ok ? 'sched-last' : 'sched-last btw-err', new Date(last.at).toLocaleString() + ' — ' + last.text.slice(0, 400)));
    const run = el('button', 'btn small sched-run', 'Run now');
    run.disabled = running.has(t.id);
    run.addEventListener('click', () => runTask(t.id));
    const tog = el('button', 'btn small sched-toggle', t.enabled ? 'Turn off' : 'Turn on');
    tog.addEventListener('click', () => { saveTasks(loadTasks().map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x))); renderSchedule(); });
    const del = el('button', 'btn small danger sched-del', 'Delete');
    del.addEventListener('click', () => { saveTasks(loadTasks().filter((x) => x.id !== t.id)); renderSchedule(); });
    row.appendChild(run); row.appendChild(tog); row.appendChild(del);
    host.appendChild(row);
  }
}

/** Check for due tasks every 30 s while the window is open. */
export function startScheduler() {
  setInterval(() => {
    for (const t of dueTasks(loadTasks(), Date.now())) runTask(t.id);
  }, 30_000);
}
