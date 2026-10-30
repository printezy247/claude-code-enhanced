// Scheduled prompts. They run while CCE is open, each in a read-only side
// session, so nothing can be approved unattended. Plain data in localStorage.
export const MAX_HISTORY = 5;
export const MIN_MINUTES = 5;
const KEY = 'schedule:tasks';

/** "every 30m" | "every 2h" | "hourly" | "daily 09:00" -> { every: minutes } | { daily: minuteOfDay } | null */
export function parseWhen(text) {
  const s = String(text || '').trim().toLowerCase();
  if (s === 'hourly') return { every: 60 };
  let m = s.match(/^every (\d{1,4})\s*(m|h)$/);
  if (m) {
    const mins = Number(m[1]) * (m[2] === 'h' ? 60 : 1);
    return mins >= MIN_MINUTES && mins <= 168 * 60 ? { every: mins } : null;
  }
  m = s.match(/^daily (\d{1,2}):(\d{2})$/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { daily: Number(m[1]) * 60 + Number(m[2]) };
  return null;
}

/** When the task is next due, in ms. Counts from the last run, or from when it was made. */
export function nextRun(spec, lastRun, createdAt) {
  const base = lastRun || createdAt || 0;
  if (spec.every) return base + spec.every * 60_000;
  const d = new Date(base);
  d.setHours(Math.floor(spec.daily / 60), spec.daily % 60, 0, 0);
  if (d.getTime() <= base) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Enabled tasks whose time has come. A long absence still means one run, not one per missed slot. */
export function dueTasks(tasks, now) {
  return (tasks || []).filter((t) => {
    if (!t || !t.enabled) return false;
    const spec = parseWhen(t.when);
    return !!spec && nextRun(spec, t.lastRun, t.createdAt) <= now;
  });
}

export function recordRun(task, result, now) {
  const entry = { at: now, ok: !!result.ok, text: String(result.text || '').slice(0, 2000) };
  return { ...task, lastRun: now, history: [entry, ...(task.history || [])].slice(0, MAX_HISTORY) };
}

export function loadTasks() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveTasks(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

let nextId = 0;
export function newTask({ name, prompt, cwd, when }, now = Date.now()) {
  return { id: 's' + now.toString(36) + (nextId++).toString(36), name: String(name || '').trim().slice(0, 60) || 'Task', prompt: String(prompt || '').trim().slice(0, 2000), cwd: String(cwd || ''), when: String(when || '').trim(), enabled: true, createdAt: now, lastRun: 0, history: [] };
}
