// Model routing: pick a model by how big the task looks. Off unless the user
// switches it on, and it never touches a chat whose model was chosen by hand.
// A word-and-size heuristic, not an extra model call: free, instant, testable.

export const DEFAULT_TIERS = { trivial: 'haiku', medium: 'sonnet', heavy: 'opus' };

const HEAVY_WORDS = /\b(refactor|re-?architect|migrate|migration|audit|overhaul|rewrite|across (all|the whole|every)|whole (project|repo|codebase)|entire (project|repo|codebase)|all files|end[- ]to[- ]end|design (a|the) (system|architecture))\b/i;
const TRIVIAL_WORDS = /^(fix (the )?typo|rename|what('s| is| does)|why (is|does)|explain|show me|list|where is|how do i|add a comment|bump|format)\b/i;

/** 'trivial' | 'medium' | 'heavy' */
export function classifyTask(text, { images = 0 } = {}) {
  const s = String(text || '').trim();
  if (!s) return 'medium';
  const steps = (s.match(/^\s*(\d+[.)]|[-*])\s+/gm) || []).length;
  if (s.length > 1200 || steps >= 4 || HEAVY_WORDS.test(s)) return 'heavy';
  const fenced = s.includes('```');
  if (!fenced && !images && s.length <= 120 && (TRIVIAL_WORDS.test(s) || s.length <= 40)) return 'trivial';
  return 'medium';
}

/**
 * The model to use for this message, or null to leave the chat alone.
 * @param {{enabled?:boolean,tiers?:{trivial?:string,medium?:string,heavy?:string}}} cfg
 */
export function routeFor(cfg, chat, text, { images = 0 } = {}) {
  if (!cfg || !cfg.enabled || !chat) return null;
  if (chat.model) return null;                              // pinned by the user
  if (chat.provider || (chat.engine && chat.engine !== 'claude')) return null;   // aliases only mean something to the Claude account
  if (String(text || '').trim().startsWith('/')) return null;
  const tiers = { ...DEFAULT_TIERS, ...(cfg.tiers || {}) };
  return tiers[classifyTask(text, { images })] || null;
}
