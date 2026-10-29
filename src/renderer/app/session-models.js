// Which CCE provider models a CLI can run, for the New session modal. Pure,
// so it is tested without a DOM. Claude takes every provider; Codex and
// OpenCode reach any provider with a base URL through CCE's local proxy (it
// translates to the provider's dialect); Antigravity only its own login. The
// Claude login itself has no base URL to hand to another CLI.

export const CHAT_CLIS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex', engine: 'codex' },
  { id: 'opencode', label: 'OpenCode', engine: 'opencode' },
  { id: 'antigravity', label: 'Antigravity', engine: 'antigravity' },
];
export const TERMINAL_CLIS = [
  { id: 'claude', label: 'claude TUI' },
  { id: 'codex', label: 'codex TUI', engine: 'codex' },
  { id: 'opencode', label: 'opencode TUI', engine: 'opencode' },
  { id: 'antigravity', label: 'antigravity TUI (agy)', engine: 'antigravity' },
  { id: 'shell', label: 'shell' },
];

function canRun(cli, p) {
  if (cli === 'claude') return true;
  if (cli === 'codex' || cli === 'opencode') return !!p.baseUrl;
  return false;
}

function modelsOf(p) {
  const ids = [p.model, ...(p.whitelist || []), ...(p.models || [])]
    .map((m) => (m && typeof m === 'object' ? m.id : m))
    .filter((m) => typeof m === 'string' && m.trim());
  return [...new Set(ids)];
}

/**
 * Groups for the Model dropdown: [{ provider: {uid, name}, models: [id] }].
 * "CLI default" is not in the list; the modal adds it first. Claude also gets
 * a "provider default" entry ('' model) per provider; other CLIs need a model.
 */
export function modelGroups(cli, providers) {
  const out = [];
  for (const p of providers || []) {
    if (!p || !canRun(cli, p)) continue;
    const models = modelsOf(p);
    if (cli === 'claude') models.unshift('');
    if (models.length) out.push({ provider: { uid: p.uid, name: p.name || p.uid }, models });
  }
  return out;
}
