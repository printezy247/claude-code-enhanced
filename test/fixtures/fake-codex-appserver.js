#!/usr/bin/env node
// Stand-in for `codex app-server` in CI (no Codex there). Speaks the same
// newline-delimited JSON-RPC as Codex 0.165: initialize, thread/start|resume,
// thread/read, turn/start (asks for command approval, then runs or skips it),
// turn/interrupt. Message shapes copied from a recorded real session.
'use strict';
const fs = require('fs');
// FAKE_CODEX_STATE: a JSON file that keeps threads across server restarts (resume).
const STATE = process.env.FAKE_CODEX_STATE || '';
// A state file another server is writing right now reads as half a JSON: treat that as empty.
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return []; } };
const threads = new Map(STATE && fs.existsSync(STATE) ? load() : []);
// Write to a temp name and rename, so a reader never sees a partial file.
const save = () => { if (!STATE) return; const tmp = STATE + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify([...threads])); fs.renameSync(tmp, STATE); };
let n = 0;
const id = (p) => p + '-' + (++n);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const note = (method, params) => out({ method, params });
const pendingAsk = new Map();
let current = null;

function thread(tid) {
  if (!threads.has(tid)) threads.set(tid, { id: tid, turns: [] });
  return threads.get(tid);
}

async function runTurn(t, turnId, input) {
  const turn = { id: turnId, items: [], status: 'inProgress' };
  t.turns.push(turn);
  current = { t, turn };
  note('turn/started', { threadId: t.id, turn: { id: turnId, status: 'inProgress', items: [] } });
  const user = { type: 'userMessage', id: id('u'), content: input };
  turn.items.push(user);
  const text = input.filter((i) => i.type === 'text').map((i) => i.text).join(' ');
  const hasImage = input.some((i) => i.type === 'image' && /^data:image\//.test(i.url));
  if (/run/.test(text)) {
    const cmd = { type: 'commandExecution', id: id('call'), command: "/bin/bash -lc 'echo hi'", status: 'inProgress', aggregatedOutput: null, exitCode: null };
    note('item/started', { threadId: t.id, turnId, item: cmd });
    const rid = id('req');
    const decision = await new Promise((resolve) => {
      pendingAsk.set(rid, resolve);
      out({ id: rid, method: 'item/commandExecution/requestApproval', params: { threadId: t.id, turnId, itemId: cmd.id, command: cmd.command, reason: 'needs approval' } });
    });
    if (current && current.turn.status === 'interrupted') return;
    const ran = decision === 'accept' || decision === 'acceptForSession';
    const done = { ...cmd, status: ran ? 'completed' : 'declined', aggregatedOutput: ran ? 'hi\n' : null, exitCode: ran ? 0 : null };
    turn.items.push(done);
    note('item/completed', { threadId: t.id, turnId, item: done });
  }
  const reply = { type: 'agentMessage', id: id('msg'), text: hasImage ? 'saw image' : 'reply to: ' + text + ' (history ' + t.turns.length + ')' };
  turn.items.push(reply);
  note('item/completed', { threadId: t.id, turnId, item: reply });
  note('thread/tokenUsage/updated', { threadId: t.id, tokenUsage: { total: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 12 }, last: {}, modelContextWindow: 128000 } });
  turn.status = 'completed';
  current = null;
  save();
  note('turn/completed', { threadId: t.id, turn: { id: turnId, status: 'completed', items: [reply], error: null } });
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method == null && pendingAsk.has(m.id)) { const r = pendingAsk.get(m.id); pendingAsk.delete(m.id); r(m.result && m.result.decision); continue; }
    const p = m.params || {};
    const ok = (result) => out({ id: m.id, result });
    if (m.method === 'initialize') ok({ userAgent: 'fake', platformOs: 'linux' });
    else if (m.method === 'initialized') { /* notification */ }
    else if (m.method === 'thread/start') { const t = thread('thread-' + Date.now().toString(36) + (++n)); save(); ok({ thread: { id: t.id }, model: p.model || 'fake-model', approvalPolicy: p.approvalPolicy }); }
    else if (m.method === 'thread/resume') { const t = thread(p.threadId); ok({ thread: { id: t.id }, model: p.model || 'fake-model' }); }
    else if (m.method === 'thread/read') { const t = thread(p.threadId); ok({ thread: { id: t.id, turns: t.turns } }); }
    else if (m.method === 'turn/start') { const turnId = id('turn'); ok({ turn: { id: turnId, status: 'inProgress', items: [] } }); runTurn(thread(p.threadId), turnId, p.input || []); }
    else if (m.method === 'turn/interrupt') {
      ok({});
      if (current) {
        current.turn.status = 'interrupted';
        for (const r of pendingAsk.values()) r('cancel');
        pendingAsk.clear();
        note('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', items: [], error: null } });
        current = null;
      }
    } else out({ id: m.id, error: { code: -32601, message: 'unknown method ' + m.method } });
  }
});
