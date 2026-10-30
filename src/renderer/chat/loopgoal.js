// /loop n <prompt>: run a prompt n more times, one turn after another.
// /goal <text>: keep a stated goal in view until cleared. Pure helpers; the
// slash handler and the turn-end hook place the results.
export const MAX_LOOPS = 20;

export function parseLoop(text) {
  const m = String(text || '').match(/^\/loop(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
  const n = m && m[1] !== undefined ? Number(m[1]) : NaN;
  const prompt = m && m[2] ? m[2].trim() : '';
  if (!Number.isInteger(n) || n < 1) return { error: 'Use /loop <times> <prompt>, for example /loop 3 run the tests' };
  if (!prompt) return { error: 'Add a prompt after the number: /loop ' + n + ' <prompt>' };
  return { n: Math.min(n, MAX_LOOPS), prompt };
}

export function parseGoal(text) {
  const arg = String(text || '').replace(/^\/goal\s*/, '').trim();
  if (!arg) return { show: true };
  if (/^(clear|off|none)$/i.test(arg)) return { clear: true };
  return { goal: arg.slice(0, 300) };
}

/** After a turn: the prompt to send next, or null. A stop or an error ends the loop. */
export function loopAfterTurn(chat, { stopped = false, error = false } = {}) {
  const lp = chat && chat.loop;
  if (!lp) return null;
  if (stopped || error || lp.left < 1) { chat.loop = null; return null; }
  lp.left -= 1;
  const prompt = lp.prompt;
  if (lp.left < 1) chat.loop = null;
  return prompt;
}

const goalKey = (cwd) => 'goal:' + (cwd || '');

/** The goal saved for this folder ('' when none); survives a restart. */
export function loadGoal(cwd) {
  try { return JSON.parse(localStorage.getItem(goalKey(cwd)) || '""'); } catch { return ''; }
}

/** Save, or clear with '', the goal for this folder. */
export function saveGoal(cwd, goal) {
  try { if (goal) localStorage.setItem(goalKey(cwd), JSON.stringify(goal)); else localStorage.removeItem(goalKey(cwd)); } catch { /* private mode */ }
}
