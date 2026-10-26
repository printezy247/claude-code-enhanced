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

/**
 * Files that hold a secret. Matched against shell text and against the paths
 * the read tools are given, so a credential cannot be read by a tool the
 * policy approves without asking.
 */
const SENSITIVE = new RegExp([
  // a name, wherever it sits in a path
  '(^|[/\\s"\'=])(\\.ssh|\\.aws|\\.gnupg|\\.netrc|\\.npmrc|\\.pypirc|\\.pgpass|\\.my\\.cnf|\\.git-credentials|\\.vault-token|\\.azure|\\.kube|\\.env(\\.\\w+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|shadow|\\.bash_history|\\.zsh_history)(\\b|$)',
  // a folder that holds credentials, under .config or .local/share
  '(^|[/\\s"\'=])\\.config/(gh|gcloud|op|hub|glab-cli|doctl|heroku|rclone|git/credentials)(/|\\s|$|["\'])',
  '(^|[/\\s"\'=])\\.docker/config\\.json',
  '(^|[/\\s"\'=])\\.local/share/keyrings',
  '(^|[/\\s"\'=])\\.terraform\\.d/credentials',
  // a key or certificate file by extension
  '\\.(pem|key|p12|pfx|jks|keystore|kdbx)(\\s|$|["\'])',
  // the process environment
  '/proc/[^/\\s]+/environ',
].join('|'), 'i');

/** True when a path or shell text names a credential file. */
function isSensitivePath(text) {
  return SENSITIVE.test(String(text || ''));
}
/** Anything that redirects, substitutes, backgrounds (a lone &) or spans lines. */
const FORBIDDEN_SHELL = /[`<>&\n\r]|\$\(|\$\{|\$[A-Za-z_]/;

/** Short-flag clusters: does `-aLo` carry the letter? (`--long` options never match.) */
const hasShort = (tok, letters) => new RegExp('^-(?!-)[A-Za-z]*[' + letters + ']').test(tok);

/**
 * Per-command checks for read-only commands that still write or hang with the
 * wrong arguments. Each returns true when the call is NOT safe.
 */
const UNSAFE_ARGS = {
  // `uniq in out` writes `out`.
  uniq: (rest) => rest.filter((t) => !t.startsWith('-')).length > 1,
  // `tree -o file` writes the listing to a file.
  tree: (rest) => rest.some((t) => hasShort(t, 'o') || t === '--output' || t.startsWith('--output=')),
  // `tail -f` never ends and hangs the turn.
  tail: (rest) => rest.some((t) => hasShort(t, 'fF') || /^--(follow|retry)\b/.test(t)),
  // `file -C` compiles a magic file, writing it next to the source.
  file: (rest) => rest.some((t) => hasShort(t, 'C') || t === '--compile'),
  // `date 010112002026` and `date -s` set the clock: only formats and zone flags are plain reads.
  date: (rest) => rest.some((t) => !(/^\+/.test(t) || /^(-u|-R|--utc|--universal|--rfc-email)$/.test(t) || /^(-I(date|hours|minutes|seconds|ns)?|--iso-8601(=\w+)?)$/.test(t))),
  // `hostname name` renames the machine.
  hostname: (rest) => rest.some((t) => !/^(-f|-s|-d|-i|-I|-A|-a|-y|--fqdn|--short|--domain|--ip-address|--all-ip-addresses|--all-fqdns|--alias|--yp|--nis)$/.test(t)),
};


/* ---------------- medium tier: project-local work ---------------- */

/** A path argument that stays inside the working folder: relative, no `..`, no `~`, not a flag. */
function isLocalPath(tok, cwd) {
  if (!tok || tok.startsWith('-') || tok.startsWith('~') || /["'*?]/.test(tok)) return false;
  if (tok.split('/').includes('..')) return false;
  if (tok.startsWith('/')) return !!cwd && (tok === cwd || tok.startsWith(cwd.replace(/\/$/, '') + '/'));
  return true;
}

const SCRIPT_FILE = /\.(js|mjs|cjs|py)$/;

/**
 * Commands that change files or run project code, but only inside the working
 * folder. Nothing here pushes, installs a named package, rewrites history or
 * reads a secret. Returns true when the segment is a plain local step.
 */
function segmentIsLocal(segment, cwd) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const cmd = tokens[0];
  const rest = tokens.slice(1);
  if (!cmd || SENSITIVE.test(segment)) return false;
  if (cmd === 'mkdir') {
    const paths = rest.filter((t) => t !== '-p');
    return paths.length > 0 && paths.every((t) => isLocalPath(t, cwd));
  }
  if (cmd === 'touch') return rest.length > 0 && rest.every((t) => isLocalPath(t, cwd));
  if (cmd === 'cp' || cmd === 'mv') return rest.length === 2 && rest.every((t) => isLocalPath(t, cwd));
  if (cmd === 'npm') return rest.length === 1 && (rest[0] === 'ci' || rest[0] === 'install');
  if (cmd === 'git') {
    if (rest[0] === 'add') {
      const paths = rest.slice(1);
      // No -A, -u or "." : they would stage secrets or unrelated files unseen.
      return paths.length > 0 && paths.every((t) => isLocalPath(t, cwd) && t !== '.' && t !== './');
    }
    if (rest[0] === 'commit') {
      // `-m "msg"` only: no amend, no hook skipping. The quoted message splits on spaces, so check the flags.
      return rest[1] === '-m' && !rest.some((t) => /^--(amend|no-verify|no-gpg-sign)/.test(t) || t === '-n' || t === '-a');
    }
    return false;
  }
  if (cmd === 'node' || cmd === 'python' || cmd === 'python3') {
    return SCRIPT_FILE.test(rest[0] || '') && isLocalPath(rest[0], cwd) && !/^(-e|-c|--eval|--print)/.test(rest[0]);
  }
  return false;
}

function segmentIsSafe(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const cmd = tokens[0];
  const rest = tokens.slice(1);
  if (SENSITIVE.test(segment)) return false;

  if (Object.prototype.hasOwnProperty.call(READ_ONLY, cmd)) {
    const bad = READ_ONLY[cmd];
    if (rest.some((t) => bad.some((b) => t === b || t.startsWith(b + '=')))) return false;
    return !(UNSAFE_ARGS[cmd] && UNSAFE_ARGS[cmd](rest));
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
function isSafeBash(command, opts = {}) {
  const line = String(command || '').trim();
  if (!line || line.length > 400) return false;
  // `&&` chains are allowed (each part is checked); any other `&` is not.
  if (FORBIDDEN_SHELL.test(line.replace(/&&/g, ';'))) return false;
  // Split on the operators that chain commands; every part must be safe.
  const medium = !!(opts && opts.cwd);
  return line.split(/\|\||&&|;|\|/).every((seg) => segmentIsSafe(seg) || (medium && segmentIsLocal(seg, opts.cwd)));
}

/** Should CCE's auto policy approve this tool call without asking? */
function autoAllows(toolName, input, opts = {}) {
  if (SAFE_TOOLS.has(toolName)) {
    // A read tool pointed at a credential file is not plain inspection.
    const i = input || {};
    return !(isSensitivePath(i.file_path) || isSensitivePath(i.path) || isSensitivePath(i.pattern) || isSensitivePath(i.glob));
  }
  if (toolName === 'Bash') return isSafeBash(input && input.command, opts);
  return false;
}

module.exports = { autoAllows, isSafeBash, isSensitivePath, SAFE_TOOLS };
