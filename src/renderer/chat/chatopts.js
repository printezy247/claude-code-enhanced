// Per-chat engine options: the output style and extra environment variables.
// Values of variables stay in memory (they may be secrets); only names are remembered.

export const OUTPUT_STYLES = [
  { id: '', label: 'Default' },
  { id: 'Explanatory', label: 'Explanatory' },
  { id: 'Learning', label: 'Learning' },
];

// These change how the engine process itself starts or which program it runs.
const BLOCKED = /^(PATH|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|NODE_PATH|SHELL|HOME|PYTHONPATH|ELECTRON_[A-Z_]+|CLAUDE_CODE_[A-Z_]+|ANTHROPIC_(BASE_URL|AUTH_TOKEN|API_KEY))$/;

/** "NAME=value" lines to { env, errors:[{line,message}] }. */
export function parseEnv(text) {
  const env = {};
  const errors = [];
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    const name = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { errors.push({ line: i + 1, message: 'not NAME=value' }); return; }
    if (BLOCKED.test(name)) { errors.push({ line: i + 1, message: name + ' cannot be set here' }); return; }
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    env[name] = value;
  });
  return { env, errors };
}

/** Names only, safe to show or log. */
export function redactEnv(env) {
  return Object.keys(env || {}).map((k) => k + '=•••').join(', ');
}

/** The chat's variables win over the global ones. */
export function mergeEnv(globalEnv, chatEnv) {
  return { ...(globalEnv || {}), ...(chatEnv || {}) };
}
