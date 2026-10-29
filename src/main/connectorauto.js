// Connectors that switch themselves.
//
// Every connector stays connected. What changes, per chat, is which ones the
// model is shown: with tool search the model sees names only and loads a
// definition when it asks for one, so an idle connector costs almost nothing;
// without it (a small context window, a provider that cannot search) CCE
// scores each connector against the message and shows only the relevant few.
//
// This file is the decision logic only: scoring, per-project memory, duplicate
// detection, the user's Auto / Always on / Off choices, reconnect delays. It
// touches no engine and no disk, so each rule can be tested on its own.
'use strict';

const MODES = ['auto', 'on', 'off'];
const MAX_PROJECTS = 60;
const MAX_SERVERS = 120;
const MAX_COUNT = 100000;

/** The server a connector tool belongs to: `mcp__github__list_issues` -> `github`. */
function serverOf(toolName) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(toolName || ''));
  return m ? m[1] : '';
}

const STOP = new Set(('the and for with that this from have has had you your are was were what when where which who how why can could ' +
  'would should will just into out over under about please make get let use using need want show tell give find new all any some more ' +
  'then than them they their there here also but not our its one two').split(' '));

/** Lower-case words of a text, camelCase / snake_case / kebab-case split, stop words dropped. */
function words(text) {
  const spaced = String(text == null ? '' : text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./:@#]+/g, ' ')
    .toLowerCase();
  const out = new Set();
  for (const w of spaced.split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
    // Plural / gerund: "issues" matches "issue", "searching" matches "search".
    if (w.length > 4 && w.endsWith('s')) out.add(w.slice(0, -1));
    if (w.length > 5 && w.endsWith('ing')) out.add(w.slice(0, -3));
  }
  return out;
}

/**
 * Words that mean a well-known connector, when the user does not say its name.
 * Only words that point at the service. "error", "message", "thread", "doc"
 * and "workflow" turn up in ordinary coding prompts and used to switch on
 * Sentry, Slack, Notion or GitHub for no reason.
 */
const TOPICS = {
  github: ['git', 'ops', 'pull', 'request', 'merge', 'commit', 'push', 'branch', 'repo', 'repository', 'issue', 'issues', 'release', 'actions'],
  gitlab: ['git', 'ops', 'merge', 'commit', 'push', 'branch', 'repo', 'repository', 'issue', 'issues', 'pipeline'],
  linear: ['ticket', 'tickets', 'sprint', 'backlog'],
  sentry: ['crash', 'crashes', 'stacktrace', 'exception'],
  slack: ['channel', 'channels'],
  notion: ['wiki'],
};

/**
 * How well one connector fits what the user just asked.
 *
 * @param {{name: string, tools?: Array<{name: string, description?: string}>}} server
 * @param {Set<string>} want            words(prompt)
 * @param {{projectUses?: number, chatUses?: number, recent?: boolean}} [history]
 */
function scoreServer(server, want, history = {}) {
  let score = 0;
  const nameWords = words(server.name);
  for (const w of nameWords) if (want.has(w)) score += 6;
  // A switched-off connector has no tool list, so its name is all there is to
  // go on. "git ops" never says "github": the topic words stand in for it.
  const aliased = new Set();
  for (const w of nameWords) for (const a of TOPICS[w] || []) aliased.add(a);
  for (const a of aliased) if (want.has(a)) { score += 6; break; }
  let toolHits = 0;
  let descHits = 0;
  for (const t of server.tools || []) {
    const tw = words(t.name);
    for (const w of tw) if (want.has(w)) toolHits++;
    for (const w of words(t.description || '')) if (want.has(w)) descHits++;
  }
  score += Math.min(12, toolHits * 3);
  score += Math.min(6, descHits);
  // Where the user has used this connector before, in this project.
  const pu = Math.max(0, Number(history.projectUses) || 0);
  if (pu > 0) score += Math.min(6, Math.log2(1 + pu) * 1.5);
  // Where this chat has used it: a conversation about a repo keeps going.
  if (Number(history.chatUses) > 0) score += 3;
  if (history.recent) score += 3;
  return Math.round(score * 100) / 100;
}

/** How many tools to show at once, from the model's window. 0 = no limit. */
function toolBudgetFor(contextTokens, toolSearchOn) {
  const ctx = Number(contextTokens) || 0;
  if (ctx > 0 && ctx < 32_000) return 12;
  if (ctx > 0 && ctx < 64_000) return 25;
  if (ctx > 0 && ctx < 128_000) return 45;
  return toolSearchOn ? 0 : 80;
}

/** Does this chat need CCE to choose connectors, rather than leaving them all on? */
function needsPick({ contextTokens, toolSearchOn, setting = 'auto' } = {}) {
  if (setting === 'off') return false;
  if (setting === 'always') return true;
  const ctx = Number(contextTokens) || 0;
  return (ctx > 0 && ctx < 128_000) || !toolSearchOn;
}

/* ---------------- the user's choices ---------------- */

/**
 * Clean `{ global: {name: mode}, projects: {cwd: {name: mode}} }` from whatever
 * was stored: unknown modes dropped, 'auto' not stored (it is the default),
 * sizes bounded.
 */
function normalizeModes(raw) {
  const clean = (o) => {
    const out = {};
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    for (const [name, mode] of Object.entries(o)) {
      if (Object.keys(out).length >= MAX_SERVERS) break;
      if (typeof name === 'string' && name && (mode === 'on' || mode === 'off')) out[name.slice(0, 200)] = mode;
    }
    return out;
  };
  const r = raw && typeof raw === 'object' ? raw : {};
  const projects = {};
  if (r.projects && typeof r.projects === 'object' && !Array.isArray(r.projects)) {
    for (const [cwd, m] of Object.entries(r.projects)) {
      if (Object.keys(projects).length >= MAX_PROJECTS) break;
      const c = clean(m);
      if (cwd && Object.keys(c).length) projects[String(cwd).slice(0, 500)] = c;
    }
  }
  return { global: clean(r.global), projects };
}

/** The mode for one connector in one project: the project's choice, else the global one, else auto. */
function modeFor(modes, cwd, name) {
  const m = normalizeModes(modes);
  return (m.projects[cwd] && m.projects[cwd][name]) || m.global[name] || 'auto';
}

/** Set one connector's mode at a scope ('global' or a folder); 'auto' removes the entry. Returns new modes. */
function setMode(modes, scope, name, mode) {
  const m = normalizeModes(modes);
  if (!MODES.includes(mode) || !name) return m;
  const bucket = scope === 'global' ? m.global : (m.projects[scope] = m.projects[scope] || {});
  if (mode === 'auto') delete bucket[name]; else bucket[name] = mode;
  if (scope !== 'global' && !Object.keys(bucket).length) delete m.projects[scope];
  return normalizeModes(m);
}

/* ---------------- per-project memory ---------------- */

/** New usage record with one more use of `server` in `cwd`. Pure; bounded in projects, servers and count. */
function recordUse(usage, cwd, server) {
  if (!cwd || !server) return usage || {};
  const next = { ...(usage || {}) };
  const proj = { ...(next[cwd] || {}) };
  proj[server] = Math.min(MAX_COUNT, (proj[server] || 0) + 1);
  // Keep the busiest servers when a project has too many.
  const keep = Object.entries(proj).sort((a, b) => b[1] - a[1]).slice(0, MAX_SERVERS);
  next[cwd] = Object.fromEntries(keep);
  const cwds = Object.keys(next);
  if (cwds.length > MAX_PROJECTS) {
    // Drop the project with the least use overall, never the one just used.
    const total = (c) => Object.values(next[c]).reduce((a, b) => a + b, 0);
    const victim = cwds.filter((c) => c !== cwd).sort((a, b) => total(a) - total(b))[0];
    if (victim) delete next[victim];
  }
  return next;
}

/** Clean a stored usage record. */
function normalizeUsage(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [cwd, servers] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_PROJECTS) break;
    if (!cwd || !servers || typeof servers !== 'object') continue;
    const row = {};
    for (const [s, n] of Object.entries(servers)) {
      const c = Math.floor(Number(n));
      if (s && c > 0 && Object.keys(row).length < MAX_SERVERS) row[s] = Math.min(MAX_COUNT, c);
    }
    if (Object.keys(row).length) out[cwd] = row;
  }
  return out;
}

/* ---------------- duplicates ---------------- */

/**
 * Pairs of connectors that are, in effect, the same one registered twice (a
 * user-level and a project-level copy, a plugin and a hand-added server). Two
 * servers that merely share a generic tool name such as `search` are not
 * duplicates: their tools are namespaced by server and stay distinct.
 *
 * @returns {Array<{a: string, b: string, shared: string[]}>}
 */
function duplicatePairs(servers) {
  const live = (servers || []).filter((s) => s && (s.tools || []).length);
  const pairs = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = new Set(live[i].tools.map((t) => t.name));
      const shared = live[j].tools.map((t) => t.name).filter((n) => a.has(n));
      const smaller = Math.min(live[i].tools.length, live[j].tools.length);
      if (shared.length >= 2 && shared.length / smaller >= 0.5) pairs.push({ a: live[i].name, b: live[j].name, shared });
    }
  }
  return pairs;
}

/* ---------------- the decision ---------------- */

/**
 * Which connectors to show and which to hide for one message.
 *
 * Rules, in order: a connector set to Off is hidden, one set to On is shown and
 * never dropped; of a duplicate pair the better fit is kept; when picking is
 * active the best fits are shown until the tool budget is spent, and a
 * connector this chat used a moment ago is kept so a conversation does not
 * lose its tools mid-thought.
 *
 * @param {object} p
 * @param {Array} p.servers          {name, status, tools}
 * @param {string} p.prompt
 * @param {string} p.cwd
 * @param {object} [p.modes]         normalizeModes() shape
 * @param {object} [p.projectUsage]  {server: count} for this project
 * @param {object} [p.chatUses]      {server: count} for this chat
 * @param {Set<string>|string[]} [p.recent] servers used in the last few turns
 * @param {boolean} [p.pick]         picking is active
 * @param {number} [p.toolBudget]    0 = no limit
 * @param {Set<string>|string[]} [p.sticky] servers picked as relevant for the last messages
 * @returns {{show: Set<string>, hide: Set<string>, scores: Object<string, number>, why: Object<string, string>}}
 */
function plan({ servers, prompt = '', cwd = '', modes = null, projectUsage = {}, chatUses = {}, recent = [], pick = false, toolBudget = 0, sticky = [] }) {
  const want = words(prompt);
  const recentSet = new Set(recent || []);
  // "Plan it" picks Linear, "go ahead" says nothing about Linear: a connector
  // picked a message ago stays relevant for the follow-up.
  const stickySet = new Set(sticky || []);
  // Only a connector that is up (or that we switched off ourselves) can be switched.
  const switchable = (servers || []).filter((s) => s && (s.status === 'connected' || s.status === 'disabled'));
  const scores = {};
  const why = {};
  for (const s of switchable) {
    scores[s.name] = scoreServer(s, want, { projectUses: projectUsage[s.name], chatUses: chatUses[s.name], recent: recentSet.has(s.name) })
      + (stickySet.has(s.name) ? 2 : 0);
  }
  const show = new Set();
  const hide = new Set();
  const pinnedOn = new Set();
  for (const s of switchable) {
    const mode = modeFor(modes, cwd, s.name);
    if (mode === 'off') { hide.add(s.name); why[s.name] = 'off'; }
    else if (mode === 'on') { show.add(s.name); pinnedOn.add(s.name); why[s.name] = 'pinned'; }
  }
  // Duplicates: keep the better fit (then the more used one), unless the other is pinned on.
  const best = (x, y) => (scores[x] - scores[y]) || ((projectUsage[x] || 0) - (projectUsage[y] || 0)) || (x < y ? 1 : -1);
  for (const d of duplicatePairs(switchable)) {
    if (hide.has(d.a) || hide.has(d.b)) continue;
    const keep = pinnedOn.has(d.a) ? d.a : pinnedOn.has(d.b) ? d.b : (best(d.a, d.b) >= 0 ? d.a : d.b);
    const drop = keep === d.a ? d.b : d.a;
    if (pinnedOn.has(drop)) continue;
    hide.add(drop);
    why[drop] = 'duplicate of ' + keep;
  }
  const open = switchable.filter((s) => !hide.has(s.name) && !pinnedOn.has(s.name));
  if (!pick) {
    for (const s of open) { show.add(s.name); why[s.name] = why[s.name] || 'auto'; }
  } else {
    let used = 0;
    for (const n of pinnedOn) used += ((switchable.find((s) => s.name === n) || {}).tools || []).length;
    const ranked = [...open].sort((x, y) => (scores[y.name] - scores[x.name]) || (x.name < y.name ? -1 : 1));
    for (const s of ranked) {
      const n = (s.tools || []).length;
      const relevant = scores[s.name] > 0;
      const fits = toolBudget <= 0 || used + n <= toolBudget || used === 0;
      if (relevant && fits) { show.add(s.name); used += n; why[s.name] = 'relevant'; }
      else { hide.add(s.name); why[s.name] = relevant ? 'over budget' : 'not needed'; }
    }
  }
  return { show, hide, scores, why };
}

/** Seconds to wait before the nth reconnect try of a failed connector (0-based), or 0 when it has had its share. */
function reconnectDelay(attempt) {
  const steps = [5, 15, 45, 120, 300];
  return steps[attempt] || 0;
}

module.exports = {
  MODES, serverOf, words, scoreServer, toolBudgetFor, needsPick,
  normalizeModes, modeFor, setMode, recordUse, normalizeUsage, duplicatePairs, plan, reconnectDelay,
};
