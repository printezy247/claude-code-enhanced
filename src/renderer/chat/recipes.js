// Recipes: a saved chain of prompts (build, review, fix) run one step per turn.
// Stored in localStorage under a cce. key, so Export settings carries them.
const KEY = 'cce.recipes';
export const MAX_STEPS = 8;
const MAX_STEP_CHARS = 4000;

/** Split text into steps on lines of ---. A first line of "auto" skips the pause between steps. */
export function parseSteps(text) {
  let parts = String(text || '').split(/^\s*---\s*$/m).map((s) => s.trim());
  let auto = false;
  if (parts[0] && /^auto(\s*\n|$)/i.test(parts[0])) { auto = true; parts[0] = parts[0].replace(/^auto\s*/i, '').trim(); }
  parts = parts.filter(Boolean);
  if (!parts.length) return { error: 'A recipe needs at least one step.' };
  if (parts.length > MAX_STEPS) return { error: 'A recipe can have at most ' + MAX_STEPS + ' steps.' };
  return { auto, steps: parts.map((s) => s.slice(0, MAX_STEP_CHARS)) };
}

const slug = (name) => String(name || '').toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

export function loadRecipes(store) {
  try { const v = JSON.parse(store.getItem(KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
const put = (store, all) => { try { store.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ } };

export function saveRecipe(store, name, text) {
  const id = slug(name);
  if (!id) return { ok: false, error: 'Give the recipe a name (letters, numbers, - or _).' };
  const p = parseSteps(text);
  if (p.error) return { ok: false, error: p.error };
  const all = loadRecipes(store);
  all[id] = { auto: p.auto, steps: p.steps };
  put(store, all);
  return { ok: true, name: id, steps: p.steps.length };
}

export function deleteRecipe(store, name) {
  const all = loadRecipes(store);
  const id = slug(name);
  if (!(id in all)) return false;
  delete all[id];
  put(store, all);
  return true;
}

export function parseRecipeCmd(text) {
  const rest = String(text || '').replace(/^\/recipe\b/, '').trim();
  if (!rest) return { action: 'list' };
  const [a, ...more] = rest.split(/\s+/);
  if (a === 'save' || a === 'delete') {
    const name = slug(more.join(' '));
    return name ? { action: a, name } : { error: 'Use /recipe ' + a + ' <name>.' };
  }
  const name = slug(rest);
  return name ? { action: 'run', name } : { error: 'Use /recipe, /recipe <name>, /recipe save <name> or /recipe delete <name>.' };
}

/**
 * After a turn: the next step. { prompt } goes on at once (auto), { pause }
 * waits for the user, null means the recipe is over. A stop or error ends it.
 */
export function recipeAfterTurn(chat, { stopped = false, error = false } = {}) {
  const r = chat && chat.recipe;
  if (!r) return null;
  if (stopped || error || r.i + 1 >= r.steps.length) { chat.recipe = null; return null; }
  r.i += 1;
  const step = { prompt: r.steps[r.i], n: r.i + 1, of: r.steps.length };
  return r.auto ? step : { pause: step };
}
