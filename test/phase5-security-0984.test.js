// Phase 5 of the CCE review: security.
// - Auto-mode shell approval parses the line like a shell: quotes and escapes
//   can no longer hide a write flag or a secret file name.
// - IPC size caps are per channel; unknown channels keep 1 MB.
// - Pasted images of an unsent message go to 0600 files in the main process,
//   never to localStorage.
// - IPC from a devtools:// frame is refused in a packaged build.
// - The translator proxy listens on 127.0.0.1 only and checks its token.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
process.env.CCE_PROXY_PORT = '0';
const { isSafeBash, splitShell } = require('../src/main/autopolicy.js');
const ipcguard = require('../src/main/ipcguard.js');
const { createDraftStore } = require('../src/main/drafts.js');
const { startProxy } = require('../src/main/proxy.js');

describe('auto-mode shell parsing', () => {
  it('quotes cannot hide a write flag', () => {
    expect(isSafeBash("sed -i 's/a/b/' f.txt")).toBe(false);
    expect(isSafeBash("sed '-i' 's/a/b/' f.txt")).toBe(false);
    expect(isSafeBash('sed "-i" s/a/b/ f.txt')).toBe(false);
  });

  it('quotes, escapes and ANSI-C strings cannot hide a secret file', () => {
    for (const cmd of ['cat .env', 'cat ".e""nv"', "cat '.env'", 'cat \\.env', "cat $'\\x2eenv'", 'cat .e\\nv', 'head ~/.s"s"h/id_rsa']) {
      expect(isSafeBash(cmd), cmd).toBe(false);
    }
  });

  it('globs cannot reach hidden or outside files', () => {
    for (const cmd of ['cat .e*', 'cat ~/.ss?/config', 'cat /etc/sh*', 'head ../*.pem', 'ls **/.git*']) {
      expect(isSafeBash(cmd), cmd).toBe(false);
    }
    expect(isSafeBash('ls src/*.js')).toBe(true);
    expect(isSafeBash('wc -l *.md')).toBe(true);
  });

  it('operators inside quotes are text, not chains', () => {
    expect(isSafeBash('grep -n "foo|bar;baz" src/a.js')).toBe(true);
    expect(isSafeBash("grep -rn 'a && b' src")).toBe(true);
    expect(isSafeBash('git log --oneline | head -5')).toBe(true);
    expect(isSafeBash('ls && git status')).toBe(true);
  });

  it('expansions, redirects, subshells and unclosed quotes are refused', () => {
    for (const cmd of ['ls > out.txt', 'cat < /etc/passwd', 'ls & rm x', 'echo `id`', 'echo "$(id)"', 'echo "$HOME"', '(ls)', 'ls "unclosed', 'ls\nrm x', 'echo ${PATH}']) {
      expect(isSafeBash(cmd), JSON.stringify(cmd)).toBe(false);
    }
    expect(isSafeBash("grep -n '$(not run)' a.js")).toBe(true);
  });

  it('splitShell returns unquoted words per segment', () => {
    expect(splitShell(`grep -n "a b" x.js | head -3`)).toMatchObject({ ok: true, segments: [['grep', '-n', 'a b', 'x.js'], ['head', '-3']] });
    expect(splitShell('echo "x').ok).toBe(false);
  });
});

describe('IPC payload caps per channel', () => {
  it('chat sends and draft images get the large cap; anything else 1 MB', () => {
    expect(ipcguard.payloadCap('chat:send')).toBe(24_000_000);
    expect(ipcguard.payloadCap('chat:steer')).toBe(24_000_000);
    expect(ipcguard.payloadCap('draft:images')).toBe(24_000_000);
    expect(ipcguard.payloadCap('settings:set')).toBe(1_000_000);
    expect(ipcguard.payloadCap('made:up')).toBe(1_000_000);
  });
});

describe('IPC origin', () => {
  const dir = '/opt/cce/resources/app.asar/src/renderer';
  it('the app page is accepted, other pages refused', () => {
    expect(ipcguard.isAllowedSenderUrl('file://' + dir + '/index.html', dir, { packaged: true })).toBe(true);
    expect(ipcguard.isAllowedSenderUrl('file:///tmp/evil.html', dir, { packaged: true })).toBe(false);
    expect(ipcguard.isAllowedSenderUrl('https://example.com/', dir, { packaged: true })).toBe(false);
    expect(ipcguard.isAllowedSenderUrl('', dir, { packaged: true })).toBe(false);
  });

  it('devtools:// only in a development build', () => {
    expect(ipcguard.isAllowedSenderUrl('devtools://devtools/bundled/devtools_app.html', dir, { packaged: true })).toBe(false);
    expect(ipcguard.isAllowedSenderUrl('devtools://devtools/bundled/devtools_app.html', dir, { packaged: false })).toBe(true);
  });

  it('only http(s) links leave the app', () => {
    expect(ipcguard.isExternalLink('https://github.com/x')).toBe(true);
    expect(ipcguard.isExternalLink('http://localhost:3000')).toBe(true);
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url']) expect(ipcguard.isExternalLink(u), u).toBe(false);
  });
});

describe('unsent pasted images', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cce-drafts-'));
  const png = { media_type: 'image/png', data: 'iVBORw0KGgo=' };

  it('are stored in 0600 files in a 0700 folder, and read back', () => {
    const dir = path.join(tmp(), 'drafts');
    const s = createDraftStore(dir);
    s.save('/home/me/proj', [png]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const [file] = fs.readdirSync(dir);
    expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
    expect(file).not.toContain('proj');
    expect(s.load('/home/me/proj')).toEqual([png]);
  });

  it('an empty list deletes the file', () => {
    const dir = path.join(tmp(), 'drafts');
    const s = createDraftStore(dir);
    s.save('k', [png]);
    s.save('k', []);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(s.load('k')).toEqual([]);
  });

  it('only real images, at most 8, are kept', () => {
    const s = createDraftStore(path.join(tmp(), 'drafts'));
    s.save('k', [png, { media_type: 'text/html', data: 'PGI+' }, { media_type: 'image/png', data: 'not base64!' }, ...Array(10).fill(png)]);
    expect(s.load('k')).toHaveLength(8);
    expect(s.load('k').every((i) => i.media_type === 'image/png')).toBe(true);
  });

  it('a chat puts back the images its unsent message had, and saves changes through IPC', async () => {
    const { loadRenderer, flush } = require('./helpers/renderer.js');
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '1' }, home: '/h' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/tmp/p', fontSize: 14, scrollback: 1000 }, claude: { found: true } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/tmp/p', model: '', permissionMode: 'default', provider: null },
      'draft:images': (p) => (p.op === 'load' ? { ok: true, images: [png] } : { ok: true }),
    } });
    await flush(10);
    const chat = h.window.Chat.chats.get('c1');
    expect(chat.pendingImages).toEqual([png]);
    expect(chat.imgs.querySelectorAll('.img-chip')).toHaveLength(1);
    chat.imgs.querySelector('.img-chip .close').click();
    await new Promise((r) => setTimeout(r, 350));
    const saves = h.calls.filter((c) => c.channel === 'draft:images' && c.payload.op === 'save');
    expect(saves.at(-1).payload).toEqual({ op: 'save', key: '/tmp/p', images: [] });
    expect(Object.keys(h.window.localStorage).some((k) => /image/i.test(h.window.localStorage.getItem(k) || ''))).toBe(false);
  });

  it('the renderer no longer writes images to localStorage', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/chat/composer.js'), 'utf8');
    expect(src).toMatch(/invoke\('draft:images'/);
  });
});

describe('translator proxy listener', () => {
  const open = [];
  afterEach(async () => { for (const s of open.splice(0)) await new Promise((r) => s.close(r)); });

  it('binds 127.0.0.1 only and refuses a request without its token', async () => {
    const px = await startProxy(() => ({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k' }), { port: 0, token: 'secret-token' });
    open.push(px.server);
    expect(px.server.address().address).toBe('127.0.0.1');
    const r = await fetch('http://127.0.0.1:' + px.port + '/px/a1/v1/messages', { method: 'POST', body: '{}' });
    expect([401, 403]).toContain(r.status);
  });
});
