// Monthly spend per project folder, with a warning at 80% and again at 100%.
// The ledger and the limits live in localStorage; nothing leaves the machine.
const LEDGER = 'cce:spend';
const LIMITS = 'cce:budgets';
export const WARN_AT = 0.8;

export const monthKey = (now) => new Date(now).toISOString().slice(0, 7);

/** Add a cost to a folder's month. A new month starts a clean ledger. */
export function addSpend(ledger, cwd, usd, now) {
  const month = monthKey(now);
  const cur = ledger && ledger.month === month ? ledger : { month, byCwd: {}, alerted: {} };
  const add = Number(usd);
  if (cwd && Number.isFinite(add) && add > 0) cur.byCwd[cwd] = (cur.byCwd[cwd] || 0) + add;
  return cur;
}

/** Where a folder stands against its limit: ok, warn (80%+) or over. */
export function standing(ledger, limits, cwd, now) {
  const month = ledger && ledger.month === monthKey(now) ? ledger : null;
  const spent = (month && month.byCwd[cwd]) || 0;
  const limit = Number(limits && limits[cwd]) || 0;
  if (!limit) return { spent, limit: 0, pct: 0, level: 'none' };
  const pct = spent / limit;
  return { spent, limit, pct, level: pct >= 1 ? 'over' : pct >= WARN_AT ? 'warn' : 'ok' };
}

/** The alert to show now, once per level per folder per month; marks it as shown. */
export function nextAlert(ledger, limits, cwd, now) {
  const st = standing(ledger, limits, cwd, now);
  if (st.level !== 'warn' && st.level !== 'over') return null;
  const seen = (ledger.alerted ||= {});
  const rank = { warn: 1, over: 2 };
  if ((seen[cwd] || 0) >= rank[st.level]) return null;
  seen[cwd] = rank[st.level];
  return st;
}

export function load(store) {
  const read = (k, d) => { try { return JSON.parse(store.getItem(k)) || d; } catch { return d; } };
  return { ledger: read(LEDGER, null), limits: read(LIMITS, {}) };
}
export function saveLedger(store, ledger) { try { store.setItem(LEDGER, JSON.stringify(ledger)); } catch { /* full or blocked */ } }
export function saveLimits(store, limits) { try { store.setItem(LIMITS, JSON.stringify(limits)); } catch { /* full or blocked */ } }

/** Record one finished turn's cost for a folder; returns an alert message or null. */
export function recordTurn(store, cwd, usd, now = Date.now()) {
  const { ledger, limits } = load(store);
  const next = addSpend(ledger, cwd, usd, now);
  const alert = nextAlert(next, limits, cwd, now);
  saveLedger(store, next);
  if (!alert) return null;
  const name = String(cwd).split('/').filter(Boolean).pop() || cwd;
  const pct = Math.round(alert.pct * 100);
  return alert.level === 'over'
    ? name + ' passed its monthly budget: $' + alert.spent.toFixed(2) + ' of $' + alert.limit.toFixed(2)
    : name + ' is at ' + pct + '% of its monthly budget ($' + alert.spent.toFixed(2) + ' of $' + alert.limit.toFixed(2) + ')';
}
