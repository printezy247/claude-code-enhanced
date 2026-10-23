// CCE's own "auto" permission policy for providers that are not Anthropic's API.
//
// The engine's auto mode relies on a second Claude model to review each action,
// which fails against other providers. For those, "auto" runs the engine in
// accept-edits mode (file edits in the folder already run unasked) and this
// policy additionally approves what is plainly safe: read-only inspection and
// the project's own test / lint / build commands. Everything else still asks.
//
// The shell check is deliberately conservative: a command is approved only when
// every part of it is on the list, and anything that could redirect, chain
// through a subshell, run another program (find -exec, rg --pre, sed -i...) or
// touch credential files is refused (so the user is asked instead).
'use strict';

const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ToolSearch',
]);

/** Commands that only read: first word -> flags that make them unsafe. */
const READ_ONLY = {
  ls: [], cat: [], head: [], tail: [], wc: [], pwd: [], echo: [], which: [], whoami: [], date: [], uname: [],
  stat: [], file: [], du: [], df: [], tree: [], uniq: [], cut: [], basename: [], dirname: [], diff: [],
  realpath: [], printf: [], true: [], id: [], hostname: [], nproc: [],
  grep: [], egrep: [], fgrep: [],
  rg: ['--pre', '--pre-glob', '--hostname-bin'],
  sort: ['-o', '--output', '--compress-program'],
  find: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'],
};

/** git subcommands that never write. */
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'rev-list', 'cat-file', 'ls-tree', 'merge-base', 'name-rev']);
const GIT_UNSAFE_FLAG = /^(--output|--exec|--upload-pack|--receive-pack|-o$)/;

/** Project scripts: runner -> allowed script names / subcommands. */
const RUNNERS = {
  npm: { sub: ['test', 't'], run: ['test', 'lint', 'typecheck', 'check', 'build', 'format:check', 'test:unit'] },
  pnpm: { sub: ['test'], run: ['test', 'lint', 'typecheck', 'check', 'build', 'format:check'] },
  yarn: { sub: ['test'], run: ['test', 'lint', 'typecheck', 'check', 'build', 'format:check'] },
  cargo: { sub: ['check', 'test', 'clippy', 'fmt', 'build'], flagsBad: ['--', 'install'] },
  go: { sub: ['test', 'vet', 'build', 'fmt'] },
  make: { sub: ['test', 'check', 'lint'] },
  pytest: { any: true }, vitest: { sub: ['run'] }, jest: { any: true },
};

const SENSITIVE = /(^|[/\s])(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.env(\.\w+)?|id_rsa|id_ed25519|credentials|shadow)(\b|$)/i;
/** Anything that redirects, substitutes, backgrounds (a lone &) or spans lines. */
const FORBIDDEN_SHELL = /[`<>&\n\r]|\$\(|\$\{|\$[A-Za-z_]/;

function segmentIsSafe(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const cmd = tokens[0];
  const rest = tokens.slice(1);
  if (SENSITIVE.test(segment)) return false;

  if (Object.prototype.hasOwnProperty.call(READ_ONLY, cmd)) {
    const bad = READ_ONLY[cmd];
    return !rest.some((t) => bad.some((b) => t === b || t.startsWith(b + '=')));
  }
  if (cmd === 'git') {
    const sub = rest[0];
    if (!sub || sub.startsWith('-') || !GIT_READ.has(sub)) {
      // `git branch` / `git remote -v` / `git tag` with no write flags
      if (sub === 'branch') return rest.slice(1).every((t) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes'].includes(t));
      if (sub === 'remote') return rest.slice(1).every((t) => t === '-v');
      return false;
    }
    return !rest.slice(1).some((t) => GIT_UNSAFE_FLAG.test(t));
  }
  if (['node', 'python', 'python3', 'npm'].includes(cmd) && rest.length === 1 && /^(-v|--version|-V)$/.test(rest[0])) return true;
  if (cmd === 'npx') {
    return (rest[0] === 'vitest' && rest[1] === 'run') || (rest[0] === 'tsc' && rest.includes('--noEmit'));
  }
  if (cmd === 'tsc') return rest.includes('--noEmit');
  const runner = RUNNERS[cmd];
  if (runner) {
    if (runner.any) return !rest.some((t) => /^(--rootdir|--basetemp)/.test(t));
    const sub = rest[0];
    if (!sub) return false;
    if (runner.run && sub === 'run') return runner.run.includes(rest[1]) && !rest.includes('--');
    if (runner.sub && runner.sub.includes(sub)) return !(runner.flagsBad || []).some((b) => rest.slice(1).includes(b));
  }
  return false;
}

/** True when a whole shell command line is read-only / a plain project check. */
function isSafeBash(command) {
  const line = String(command || '').trim();
  if (!line || line.length > 400) return false;
  // `&&` chains are allowed (each part is checked); any other `&` is not.
  if (FORBIDDEN_SHELL.test(line.replace(/&&/g, ';'))) return false;
  // Split on the operators that chain commands; every part must be safe.
  return line.split(/\|\||&&|;|\|/).every(segmentIsSafe);
}

/** Should CCE's auto policy approve this tool call without asking? */
function autoAllows(toolName, input) {
  if (SAFE_TOOLS.has(toolName)) return true;
  if (toolName === 'Bash') return isSafeBash(input && input.command);
  return false;
}

module.exports = { autoAllows, isSafeBash, SAFE_TOOLS };
