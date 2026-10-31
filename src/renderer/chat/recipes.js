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

// Ready-made audits. The last step asks for a graded Markdown report whose first line is a
// fixed title, so keeping it as an artifact makes each later run a new version of the same
// report (and the artifact diff shows what changed). {arg} is what follows the recipe name.
const REPORT = 'Write the result as ONE Markdown report. First line: "# {title}". Then an overall score out of 100 and a letter grade, '
  + 'then the sections Critical, Warnings and Passed. For each finding give what, where, why it matters, how to fix it and how to verify the fix. '
  + 'End with a prioritised action plan of at most 10 items.';
export const BUILTIN_RECIPES = {
  'seo-audit': {
    builtin: true, needsArg: 'a URL', auto: false,
    steps: [
      'Audit the SEO of {arg}. Open the page with the web browser tool if it is available, otherwise use WebFetch. Check the title, meta description, headings, canonical link, structured data, image alt text, internal links, mobile viewport and speed hints. List every finding with its evidence.',
      REPORT.replace('{title}', 'SEO audit: {arg}'),
    ],
  },
  'security-audit': {
    builtin: true, needsArg: '', auto: false,
    steps: [
      'Review {arg} for security problems: injection, unsafe file or shell use, secrets in code, missing input checks, weak defaults and risky dependencies. Read the code; do not change anything. List every finding with file:line evidence.',
      REPORT.replace('{title}', 'Security audit: {arg}'),
    ],
  },
  'a11y-audit': {
    builtin: true, needsArg: '', auto: false,
    steps: [
      'Check the accessibility of {arg} against WCAG 2.2 AA: labels, keyboard use, focus, contrast, headings, alt text and ARIA. Read the code or open the page; do not change anything. List every finding with evidence.',
      REPORT.replace('{title}', 'Accessibility audit: {arg}'),
    ],
  },
};

/** Ready-made recipes plus the user's own (the user's win on a name clash). */
export const allRecipes = (store) => ({ ...BUILTIN_RECIPES, ...loadRecipes(store) });

/** The steps with {arg} filled in; with no argument it names "the current project". */
export const fillSteps = (steps, arg) => steps.map((s) => s.replace(/\{arg\}/g, String(arg || '').trim() || 'the current project'));

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
  // "/recipe seo-audit https://x.com": the first word names the recipe, the rest is its argument.
  if (name && more.length) return { action: 'run', name, head: slug(a), args: more.join(' ') };
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
