// Which CCE provider models a CLI can run, for the New session modal. Pure,
// so it is tested without a DOM. Claude takes every provider; Codex and
// OpenCode reach any provider with a base URL through CCE's local proxy (it
// translates to the provider's dialect); Antigravity only its own login. The
// Claude login itself has no base URL to hand to another CLI.

// The CLI choices come from the engine list the main process detects
// (engines.js REGISTRY), so a new engine needs no change here.
const CLAUDE_CHAT = { id: 'claude', label: 'Claude Code' };
export const chatClis = (engineList) => [
  CLAUDE_CHAT,
  ...(engineList || []).map((e) => ({ id: e.id, label: e.label.replace(/ CLI$/, ''), engine: e.id })),
];
export const terminalClis = (engineList) => [
  { id: 'claude', label: 'claude TUI' },
  ...(engineList || []).map((e) => ({ id: e.id, label: e.bin + ' TUI', engine: e.id })),
  { id: 'shell', label: 'shell' },
];

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
export function modelGroups(cli, providers, engineList = []) {
  const out = [];
  const engine = engineList.find((e) => e.id === cli);
  const canRun = (p) => cli === 'claude' || (!!engine && engine.providers && !!p.baseUrl);
  for (const p of providers || []) {
    if (!p || !canRun(p)) continue;
    const models = modelsOf(p);
    if (cli === 'claude') models.unshift('');
    if (models.length) out.push({ provider: { uid: p.uid, name: p.name || p.uid }, models });
  }
  return out;
}
