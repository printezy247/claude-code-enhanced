#!/usr/bin/env node
// Stand-in for `opencode serve` in CI (no OpenCode there): the HTTP + SSE
// surface CCE uses, with message shapes copied from a recorded real session.
// Needs the basic-auth password from OPENCODE_SERVER_PASSWORD, like the real one.
'use strict';
const http = require('http');
const fs = require('fs');
const STATE = process.env.FAKE_OC_STATE || '';
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return []; } };
const sessions = new Map(STATE && fs.existsSync(STATE) ? load() : []);
const save = () => { if (!STATE) return; const tmp = STATE + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify([...sessions])); fs.renameSync(tmp, STATE); };
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const expect = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_SERVER_PASSWORD || '')).toString('base64');
let n = 0;
const id = (p) => p + '_' + Date.now().toString(36) + (++n);
const streams = new Set();
const emit = (type, properties) => { for (const r of streams) r.write('data: ' + JSON.stringify({ type, properties, data: properties }) + '\n\n'); };
const waits = new Map();   // permission id -> resolve(reply)
let active = null;         // { sessionID, aborted }
const calls = [];          // every POST under /api, for the tests to read back
// /api/model rows in the real v2 shape (Model.Info), trimmed.
const row = (providerID, id, name, extra) => ({ id, modelID: id, providerID, name, enabled: true, status: 'active', variants: [], capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32000, output: 4096 }, ...extra });
const MODELS = [
  row('fake', 'fake-coder', 'Fake Coder', { variants: [{ id: 'low' }, { id: 'high' }], capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, limit: { context: 128000, output: 8192 } }),
  row('fake', 'plain', 'Plain'),
  row('fake', 'old', 'Old', { enabled: false }),
  row('fake', 'gone', 'Gone', { status: 'deprecated' }),
  row('opencode', 'zen-free', 'Zen Free'),
  row('opencode-go', 'kimi', 'Kimi', { variants: [{ id: 'max' }], limit: { context: 256000, output: 8192 } }),
];
// The providers the login connects, with their display names.
const PROVIDERS = [{ id: 'fake', name: 'Fake Cloud' }, { id: 'opencode', name: 'OpenCode' }, { id: 'opencode-go', name: 'OpenCode Go' }];
// The real server answers an empty model list for a moment after it starts.
let emptyModels = Number(process.env.FAKE_OC_EMPTY_MODELS) || 0;
const PROMPT_KEYS = ['id', 'text', 'files', 'agents', 'skills', 'metadata', 'delivery', 'resume'];

async function run(sess, parts) {
  active = { sessionID: sess.id, aborted: false };
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  const hasImage = parts.some((p) => (p.type === 'file' && /^data:image\//.test(p.url)) || (p.uri && /^data:image\//.test(p.uri)));
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
    if (req.method === 'GET' && (p === '/event' || p === '/api/event')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"server.connected","properties":{},"data":{}}\n\n');
      streams.add(res); res.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'GET' && (p === '/info' || p === '/api/info')) {
      return json({ version: '2.0.21', data: { version: '2.0.21' } });
    }
    if (req.method === 'GET' && p === '/_calls') return json(calls);
    if (req.method === 'POST' && p.startsWith('/api/')) calls.push({ path: p, body: j });
    if (req.method === 'GET' && (p === '/api/model' || p === '/model')) {
      if (emptyModels > 0) { emptyModels--; return json({ location: { directory: '/x' }, data: [] }); }
      return json({ location: { directory: '/x' }, data: MODELS });
    }
    if (req.method === 'GET' && p === '/api/provider') return json({ location: { directory: '/x' }, data: PROVIDERS });
    if (req.method === 'GET' && p === '/api/model/default') return json({ location: { directory: '/x' }, data: MODELS[0] });
    let m = p.match(/^\/api\/session\/([^/]+)\/agent$/);
    if (m && req.method === 'POST') return json(true);
    m = p.match(/^\/api\/session\/([^/]+)\/compact$/);
    if (m && req.method === 'POST') {
      json({ data: { id: id('msg'), sessionID: m[1], type: 'compaction' } });
      setTimeout(() => {
        emit('session.compaction.started', { sessionID: m[1], reason: 'manual' });
        emit('session.compaction.ended', { sessionID: m[1], reason: 'manual', text: 'summary' });
        emit('session.execution.succeeded', { sessionID: m[1] });
      }, 20);
      return;
    }
    if (req.method === 'POST' && (p === '/session' || p === '/api/session')) {
      const s = { id: id('ses'), title: j.title || '', messages: [] };
      sessions.set(s.id, s);
      save();
      return json(p.startsWith('/api') ? { data: { id: s.id, title: s.title }, id: s.id, title: s.title } : { id: s.id, title: s.title });
    }
    m = p.match(/^\/(?:api\/)?session\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const s = sessions.get(m[1]);
      return s ? json(p.startsWith('/api') ? { data: { id: s.id, title: s.title }, id: s.id, title: s.title } : { id: s.id, title: s.title }) : json({ error: 'not found' }, 404);
    }
    m = p.match(/^\/(?:api\/)?session\/([^/]+)\/message$/);
    if (m && req.method === 'GET') {
      const s = sessions.get(m[1]);
      return s ? json(p.startsWith('/api') ? { data: s.messages } : s.messages) : json({ error: 'not found' }, 404);
    }
    m = p.match(/^\/(?:api\/)?session\/([^/]+)\/(?:prompt_async|prompt)$/);
    if (m && req.method === 'POST') {
      const s = sessions.get(m[1]);
      if (!s) return json({ error: 'not found' }, 404);
      // Like the real v2 server: the prompt body takes no model or agent.
      const extra = p.startsWith('/api') && Object.keys(j).find((k) => !PROMPT_KEYS.includes(k));
      if (extra) return json({ error: 'unexpected key ' + extra }, 400);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: id('msg'), sessionID: s.id } }));
      const parts = j.parts || (j.text ? [{ type: 'text', text: j.text }, ...(j.files || []).map((f) => ({ type: 'file', url: f.uri, filename: f.name }))] : []);
      run(s, parts);
      return;
    }
    m = p.match(/^\/(?:api\/)?session\/([^/]+)\/(?:abort|interrupt)$/);
    if (m && req.method === 'POST') {
      json({ interrupted: true });
      if (active) { active.aborted = true; for (const r of waits.values()) r('reject'); waits.clear(); if (active.release) active.release(); }
      return;
    }
    m = p.match(/^\/(?:api\/)?session\/([^/]+)\/model$/);
    if (m && req.method === 'POST') return json(true);
    m = p.match(/^\/(?:api\/)?(?:session\/[^/]+\/)?permission\/([^/]+)\/reply$/);
    if (m && req.method === 'POST') { const r = waits.get(m[1]); waits.delete(m[1]); if (r) r(j.decision || j.reply); return json(true); }
    m = p.match(/^\/(?:api\/)?question\/([^/]+)\/reject$/);
    if (m && req.method === 'POST') return json(true);
    json({ error: 'unknown ' + req.method + ' ' + p }, 404);
  });
});
server.listen(port, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + port));
