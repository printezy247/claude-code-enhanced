// Small process / text helpers shared by the engine chat runners.
'use strict';

/**
 * Stop a child and everything it started: SIGTERM to its process group, then
 * SIGKILL after `graceMs` for a CLI that ignores it. Spawn with detached:true
 * so the child leads its own group. Marks the child so its exit handler can
 * tell a stop from a crash.
 */
function terminate(child, { graceMs = 3000 } = {}) {
  if (!child || child.pid == null) return;
  child.killedByUser = true;
  const send = (signal) => {
    try { process.kill(-child.pid, signal); } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), graceMs).unref();
}

/** Append `chunk` to `buf`, keeping only the last `max` characters. */
const appendTail = (buf, chunk, max = 4000) => (buf + chunk).slice(-max);

/** The last `n` characters of `s`, trimmed, with an ellipsis when cut. */
const tail = (s, n = 600) => { const t = String(s || '').trim(); return t.length > n ? '…' + t.slice(-n) : t; };

/** Cap a long tool output to its head and tail so one `cat` cannot flood the chat. */
function capOutput(s, max = 40_000) {
  const t = String(s == null ? '' : s);
  if (t.length <= max) return t;
  const half = Math.floor(max / 2);
  return t.slice(0, half) + `\n… ${t.length - max} characters left out …\n` + t.slice(-half);
}

/** Flatten message content (a string, or blocks with .text) to plain text. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/**
 * Stand-in for the Agent SDK query object of an engine chat. The panels that
 * ask it for commands, models or agents get an empty answer; `usage()` feeds
 * the context bar. Any other SDK call rejects with a message naming the engine.
 */
function stubQuery(label, { interrupt, usage }) {
  const empty = async () => [];
  const known = {
    interrupt,
    supportedCommands: empty, supportedModels: empty, supportedAgents: empty, mcpServerStatus: empty,
    getContextUsage: async () => usage(),
  };
  return new Proxy(known, {
    get: (target, prop) => (prop in target ? target[prop]
      : (typeof prop === 'string' ? async () => { throw new Error(`${label} chats do not support ${prop}`); } : undefined)),
  });
}

module.exports = { stubQuery, terminate, appendTail, tail, capOutput, textOf };
