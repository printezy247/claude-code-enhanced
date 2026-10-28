// Web/QR remote (item 13): a tiny loopback HTTP server so a phone on the same
// machine (or reached through an SSH tunnel) can watch chats, answer permission
// prompts and send a message. Every API call needs the pairing token; the token
// is compared in constant time. Binds to 127.0.0.1 unless explicitly told
// otherwise — this box's rule is that nothing listens on the LAN.
'use strict';
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 64 * 1024;
const DECISIONS = new Set(['allow', 'deny']);

function tokenOk(got, want) {
  const a = crypto.createHash('sha256').update(String(got || '')).digest();
  const b = crypto.createHash('sha256').update(String(want || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Enhanced — remote</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#111;color:#eee}
  header{padding:12px 16px;background:#1b1b1f;border-bottom:1px solid #333;font-weight:600}
  main{padding:12px 16px;display:grid;gap:12px}
  .card{background:#1b1b1f;border:1px solid #333;border-radius:10px;padding:12px}
  .card h2{font-size:13px;margin:0 0 8px;color:#9aa}
  button{padding:10px 14px;border-radius:8px;border:1px solid #555;background:#2a2a30;color:#eee;font-size:15px}
  button.allow{background:#1d4ed8;border-color:#1d4ed8}
  button.deny{background:#7f1d1d;border-color:#7f1d1d}
  input,textarea{width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:8px;padding:10px;font-size:15px}
  .chip{display:inline-block;padding:2px 8px;border-radius:99px;background:#333;font-size:12px;margin-right:6px}
  .busy{background:#14532d}.idle{background:#333}.needs{background:#7c2d12}
</style></head>
<body><header>Claude Code Enhanced — remote</header>
<main>
  <div class="card"><h2>Chats</h2><div id="chats">…</div></div>
  <div class="card"><h2>Needs you</h2><div id="perms">none</div></div>
  <div class="card"><h2>Send to chat</h2>
    <input id="target" placeholder="chat id (or tap a chat above)">
    <textarea id="msg" rows="3" placeholder="message"></textarea>
    <button id="send" style="margin-top:8px">Send</button>
  </div>
</main>
<script>
const token = new URLSearchParams(location.search).get('t') || '';
const api = (p, opts) => fetch(p + '?t=' + encodeURIComponent(token), opts);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function pick(id){ document.getElementById('target').value = id; }
async function refresh(){
  const r = await api('/api/state');
  if (!r.ok) { document.getElementById('chats').textContent = 'token rejected — rescan the QR'; return; }
  const s = await r.json();
  document.getElementById('chats').innerHTML = s.chats.length ? s.chats.map((c) =>
    '<div style="padding:6px 0"><span class="chip ' + (c.needsYou ? 'needs' : c.busy ? 'busy' : 'idle') + '">'
    + (c.needsYou ? 'needs you' : c.busy ? 'working' : 'idle') + '</span>'
    + '<a href="#" onclick="pick(&quot;' + esc(c.id) + '&quot;);return false">' + esc(c.cwd || c.id) + '</a></div>').join('')
    : '<span class="chip idle">no open chats</span>';
  document.getElementById('perms').innerHTML = s.perms.length ? s.perms.map((p) =>
    '<div style="padding:6px 0">' + esc(p.toolName || 'tool') + ' <button class="allow" onclick="answer(&quot;'
    + esc(p.requestId) + '&quot;,&quot;allow&quot;)">Allow</button> <button class="deny" onclick="answer(&quot;'
    + esc(p.requestId) + '&quot;,&quot;deny&quot;)">Deny</button></div>').join('') : 'none';
}
async function answer(requestId, decision){
  await api('/api/answer', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ requestId, decision }) });
  refresh();
}
document.getElementById('send').onclick = async () => {
  const id = document.getElementById('target').value.trim();
  const text = document.getElementById('msg').value;
  if (!id || !text) return;
  await api('/api/send', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ id, text }) });
  document.getElementById('msg').value = '';
};
refresh(); setInterval(refresh, 4000);
</script></body></html>`;

function createWebRemote({ boardRows, pendingPerms, send, answer }) {
  let server = null;
  let token = '';
  let port = 0;
  let host = '127.0.0.1';

  function routes(res, reqUrl, method, req) {
    const t = reqUrl.searchParams.get('t') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const authed = tokenOk(t, token);
    if (reqUrl.pathname === '/' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return true;
    }
    if (!reqUrl.pathname.startsWith('/api/')) return false;
    if (!authed) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad token' }));
      return true;
    }
    if (reqUrl.pathname === '/api/state' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ chats: boardRows(), perms: pendingPerms() }));
      return true;
    }
    if (reqUrl.pathname === '/api/send' && method === 'POST') {
      readBody(req).then(async (body) => {
        const id = String(body.id || '');
        const text = String(body.text || '');
        if (!id || !text) throw new Error('id and text are required');
        const r = await send(id, text);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r && r.ok === false ? r : { ok: true }));
      }).catch((err) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      });
      return true;
    }
    if (reqUrl.pathname === '/api/answer' && method === 'POST') {
      readBody(req).then((body) => {
        const requestId = String(body.requestId || '');
        const decision = String(body.decision || '');
        if (!requestId || !DECISIONS.has(decision)) throw new Error('requestId and decision (allow|deny) are required');
        const r = answer(requestId, decision);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r && r.ok === false ? r : { ok: true }));
      }).catch((err) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      });
      return true;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }

  return {
    async start({ host: wantHost = '127.0.0.1', port: wantPort = 0 } = {}) {
      if (server) return this.status();
      host = wantHost;
      token = crypto.randomBytes(16).toString('hex');
      server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url, 'http://' + host);
          if (!routes(res, reqUrl, req.method, req)) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
          }
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, host, () => {
          port = server.address().port;
          resolve();
        });
      });
      return this.status();
    },
    stop() {
      if (server) { try { server.close(); } catch { /* already gone */ } server = null; }
      port = 0;
    },
    status() {
      return {
        running: !!server,
        host, port,
        url: server ? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/?t=${token}` : '',
        token,
      };
    },
  };
}

module.exports = { createWebRemote };
