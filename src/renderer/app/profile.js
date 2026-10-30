// One-file backup of the user's choices: settings plus the interface
// preferences, workflows and budget limits kept in the window's storage.
// Provider keys live in auth.json and Claude's own connector entries in its
// config; neither is exported. Usage logs and spend totals are left out too.
export const PROFILE_KIND = 'cce-profile';
const SKIP_SETTINGS = new Set(['loginEnv', 'connectorUsage', 'claudePath']);
const SKIP_LOCAL = new Set(['cce:spend', 'cce:tokenlog']);
const MAX_LOCAL_BYTES = 512 * 1024;

const wanted = (k) => /^cce[.:]/.test(k) && !SKIP_LOCAL.has(k);

/** The profile as text. `store` is a Storage; `settings` the saved settings object. */
export function buildProfile({ settings, store, version, now }) {
  const clean = {};
  for (const [k, v] of Object.entries(settings || {})) if (!SKIP_SETTINGS.has(k)) clean[k] = v;
  const local = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (wanted(k)) local[k] = store.getItem(k);
  }
  return JSON.stringify({ kind: PROFILE_KIND, version: 1, app: version, exported: new Date(now).toISOString(), settings: clean, local }, null, 2);
}

/** Check a profile's text. Returns { ok, settings, local } or { ok:false, error }. */
export function parseProfile(text) {
  let p;
  try { p = JSON.parse(text); } catch { return { ok: false, error: 'That file is not a CCE profile (not valid JSON).' }; }
  if (!p || p.kind !== PROFILE_KIND) return { ok: false, error: 'That file is not a CCE profile.' };
  if (p.version !== 1) return { ok: false, error: 'This profile was made by a newer CCE (version ' + p.version + ').' };
  const settings = {};
  for (const [k, v] of Object.entries(p.settings && typeof p.settings === 'object' ? p.settings : {})) {
    if (!SKIP_SETTINGS.has(k)) settings[k] = v;
  }
  const local = {};
  let bytes = 0;
  for (const [k, v] of Object.entries(p.local && typeof p.local === 'object' ? p.local : {})) {
    if (!wanted(k) || typeof v !== 'string') continue;
    bytes += k.length + v.length;
    if (bytes > MAX_LOCAL_BYTES) return { ok: false, error: 'That profile is too large.' };
    local[k] = v;
  }
  return { ok: true, settings, local };
}

/** Write the imported window preferences into a Storage; returns how many. */
export function applyLocal(store, local) {
  let n = 0;
  for (const [k, v] of Object.entries(local)) { store.setItem(k, v); n++; }
  return n;
}
