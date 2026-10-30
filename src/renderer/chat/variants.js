// Alternate prompts tried from one message. Kept per session in localStorage
// (text only), so the list is still there after a restart.
export const MAX_VARIANTS = 12;
const key = (sid) => 'variants:' + sid;

function load(sid) {
  try { const v = JSON.parse(localStorage.getItem(key(sid)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function save(sid, list) {
  try { localStorage.setItem(key(sid), JSON.stringify(list)); } catch { /* private mode */ }
}

export function variantsFor(sid, uuid) {
  if (!sid || !uuid) return [];
  return load(sid).filter((v) => v.uuid === uuid);
}

export function addVariant(sid, uuid, text) {
  const t = String(text || '').trim();
  if (!sid || !uuid || !t) return;
  const all = load(sid);
  if (all.some((v) => v.uuid === uuid && v.text === t)) return;
  all.push({ uuid, text: t.slice(0, 4000), at: Date.now() });
  const mine = all.filter((v) => v.uuid === uuid);
  const drop = mine.length - MAX_VARIANTS;
  save(sid, drop > 0 ? all.filter((v) => !(v.uuid === uuid && mine.indexOf(v) < drop)) : all);
}

export function removeVariant(sid, uuid, text) {
  save(sid, load(sid).filter((v) => !(v.uuid === uuid && v.text === text)));
}
