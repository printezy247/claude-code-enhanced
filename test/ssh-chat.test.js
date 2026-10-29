// Claude Code on another machine over SSH (0.13.0). The command that reaches
// the remote shell is built by quoting, so hostile folder names and flags must
// stay inside their quotes; the local environment (provider keys) must not
// travel; the options the chat gets must drop what only exists locally. A
// stand-in `ssh` runs the remote command on this machine, which exercises the
// real quoting and stdio path, but no network and no real remote host.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ssh = require('../src/main/sshrun.js');
const ChatManager = require('../src/main/chats.js');
const { validateArgs } = require('../src/main/ipcschemas.js');

const HOST = { id: 'h-1', label: 'build box', host: 'build.example.com', user: 'jack', port: 2222, identity: '/home/jack/.ssh/id_ed25519' };

describe('the remote command', () => {
  it('quotes anything', () => {
    expect(ssh.shq("it's")).toBe("'it'\\''s'");
    expect(ssh.shq('a b; rm -rf /')).toBe("'a b; rm -rf /'");
  });

  it('builds cd + exec with every flag quoted', () => {
    expect(ssh.remoteCommand({ command: 'claude', args: ['--output-format', 'stream-json', '--model', 'opus'], cwd: '/srv/app' }))
      .toBe("cd '/srv/app' && exec claude '--output-format' 'stream-json' '--model' 'opus'");
  });

  it('a hostile folder or flag cannot add a second command', () => {
    fs.rmSync('/tmp/pwned', { force: true });   // so a leftover file cannot make this pass or fail by itself
    const evil = "x'; touch /tmp/pwned; echo '";
    const cmd = ssh.remoteCommand({ command: 'claude', args: ['--append-system-prompt', evil, '$(id)', '`id`'], cwd: evil });
    // run it through a real shell with the command swapped for a printer: the folder does not exist, and nothing else runs
    const run = spawnSync('sh', ['-c', cmd.replace('exec claude', 'exec printf %s%s\\\\n')], { encoding: 'utf8' });
    expect(fs.existsSync('/tmp/pwned')).toBe(false);
    expect(run.status).not.toBe(0);   // cd into a folder named like the payload fails
  });

  it('~ is left for the remote shell to expand', () => {
    expect(ssh.cdPart('~')).toBe('cd ~ && ');
    expect(ssh.cdPart('~/my proj')).toBe("cd ~/'my proj' && ");
    expect(ssh.cdPart('')).toBe('');
    const home = spawnSync('sh', ['-c', ssh.remoteCommand({ command: 'pwd', cwd: '~' }).replace('exec pwd', 'exec pwd')], { encoding: 'utf8', env: { ...process.env, HOME: os.tmpdir() } });
    expect(fs.realpathSync(home.stdout.trim())).toBe(fs.realpathSync(os.tmpdir()));
  });

  it('only a plain executable name or path is accepted as the remote command', () => {
    for (const bad of ['claude; id', 'a b', '$(x)', '-rf', '', 'claude\nid']) expect(() => ssh.remoteCommand({ command: bad }), bad).toThrow(/invalid remote command/);
    expect(() => ssh.remoteCommand({ command: '/opt/claude/bin/claude' })).not.toThrow();
  });

  it('ssh argv: no terminal, no password prompt, the host options, the command last', () => {
    const { command, args } = ssh.sshCommand(HOST, { command: 'claude', args: ['-p'], cwd: '/srv/app' });
    expect(command).toBe('ssh');
    expect(args.slice(0, 5)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']);
    expect(args).toContain('-p'); expect(args).toContain('2222');
    expect(args).toContain('-i'); expect(args).toContain('/home/jack/.ssh/id_ed25519');
    expect(args).toContain('jack@build.example.com');
    expect(args[args.length - 1]).toBe("cd '/srv/app' && exec claude '-p'");
  });
});

describe('what the remote does not get', () => {
  it('only what ssh needs of the local environment', () => {
    const env = ssh.minimalEnv({ PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/s', ANTHROPIC_API_KEY: 'sk-secret', OPENAI_API_KEY: 'sk-2', GITHUB_TOKEN: 'ghp_x', CCE_PROVIDER_KEY: 'tok' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/s' });
  });

  it('remote options drop the sandbox, plugins, local MCP servers and the code index, keep in-process servers', () => {
    const inproc = { type: 'sdk', name: 'cce_host', instance: {} };
    const options = {
      cwd: '~/proj', sandbox: { enabled: true }, plugins: [{ type: 'local', path: '/local' }], pathToClaudeCodeExecutable: '/local/claude',
      env: { ANTHROPIC_API_KEY: 'sk-secret' },
      mcpServers: { github: { type: 'http', url: 'https://x' }, files: { type: 'stdio', command: 'npx' }, cce_host: inproc, cce_index: { type: 'sdk', name: 'cce_index' } },
    };
    ssh.remoteOptions(options, HOST, { env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-secret' } });
    expect(options.sandbox).toBeUndefined();
    expect(options.plugins).toBeUndefined();
    expect(options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(options.env).toEqual({ PATH: '/bin' });
    expect(Object.keys(options.mcpServers)).toEqual(['cce_host']);
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });
});

// ---- a stand-in ssh and a stand-in remote claude ----------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-ssh-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp */ } });
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
// ssh [options] destination command: runs `command` in a shell, like the remote login shell would.
fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
while [ $# -gt 1 ]; do
  case "$1" in -o|-p|-i) shift 2 ;; -T) shift ;; *) shift ;; esac
done
# the last argument is the remote command (the destination was consumed above as a leftover option)
exec sh -c "$1"
`, { mode: 0o755 });
// The remote "claude": prints what it was given, then echoes each stdin line back until stdin closes.
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
node -e '
const lines = [];
console.log(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY || null, token: process.env.CCE_PROVIDER_KEY || null }));
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) !== -1) { console.log(JSON.stringify({ echo: buf.slice(0, i) })); buf = buf.slice(i + 1); } });
process.stdin.on("end", () => process.exit(0));
' -- "$@"
`, { mode: 0o755 });

const procs = [];
afterEach(() => { while (procs.length) { try { procs.pop().kill('SIGKILL'); } catch { /* gone */ } } });

function lines(stream, n) {
  return new Promise((resolve, reject) => {
    let buf = ''; const out = [];
    const t = setTimeout(() => reject(new Error('timed out; got ' + JSON.stringify(out))), 8000);
    stream.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); if (out.length === n) { clearTimeout(t); resolve(out); } } });
  });
}

describe('through a stand-in ssh', () => {
  const env = { PATH: bin + ':' + process.env.PATH, HOME: tmp, ANTHROPIC_API_KEY: 'sk-local-secret', CCE_PROVIDER_KEY: 'proxy-token' };

  it('runs the remote command in the folder with the flags intact, and speaks stdio both ways', async () => {
    const dir = path.join(tmp, "my proj 'quoted'");
    fs.mkdirSync(dir);
    const spawner = ssh.createSshSpawner(HOST, { env });
    const child = spawner({ command: '/local/claude', args: ['--output-format', 'stream-json', '--append-system-prompt', 'a b; c $(id)'], cwd: dir, env: {} });
    procs.push(child);
    const first = await lines(child.stdout, 1);
    expect(first[0].argv).toEqual(['--output-format', 'stream-json', '--append-system-prompt', 'a b; c $(id)']);
    expect(fs.realpathSync(first[0].cwd)).toBe(fs.realpathSync(dir));
    child.stdin.write('{"type":"user","n":1}\n');
    const echoed = await lines(child.stdout, 1);
    expect(echoed[0]).toEqual({ echo: '{"type":"user","n":1}' });
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
    expect(child.exitCode).toBe(0);
  });

  it('the local provider key and proxy token never reach the remote command', async () => {
    const child = ssh.createSshSpawner(HOST, { env })({ command: 'claude', args: [], cwd: tmp, env: { ANTHROPIC_API_KEY: 'sk-local-secret' } });
    procs.push(child);
    const [info] = await lines(child.stdout, 1);
    expect(info.key).toBeNull();
    expect(info.token).toBeNull();
    child.stdin.end();
  });

  it('an abort signal stops the process; ssh errors are kept for the message', async () => {
    const ac = new AbortController();
    const child = ssh.createSshSpawner(HOST, { env })({ command: 'claude', args: [], cwd: tmp, env: {}, signal: ac.signal });
    procs.push(child);
    await lines(child.stdout, 1);
    const exited = new Promise((r) => child.on('exit', (code, sig) => r(sig || code)));
    ac.abort();
    expect(await exited).toBeTruthy();
    expect(typeof child.sshStderr()).toBe('string');
  });
});

describe('a chat on a remote host', () => {
  it('create() keeps the remote folder as typed and starts the engine over ssh', async () => {
    let options = null;
    const fakeSdk = { query: ({ options: o }) => { options = o; return { async *[Symbol.asyncIterator]() { await new Promise(() => {}); }, interrupt() {}, setPermissionMode() {}, close() {} }; } };
    const mgr = new ChatManager({ proxyToken: 't', sdk: fakeSdk });
    const created = await mgr.create({ cwd: '~/projects/app', providerInstance: null, settings: { sandbox: { enabled: true } }, ssh: HOST });
    expect(options.cwd).toBe('~/projects/app');                     // not this machine's home
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
    expect(options.sandbox).toBeUndefined();
    expect(options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(mgr.chats.get(created.id).ssh).toEqual({ id: 'h-1', label: 'build box' });
    mgr.close(created.id);
  });

  it('a local chat is unchanged: ~ expands here, no ssh', async () => {
    let options = null;
    const fakeSdk = { query: ({ options: o }) => { options = o; return { async *[Symbol.asyncIterator]() {}, interrupt() {}, setPermissionMode() {}, close() {} }; } };
    const mgr = new ChatManager({ proxyToken: 't', sdk: fakeSdk });
    const created = await mgr.create({ cwd: '~/x', providerInstance: null, settings: {} });
    expect(options.cwd).toBe(path.join(os.homedir(), 'x'));
    expect(options.spawnClaudeCodeProcess).toBeUndefined();
    mgr.close(created.id);
  });

  it('chat:create takes sshHost as text and nothing else', () => {
    expect(validateArgs('chat:create', { sshHost: 'h-1', cwd: '/srv' })).toBeNull();
    expect(validateArgs('chat:create', { sshHost: 7 })).toMatch(/string/);
  });
});

describe('chat:create with sshHost (the real handler)', () => {
  let handlers = null;
  async function h() {
    if (!handlers) {
      const stub = require('electron');
      stub.__reset();
      process.env.CCE_PROXY_PORT = '0';
      require('../src/main/main.js');
      await new Promise((r) => setTimeout(r, 200));
      handlers = stub.__state.handlers;
    }
    return handlers;
  }

  it('refuses an unknown host, a relative folder, an engine and a worktree, before starting anything', async () => {
    const hs = await h();
    const create = hs.get('chat:create');
    expect((await create(null, { sshHost: 'nope', cwd: '/srv' })).error).toMatch(/unknown SSH host/);
    const saved = await hs.get('sshhosts:save')(null, { host: { host: 'build.example.com', user: 'jack', label: 'build box' } });
    const id = (saved.host && saved.host.id) || saved.id;
    expect(id).toBeTruthy();
    expect((await create(null, { sshHost: id, cwd: 'projects/app' })).error).toMatch(/absolute path/);
    expect((await create(null, { sshHost: id, cwd: '/srv/app', engine: 'codex' })).error).toMatch(/this machine only/);
    expect((await create(null, { sshHost: id, cwd: '/srv/app', worktree: true })).error).toMatch(/worktrees are local/);
  });
});
