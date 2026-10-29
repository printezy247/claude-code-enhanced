// The message queue as plain data. No DOM here: the panel (composer.js) and
// the drain (status.js) call these, and the tests load them directly.

let seq = 0;
const newId = () => 'q' + Date.now().toString(36) + (seq++).toString(36);

export const DEFAULT_RULES = { onError: true, onPermission: true, onSpend: true, onTests: true };

/**
 * One queued message. Old code pushed a bare string or {text, blocks}; both
 * still load.
 * @returns {{id:string,text:string,blocks:Array|null,at:number,mode?:string,model?:string,effort?:string,ask?:boolean,approved?:boolean,runAt?:number,label?:string,chain?:object}}
 */
export function makeItem(input, extra = {}) {
  const base = typeof input === 'string' ? { text: input } : (input || {});
  const blocks = Array.isArray(base.blocks) && base.blocks.length ? base.blocks : null;
  const item = { id: base.id || newId(), text: String(base.text || ''), blocks, at: base.at || Date.now() };
  for (const k of ['mode', 'model', 'effort', 'label', 'chain']) {
    const v = extra[k] !== undefined ? extra[k] : base[k];
    if (v !== undefined && v !== '' && v !== null) item[k] = v;
  }
  for (const k of ['ask', 'approved']) {
    const v = extra[k] !== undefined ? extra[k] : base[k];
    if (v) item[k] = true;
  }
  if (Number(base.imgCount) > 0 && !blocks) item.imgCount = Number(base.imgCount);
  const runAt = extra.runAt !== undefined ? extra.runAt : base.runAt;
  if (Number(runAt) > 0) item.runAt = Number(runAt);
  return item;
}

export function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map((x) => makeItem(x)).filter((x) => x.text || x.blocks);
}

function clampIndex(list, i) { return Number.isInteger(i) && i >= 0 && i < list.length; }

/** Move one item. Returns a new list. */
export function move(list, from, to) {
  if (!clampIndex(list, from)) return list.slice();
  const dest = Math.max(0, Math.min(list.length - 1, to));
  const out = list.slice();
  const [it] = out.splice(from, 1);
  out.splice(dest, 0, it);
  return out;
}

export function runNext(list, i) { return move(list, i, 0); }

export function duplicate(list, i) {
  if (!clampIndex(list, i)) return list.slice();
  const out = list.slice();
  out.splice(i + 1, 0, makeItem({ ...list[i], id: undefined, at: undefined }));
  return out;
}

export function remove(list, i) { return clampIndex(list, i) ? list.filter((_, k) => k !== i) : list.slice(); }

export function edit(list, i, text) {
  if (!clampIndex(list, i)) return list.slice();
  const t = String(text || '').trim();
  if (!t && !list[i].blocks) return remove(list, i);
  return list.map((x, k) => (k === i ? { ...x, text: t } : x));
}

/**
 * What the drain does next.
 * @param {Array} list
 * @param {{now?:number, paused?:boolean, lastTurnError?:boolean, permWaiting?:boolean, spendWarn?:boolean, rules?:object}} state
 * @returns {{run:object}|{hold:string, wakeAt?:number}|null}  null: nothing queued
 */
export function nextAction(list, state = {}) {
  if (!list.length) return null;
  const rules = { ...DEFAULT_RULES, ...(state.rules || {}) };
  const now = state.now || Date.now();
  if (state.paused) return { hold: 'paused' };
  if (rules.onError && state.lastTurnError) return { hold: 'error' };
  if (rules.onPermission && state.permWaiting) return { hold: 'permission' };
  if (rules.onSpend && state.spendWarn) return { hold: 'spend' };
  if (rules.onTests && state.testsFailed) return { hold: 'tests' };
  const head = list[0];
  if (head.ask && !head.approved) return { hold: 'ask' };
  if (head.runAt && head.runAt > now) return { hold: 'scheduled', wakeAt: head.runAt };
  return { run: head };
}

export const HOLD_TEXT = {
  paused: 'Queue paused',
  error: 'Queue paused: the last turn ended with an error',
  permission: 'Queue paused: a permission prompt is waiting',
  spend: 'Queue paused: the spend ceiling was reached',
  tests: 'Queue paused: a test run failed in the last turn',
  ask: 'Next item waits for your OK',
  scheduled: 'Next item is scheduled',
};

const TEST_CMD = /(^|[\s;&|(])(npm\s+(run\s+)?test|npm\s+t|pnpm\s+(run\s+)?test|yarn\s+test|npx\s+(vitest|jest|playwright|mocha)|vitest|jest|pytest|py\.test|mocha|tox|rspec|phpunit|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|ctest|make\s+(test|check)|deno\s+test|bun\s+test|ava)(\s|$)/;

/** True when a shell command is a test run (a failing one pauses the queue). */
export function isTestCommand(command) {
  return TEST_CMD.test(String(command || ''));
}

/** Set (or clear, with '') the model and reasoning effort of one queued item. */
export function setOverrides(list, i, { model, effort } = {}) {
  if (!clampIndex(list, i)) return list.slice();
  return list.map((x, k) => {
    if (k !== i) return x;
    const y = { ...x };
    for (const [key, v] of [['model', model], ['effort', effort]]) {
      if (v === undefined) continue;
      if (v) y[key] = String(v); else delete y[key];
    }
    return y;
  });
}

/** Text-only form for localStorage. Images go through draft:images under imageKey(). */
export function serialize(list) {
  return list.map((x) => {
    const o = { ...x, blocks: undefined, imgCount: x.blocks ? x.blocks.length : 0 };
    delete o.blocks;
    return o;
  });
}

export function imageKey(cwd, id) { return 'queue:' + (cwd || '') + ':' + id; }

/** Read a saved list back. Old saves were arrays of strings. */
export function deserialize(raw) {
  let v;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  return (Array.isArray(v) ? v : []).map((x) => (typeof x === 'string' ? makeItem(x) : makeItem(x))).filter((x) => x.text || x.imgCount);
}

/** Images of a queued item as chips ("2 images"). */
export function summary(item) {
  const bits = [];
  const n = item.blocks ? item.blocks.length : (item.imgCount || 0);
  if (n) bits.push(n + (n === 1 ? ' image' : ' images'));
  if (item.mode) bits.push(item.mode);
  if (item.model) bits.push(item.model);
  if (item.effort) bits.push('effort ' + item.effort);
  if (item.ask) bits.push('asks first');
  if (item.runAt) bits.push('at ' + new Date(item.runAt).toTimeString().slice(0, 5));
  return bits;
}
