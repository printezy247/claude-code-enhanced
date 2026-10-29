// Which CCE provider models a CLI can run, for the New session modal. Pure,
// so it is tested without a DOM. Claude takes every provider (the proxy
// translates); Codex an OpenAI-format endpoint; OpenCode an OpenAI-format or
// Anthropic one; Antigravity only its own login. Providers without a base URL
// (the Claude login itself) or with an OAuth login cannot be handed to
// another CLI.

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
  if (!p.baseUrl || p.authKind === 'oauth' || p.authKind === 'device-code') return false;
  const proto = p.protocol || 'openai';
  if (cli === 'codex') return proto === 'openai' || proto === 'responses';
  if (cli === 'opencode') return proto === 'openai' || proto === 'responses' || proto === 'anthropic';
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
