#!/usr/bin/env node
// Stand-in for `opencode serve` in CI (no OpenCode there): the HTTP + SSE
// surface CCE uses, with message shapes copied from a recorded real session.
// Needs the basic-auth password from OPENCODE_SERVER_PASSWORD, like the real one.
'use strict';
const http = require('http');
const fs = require('fs');
const STATE = process.env.FAKE_OC_STATE || '';
const sessions = new Map(STATE && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : []);
const save = () => { if (STATE) fs.writeFileSync(STATE, JSON.stringify([...sessions])); };
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const expect = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_SERVER_PASSWORD || '')).toString('base64');
let n = 0;
const id = (p) => p + '_' + Date.now().toString(36) + (++n);
const streams = new Set();
const emit = (type, properties) => { for (const r of streams) r.write('data: ' + JSON.stringify({ type, properties }) + '\n\n'); };
const waits = new Map();   // permission id -> resolve(reply)
let active = null;         // { sessionID, aborted }

async function run(sess, parts) {
  active = { sessionID: sess.id, aborted: false };
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  const hasImage = parts.some((p) => p.type === 'file' && /^data:image\//.test(p.url));
  const um = { id: id('msg'), role: 'user', sessionID: sess.id };
  const userParts = parts.map((p) => ({ ...p, id: id('prt'), messageID: um.id, sessionID: sess.id }));
  sess.messages.push({ info: um, parts: userParts });
  emit('session.status', { sessionID: sess.id, status: { type: 'busy' } });
  const am = { id: id('msg'), role: 'assistant', sessionID: sess.id };
  const out = { info: am, parts: [] };
  sess.messages.push(out);
  if (/hang/.test(text)) { await new Promise((r) => { active.release = r; }); }
  else if (/run/.test(text)) {
    const call = { id: id('prt'), messageID: am.id, sessionID: sess.id, type: 'tool', tool: 'bash', callID: id('call'), state: { status: 'running', input: { command: 'echo hi', description: 'say hi' }, time: { start: Date.now() } } };
    emit('message.part.updated', { sessionID: sess.id, part: call, time: Date.now() });
    const pid = id('per');
    const reply = await new Promise((resolve) => {
      waits.set(pid, resolve);
      emit('permission.asked', { id: pid, sessionID: sess.id, permission: 'bash', patterns: ['echo hi'], metadata: { command: 'echo hi' }, always: ['echo *'], tool: { messageID: am.id, callID: call.callID } });
    });
    emit('permission.replied', { sessionID: sess.id, requestID: pid, reply });
    const ran = reply === 'once' || reply === 'always';
    const done = ran
      ? { ...call, state: { status: 'completed', input: call.state.input, output: 'hi\n', title: 'echo hi', metadata: {}, time: { start: 1, end: 2 } } }
      : { ...call, state: { status: 'error', input: call.state.input, error: 'The user rejected permission to use this specific tool call.', time: { start: 1, end: 2 } } };
    out.parts.push(done);
    emit('message.part.updated', { sessionID: sess.id, part: done, time: Date.now() });
  }
  if (!active.aborted) {
    const t = { id: id('prt'), messageID: am.id, sessionID: sess.id, type: 'text', text: hasImage ? 'saw image' : 'reply to: ' + text + ' (users ' + sess.messages.filter((m) => m.info.role === 'user').length + ')', time: { start: 1, end: 2 } };
    out.parts.push(t);
    emit('message.part.updated', { sessionID: sess.id, part: { ...t, text: '', time: { start: 1 } }, time: Date.now() });
    emit('message.part.updated', { sessionID: sess.id, part: t, time: Date.now() });
    emit('message.part.updated', { sessionID: sess.id, part: { id: id('prt'), messageID: am.id, sessionID: sess.id, type: 'step-finish', reason: 'stop', tokens: { total: 15, input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }, time: Date.now() });
  }
  save();
  active = null;
  emit('session.idle', { sessionID: sess.id });
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expect) { res.writeHead(401).end(); return; }
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = url.pathname;
    if (req.method === 'GET' && p === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
      streams.add(res); res.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'POST' && p === '/session') { const s = { id: id('ses'), title: j.title || '', messages: [] }; sessions.set(s.id, s); save(); return json({ id: s.id, title: s.title }); }
    let m = p.match(/^\/session\/([^/]+)$/);
    if (m && req.method === 'GET') { const s = sessions.get(m[1]); return s ? json({ id: s.id, title: s.title }) : json({ error: 'not found' }, 404); }
    m = p.match(/^\/session\/([^/]+)\/message$/);
    if (m && req.method === 'GET') { const s = sessions.get(m[1]); return s ? json(s.messages) : json({ error: 'not found' }, 404); }
    m = p.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (m && req.method === 'POST') { const s = sessions.get(m[1]); if (!s) return json({ error: 'not found' }, 404); res.writeHead(204).end(); run(s, j.parts || []); return; }
    m = p.match(/^\/session\/([^/]+)\/abort$/);
    if (m && req.method === 'POST') {
      json(true);
      if (active) { active.aborted = true; for (const r of waits.values()) r('reject'); waits.clear(); if (active.release) active.release(); }
      return;
    }
    m = p.match(/^\/permission\/([^/]+)\/reply$/);
    if (m && req.method === 'POST') { const r = waits.get(m[1]); waits.delete(m[1]); if (r) r(j.reply); return json(true); }
    m = p.match(/^\/question\/([^/]+)\/reject$/);
    if (m && req.method === 'POST') return json(true);
    json({ error: 'unknown ' + req.method + ' ' + p }, 404);
  });
});
server.listen(port, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + port));
