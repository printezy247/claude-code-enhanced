// Split from the former app.js (roadmap 4.1). Behaviour is unchanged.
import { el } from './core.js';

/* ================= permission modes ================= */

// The four modes of the Claude Code desktop picker. The tooltip text is the plain-language
// difference between them. (Manual/"normal" is not offered; it maps to accept edits.)
const MODE_CHOICES = [
  ['auto', 'auto', 'Safe actions run without asking: file edits in this folder, read-only commands and the project’s own test / lint / build. Anything else still asks you. On Anthropic’s API a second model reviews each action; on other providers CCE applies the same safe-action rules itself.'],
  ['acceptEdits', 'accept edits', 'File edits and simple file commands (mkdir, mv, cp…) run without asking. Shell commands and anything else still ask you.'],
  ['plan', 'plan', 'Read-only: the agent explores and proposes a plan, and changes nothing until you approve it.'],
  ['bypassPermissions', 'yolo', 'Nothing is asked or checked. Only for throwaway folders or containers.'],
];

/**
 * Any mode value the engine or an old session reports → one of the four on offer.
 * `auto` is CCE's own policy on providers that are not Anthropic's API: the
 * engine then reports accept-edits, and `auto` (the flag the main process
 * sends back) says the user picked auto.
 */
export function uiMode(mode, provider, auto) {
  if (auto && (mode === 'acceptEdits' || mode === 'auto')) return 'auto';
  return MODE_CHOICES.some(c => c[0] === mode) ? mode : 'acceptEdits';
}

export function fillModeSelect(sel, provider) {
  const keep = sel.value;
  sel.innerHTML = '';
  MODE_CHOICES.forEach(([value, label, tip]) => {
    const o = el('option', '', label);
    o.value = value; o.title = tip;
    sel.appendChild(o);
  });
  sel.title = MODE_CHOICES.map(c => c[1] + ' — ' + c[2]).join('\n\n');
  if (keep) sel.value = uiMode(keep, provider);
}
