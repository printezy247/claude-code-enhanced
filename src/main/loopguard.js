'use strict';

/**
 * Spots an agent stuck in a loop. A loop is work that produces nothing new:
 *  - the same tool call again with the same result,
 *  - the same error again and again (even from different calls),
 *  - a run of no-op "status echo" shell calls.
 * Anything that changes a file (Write/Edit, or a shell `>`, `sed -i`, `tee`,
 * `mv`) is progress and clears the slate, so test, edit, test is a fix cycle.
 * Polling tools are waiting, not looping, and are never counted: task output,
 * connector status checks, and shell commands that start with `sleep`.
 *
 * Each scope (the main agent, and each subagent) keeps its own history.
 * The first trip in a scope is a redirect (the caller denies the call with a
 * corrective message); a second trip with no progress in between is a stop.
 */
const crypto = require('crypto');
const { textOf } = require('./procutil');

const NOOP_BASH = /^\s*(echo|printf|true|:|cat\s*<<)/;

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Reading a task's output again is waiting for it, not repeating oneself.
const POLL_TOOLS = new Set(['TaskOutput', 'BashOutput', 'TaskGet', 'TaskList', 'TodoWrite', 'ToolSearch']);

// A shell command that starts by sleeping is waiting for something (CI, a
// deploy, a server), and so is everything after a sleep: the same check again
// after a wait is a poll, not a repeat.
const WAIT_BASH = /^\s*sleep\s+\d/;

// Connector tools (or their `method`) that report on something still running.
const POLL_WORDS = /(?:^|_)(?:status|check_runs|checks|poll|wait|progress)(?:$|_)/i;

function isPollCall(block) {
  if (POLL_TOOLS.has(block.name)) return true;
  if (block.name === 'Bash') return WAIT_BASH.test(String((block.input && block.input.command) || ''));
  const m = /^mcp__.+?__(.+)$/.exec(String(block.name));
  if (!m) return false;
  const method = block.input && typeof block.input.method === 'string' ? block.input.method : '';
  return POLL_WORDS.test(m[1]) || (!!method && POLL_WORDS.test(method));
}

// A shell command that changes files: a redirect to a file (not 2>&1 or
// /dev/null), tee, sed -i, mv/cp/patch/truncate, or a git command that edits.
const SHELL_EDIT = /(?:^|[^<>&\d])>>?\s*(?!&|\/dev\/null\b)[^\s>]|\btee\b|\bsed\b[^|;&]*\s(?:-[A-Za-z]*i|--in-place)|\b(?:mv|cp|patch|truncate)\s|\bgit\s+(?:apply|checkout|restore|stash|commit|add|reset|rm|mv)\b/;

const MAX_TRACKED = 500;

function signature(block) {
  const input = block && block.input ? block.input : {};
  let text;
  try { text = JSON.stringify(input); } catch { text = ''; }
  return String(block.name) + ':' + text.slice(0, 300);
}

function hashOf(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(t.slice(0, 4000) + '|' + t.length).digest('hex').slice(0, 12);
}

function isShellEdit(block) {
  return block.name === 'Bash' && block.input && SHELL_EDIT.test(String(block.input.command || ''));
}

function createLoopGuard({ window = 24, repeat = 3, noopRun = 5, errorRepeat = 3 } = {}) {
  const scopes = new Map();   // scope key -> history
  const calls = new Map();    // tool_use id -> { state, entry, progress, trip }

  function scopeOf(key) {
    const k = key || '';
    let s = scopes.get(k);
    if (!s) {
      s = { recent: [], noops: 0, strikes: 0, errHash: '', errStreak: 0, armed: null, edits: new Map(), shellEdits: new Map(), waits: 0 };
      scopes.set(k, s);
    }
    return s;
  }

  function trip(s, reason) {
    s.strikes += 1;
    s.recent = []; s.noops = 0; s.errHash = ''; s.errStreak = 0; s.armed = null; s.edits.clear(); s.shellEdits.clear();
    return { tripped: true, reason, strike: s.strikes };
  }

  function decide(block, s) {
    const none = { trip: { tripped: false } };
    if (isPollCall(block)) {
      if (block.name === 'Bash') s.waits += 1;
      return none;
    }
    // Three identical errors in a row: whatever comes next is stopped, an edit included.
    if (s.armed) return { trip: trip(s, s.armed), tracked: true };
    if (WRITE_TOOLS.has(block.name)) {
      // An edit is progress, unless it is the very same edit again: edit, test,
      // the same edit, the same failing test is a loop, not a fix cycle.
      let text;
      try { text = JSON.stringify(block.input || {}); } catch { text = ''; }
      const key = block.name + ':' + hashOf(text);
      const seen = (s.edits.get(key) || 0) + 1;
      if (s.edits.size >= 200) s.edits.delete(s.edits.keys().next().value);
      s.edits.set(key, seen);
      if (seen >= repeat) return { trip: trip(s, 'the same ' + block.name + ' edit ' + seen + ' times'), tracked: true };
      s.recent = []; s.noops = 0; s.shellEdits.clear();
      return { trip: { tripped: false }, progress: true, tracked: true };
    }
    if (isShellEdit(block)) {
      // The same shell edit again with no file edit in between changes nothing.
      const key = hashOf(String(block.input.command || ''));
      const seen = (s.shellEdits.get(key) || 0) + 1;
      if (s.shellEdits.size >= 200) s.shellEdits.delete(s.shellEdits.keys().next().value);
      s.shellEdits.set(key, seen);
      if (seen >= repeat) return { trip: trip(s, 'the same shell edit ' + seen + ' times with no file change'), tracked: true };
      s.recent = []; s.noops = 0;
      return { trip: { tripped: false }, progress: true, tracked: true };
    }
    const sig = signature(block);
    const entry = { sig, hash: undefined, wait: s.waits };
    // Calls only count as repeats while they keep getting the same result, and
    // only since the last wait: check, sleep, check is polling.
    const prior = s.recent.filter((e) => e.sig === sig && e.wait === s.waits);
    let ref;
    for (let i = prior.length - 1; i >= 0; i--) if (prior[i].hash !== undefined) { ref = prior[i].hash; break; }
    const same = prior.filter((e) => e.hash === undefined || e.hash === ref).length;
    s.recent.push(entry);
    if (s.recent.length > window) s.recent.shift();
    const cmd = block.name === 'Bash' && block.input ? String(block.input.command || '') : '';
    s.noops = block.name === 'Bash' && NOOP_BASH.test(cmd) ? s.noops + 1 : 0;
    if (same + 1 >= repeat) {
      return { trip: trip(s, 'the same ' + block.name + ' call ' + (same + 1) + ' times with no new result'), tracked: true };
    }
    if (s.noops >= noopRun) {
      return { trip: trip(s, noopRun + ' shell calls in a row that only print text'), tracked: true };
    }
    return { trip: { tripped: false }, entry, tracked: true };
  }

  return {
    /**
     * Record a tool call. Safe to call twice for one id (returns the first verdict).
     * @param {{id?: string, name: string, input?: object}} block
     * @param {string} [scopeKey] '' for the main agent, the parent tool id for a subagent
     * @returns {{tripped: boolean, reason?: string, strike?: number}}
     */
    record(block, scopeKey) {
      if (!block || !block.name) return { tripped: false };
      if (block.id && calls.has(block.id)) {
        const seen = calls.get(block.id);
        // The cached verdict is for one occurrence of that id. Once its result
        // has been fed back the call is finished, so seeing the id again means
        // the upstream REUSED it (some proxies and local servers emit call_1 /
        // toolu_0 every time) — that is a new call and must be judged, or a
        // single repeated id would hide the loop forever.
        if (!seen.done) return seen.trip;
      }
      const s = scopeOf(scopeKey);
      const d = decide(block, s);
      if (block.id) {
        if (calls.size >= MAX_TRACKED) calls.delete(calls.keys().next().value);
        calls.set(block.id, { state: s, entry: d.entry, progress: !!d.progress, tracked: !!d.tracked, trip: d.trip });
      }
      return d.trip;
    },

    /** Feed back what the call returned, so repeats are judged by result. */
    result(id, content, isError) {
      const rec = id && calls.get(id);
      if (!rec) return;
      rec.done = true;
      const text = textOf(content);
      const h = hashOf(text);
      if (rec.entry) rec.entry.hash = h;
      // Errors that differ only in numbers (pids, times, line counts) are the same error.
      const eh = hashOf(text.replace(/\d+/g, '#'));
      if (!rec.tracked) return;
      const s = rec.state;
      if (isError || /^\s*ERROR:/.test(text)) {
        if (eh === s.errHash) s.errStreak += 1; else { s.errHash = eh; s.errStreak = 1; }
        if (s.errStreak >= errorRepeat) {
          s.armed = 'the same error ' + s.errStreak + ' times (' + text.trim().replace(/\s+/g, ' ').slice(0, 80) + ')';
        }
      } else {
        s.errHash = ''; s.errStreak = 0; s.armed = null;
        if (rec.progress) s.strikes = 0;
      }
    },

    /** Has this call been seen yet? */
    known(id) { return calls.has(id); },

    /** The reason a call must be denied (first trip only), or '' when it may run. */
    denial(id) {
      const rec = calls.get(id);
      return rec && rec.trip.tripped && rec.trip.strike === 1 ? rec.trip.reason : '';
    },

    reset() { scopes.clear(); calls.clear(); },
  };
}

/** Does this call change a file (a write tool, or a shell redirect / tee / sed -i)? */
function isEditCall(block) {
  return !!block && (WRITE_TOOLS.has(block.name) || isShellEdit(block));
}

/**
 * A hard stop for modes that never ask: N tool calls in a row without a file
 * change ends the turn. limit 0 turns it off. note() returns true once over.
 */
function createBudget(limit) {
  let count = 0;
  return {
    note(block) {
      // Only the engine's own polling is free here: a yolo turn that sleeps
      // and checks forever must still hit the budget.
      if (!limit || !block || POLL_TOOLS.has(block.name)) return false;
      if (isEditCall(block)) { count = 0; return false; }
      count += 1;
      return count >= limit;
    },
    reset() { count = 0; },
  };
}

module.exports = { createLoopGuard, isEditCall, createBudget };
