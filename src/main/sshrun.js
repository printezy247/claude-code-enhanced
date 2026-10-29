// Run Claude Code on another machine over SSH, for a chat tab.
//
// The Agent SDK lets the host decide how the engine process is started
// (`spawnClaudeCodeProcess`). Here that is `ssh -T host 'cd <dir> && exec
// claude <flags>'`: the stream-json conversation passes through ssh's stdin and
// stdout unchanged, so approvals, interrupts and the in-process connector tools
// work as they do locally.
//
// What stays local on purpose: provider keys and the CCE proxy (nothing from
// the local environment is sent to the remote), the Bubblewrap sandbox, plugin
// folders and stdio MCP servers (their paths and commands are this machine's).
// The remote runs with its own login, settings and connectors.
'use strict';
const { spawn } = require('child_process');
const { sshArgs } = require('./sshhosts');

/** POSIX single-quote: safe for any bytes, including quotes and newlines. */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// The remote executable: a name or an absolute path, nothing a shell would reinterpret.
const REMOTE_BIN_RE = /^\/?[A-Za-z0-9_][A-Za-z0-9_./+-]*$/;

/** `cd <dir> && ` for the remote shell; a leading ~ is left unquoted so the remote shell expands it. */
function cdPart(cwd) {
  const dir = String(cwd || '');
  if (!dir) return '';
  if (dir === '~') return 'cd ~ && ';
  if (dir.startsWith('~/')) return 'cd ~/' + shq(dir.slice(2)) + ' && ';
  return 'cd ' + shq(dir) + ' && ';
}

/**
 * The one string the remote shell runs. The command is checked, every other
 * token is quoted, so a flag or a folder name cannot add a second command.
 */
function remoteCommand({ command = 'claude', args = [], cwd } = {}) {
  if (!REMOTE_BIN_RE.test(String(command))) throw new Error('invalid remote command: ' + JSON.stringify(command));
  return cdPart(cwd) + 'exec ' + [command, ...args.map(String)].map((t, i) => (i === 0 ? t : shq(t))).join(' ');
}

/** `ssh` argv: no terminal, never ask for a password (there is nobody to type it), the host's own options. */
function sshCommand(host, spec) {
  return {
    command: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...sshArgs(host), remoteCommand(spec)],
  };
}

/** Only what ssh itself needs: not the provider keys or tokens the local app holds. */
function minimalEnv(env = process.env) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'XDG_RUNTIME_DIR'];
  const out = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/**
 * The function to give the SDK as `spawnClaudeCodeProcess`. A ChildProcess
 * already has the shape the SDK wants (stdin, stdout, killed, exitCode, on).
 * ssh's stderr is kept for the error the SDK shows when the process dies, so
 * "Permission denied (publickey)" reaches the user instead of a silent exit.
 */
function createSshSpawner(host, { spawnFn = spawn, remoteClaude = 'claude', env = process.env, onStderr } = {}) {
  return (options = {}) => {
    const { command, args } = sshCommand(host, { command: host.claudePath || remoteClaude, args: options.args || [], cwd: options.cwd });
    const child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: minimalEnv(env) });
    let tail = '';
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        tail = (tail + d).slice(-2000);
        if (onStderr) onStderr(String(d));
      });
    }
    child.sshStderr = () => tail;
    if (options.signal) {
      const stop = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
      if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
    }
    return child;
  };
}

/**
 * The SDK options for a chat on a remote machine: the same options with what
 * only makes sense locally taken out, and the process started over ssh.
 * Changes `options` in place and returns it.
 */
function remoteOptions(options, host, deps = {}) {
  const out = options;
  delete out.sandbox;
  delete out.plugins;
  delete out.pathToClaudeCodeExecutable;
  // Local providers and proxy: the remote uses its own login.
  out.env = minimalEnv(deps.env || process.env);
  if (out.mcpServers) {
    // In-process servers (the host connector broker) run here and are reached
    // through the control stream; the codebase index reads this machine's disk,
    // and stdio/http servers named in local config belong to this machine.
    const keep = {};
    for (const [name, cfg] of Object.entries(out.mcpServers)) {
      if (cfg && cfg.type === 'sdk' && name !== 'cce_index') keep[name] = cfg;
    }
    out.mcpServers = keep;
  }
  out.spawnClaudeCodeProcess = createSshSpawner(host, deps);
  return out;
}

module.exports = { shq, remoteCommand, sshCommand, minimalEnv, createSshSpawner, remoteOptions, cdPart, REMOTE_BIN_RE };
