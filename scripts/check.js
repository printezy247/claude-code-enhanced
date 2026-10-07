#!/usr/bin/env node
// Self-check: syntax over every source file + real assertions on the pieces
// that have broken before (transcript path munge, permission answers).
// Run: npm run check   (exit 1 on first failure)
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ok  ' + msg);
  else { failures++; console.error('FAIL  ' + msg); }
};

// 1. syntax ---------------------------------------------------------------
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = [...jsFiles(path.join(root, 'src')), ...jsFiles(path.join(root, 'scripts'))];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failures++;
    console.error('FAIL  syntax ' + path.relative(root, f) + ': ' + String(e.stderr || e.message).slice(0, 300));
  }
}
console.log('  ok  syntax: ' + files.length + ' files');

// 2. real main-process logic ---------------------------------------------
const ChatManager = require(path.join(root, 'src', 'main', 'chats.js'));
const chats = new ChatManager();

// projDirFor must resolve a cwd that contains a space (the bug that hid history)
const cwd = path.join(os.homedir(), 'Documents', 'Default Project');
const { projDir } = chats.projDirFor(cwd);
ok(fs.existsSync(projDir), 'projDirFor resolves "' + cwd + '" -> ' + path.basename(projDir));
const sessionFiles = fs.existsSync(projDir) ? fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl')) : [];
ok(sessionFiles.length > 0, 'project has stored sessions (' + sessionFiles.length + ')');

// transcript replay: parse a real stored session
if (sessionFiles.length) {
  const newest = sessionFiles
    .map(f => ({ f, m: fs.statSync(path.join(projDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0].f.replace(/\.jsonl$/, '');
  const { items } = chats.transcript(cwd, newest);
  ok(items.length > 0, 'transcript replays for ' + newest.slice(0, 8) + ' (' + items.length + ' items)');
  const kinds = new Set(items.map(i => i.t));
  ok(kinds.has('user'), 'transcript contains user messages');
} else {
  ok(false, 'transcript replay skipped — no stored session');
}

// AskUserQuestion answers ride on the permission result
let resolved = null;
chats.pendingPerms.set('chk1', {
  toolName: 'AskUserQuestion',
  input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: '' }] }] },
  resolve: (r) => { resolved = r; },
  timer: null,
});
chats.answer('chk1', 'chk1', 'allow', { 'Which one?': 'A' });
ok(resolved && resolved.behavior === 'allow', 'answers resolve as allow');
ok(resolved && resolved.updatedInput.answers['Which one?'] === 'A', 'answers keyed by question text');
ok(resolved && Array.isArray(resolved.updatedInput.questions), 'original questions kept in updatedInput');

// deny path still works
resolved = null;
chats.pendingPerms.set('chk2', { toolName: 'Bash', input: { command: 'ls' }, resolve: (r) => { resolved = r; }, timer: null });
chats.answer('chk2', 'chk2', 'deny');
ok(resolved && resolved.behavior === 'deny', 'deny still denies');

// sessionId validation (path traversal guard)
let threw = false;
try { chats.transcript(cwd, '../../etc/passwd'); } catch { threw = true; }
ok(threw, 'invalid session id rejected');

// Runtime tool detection: GUI PATH holes (bun in ~/.bun/bin) and Ubuntu's
// fd -> fdfind rename must both resolve.
const toolsMod = require(path.join(root, 'src', 'main', 'tools.js'));

(async () => {
  const t = await toolsMod.check();
  const by = Object.fromEntries(t.tools.map(x => [x.name, x]));
  ok(by.git && by.git.found, 'git detected (' + (by.git ? by.git.path : '?') + ')');
  ok(by.bun && by.bun.found, 'bun detected outside PATH (' + (by.bun ? by.bun.path : '?') + ')');
  ok(by.fd && by.fd.found, 'fd detected via alt name/path (' + (by.fd ? by.fd.path : '?') + ')');
  ok(fs.existsSync(toolsMod.EXTRAS.bun[0]), 'bun fallback path exists: ' + toolsMod.EXTRAS.bun[0]);
  ok(fs.existsSync(toolsMod.EXTRAS.fd[0]), 'fd fallback path exists: ' + toolsMod.EXTRAS.fd[0]);

  /* --- local-model pre-warm (src/main/localmodels.js) --- */
  const http = require('http');
  const lm = require(path.join(root, 'src', 'main', 'localmodels.js'));

  // Non-Ollama provider (DeepSeek/Kimi/OpenRouter): /api/* answers 404 — warm
  // must skip, never block chat creation with "Ollama could not load".
  const notOllama = http.createServer((_q, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise(r => notOllama.listen(0, '127.0.0.1', r));
  const skip = await lm.warmOllamaModel('http://127.0.0.1:' + notOllama.address().port, 'deepseek-chat', 131072);
  ok(skip.ok === true, 'warm skips non-Ollama providers (got ' + JSON.stringify(skip).slice(0, 90) + ')');
  notOllama.close();

  // Fake Ollama: tags/show/generate answer like Ollama — warm must succeed
  // with a context at or above the engine floor.
  const fakeOllama = http.createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/api/tags') return json({ models: [{ name: 'm1', size: 1e9 }] });
    if (req.url === '/api/show') return json({ model_info: {
      'llama.context_length': 262144, 'llama.block_count': 32,
      'llama.attention.head_count_kv': 8, 'llama.attention.key_length': 128,
    } });
    if (req.url === '/api/generate') return json({ done: true });
    res.writeHead(404); res.end();
  });
  await new Promise(r => fakeOllama.listen(0, '127.0.0.1', r));
  const warm = await lm.warmOllamaModel('http://127.0.0.1:' + fakeOllama.address().port, 'm1', 131072);
  ok(warm.ok === true && warm.ctx >= 70000, 'warm loads a fake Ollama model at ctx ' + (warm.ctx || warm.error));
  fakeOllama.close();

  /* --- translator proxy (src/main/proxy.js): parallel tool calls --- */
  // OpenAI interleaves argument chunks of two tool calls; Anthropic blocks are
  // sequential. Both tool_use blocks must come out with parseable JSON input.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const s = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const tc = (i, id, name, args) => s({ choices: [{ delta: { tool_calls: [{ index: i, id, function: { name, arguments: args } }] } }] });
    tc(0, 'call_a', 'get_weather', '{"city":');
    tc(1, 'call_b', 'get_time', '{"zone":');
    tc(0, null, null, '"Berlin"}');           // interleaved — the corruption case
    tc(1, null, null, '"UTC"}');
    s({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  process.env.CCE_PROXY_PORT = '0';
  const { startProxy } = require(path.join(root, 'src', 'main', 'proxy.js'));
  const proxy = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:' + upPort, apiKey: '' }));
  const pPort = (proxy.server.address() && proxy.server.address().port) || proxy.port;
  const resp = await fetch('http://127.0.0.1:' + pPort + '/px/testuid/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'x' }] }),
    signal: AbortSignal.timeout(10000),
  });
  const sseText = await resp.text();
  const blockName = new Map();   // block index -> tool name
  for (const m of sseText.matchAll(/"type":"content_block_start","index":(\d+),"content_block":\{"type":"tool_use","id":"[^"]*","name":"([a-z_]+)"/g)) {
    blockName.set(m[1], m[2]);
  }
  const args = {};
  for (const m of sseText.matchAll(/"type":"content_block_delta","index":(\d+),"delta":\{"type":"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"\}/g)) {
    const name = blockName.get(m[1]);
    if (name) args[name] = (args[name] || '') + JSON.parse('"' + m[2] + '"');
  }
  const names = [...blockName.values()].sort();
  ok(names.length === 2 && names[0] === 'get_time' && names[1] === 'get_weather',
    'proxy emits both tool_use blocks (got: ' + names.join(',') + ')');
  const okArgs = ['get_weather', 'get_time'].every(n => {
    try { JSON.parse(args[n] || ''); return true; } catch { return false; }
  });
  ok(okArgs, 'proxy tool args reassemble as valid JSON (' + JSON.stringify(args) + ')');
  ok(sseText.includes('"stop_reason":"tool_use"'), 'proxy reports stop_reason tool_use');
  try { proxy.server.close(); } catch { /* already closed */ }
  try { upstream.close(); } catch { /* already closed */ }

  if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
  console.log('\nall checks passed');
})();
