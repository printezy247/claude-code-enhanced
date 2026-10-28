// Visual markdown editor (item 21): one modal with the source on the left,
// a live preview on the right, checklists you can tick from either side, and
// ```flow``` arrow chains drawn as SVG boxes. Saving goes through the guarded
// file:saveText (open projects, .md/.txt only, never a sensitive file).
import { $, el, toast } from './core.js';
import { renderPreview, toggleTaskLine } from './mdtools.js';

function readMarkdown(path) {
  return ccx.invoke('file:read', { path }).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || 'could not read the file');
    return String(r.content || '');
  });
}

export function openMdEditor(path, initialText) {
  // One editor at a time: re-opening brings the live one forward.
  const old = document.querySelector('.modal-overlay.md-editor');
  if (old) { old.remove(); document.body.appendChild(old); return; }
  // Same two-attribute dialog contract as every other overlay (#53), and the
  // 'modal-overlay' string stays exact so the a11y test's count keeps matching.
  const overlay = el('div', 'modal-overlay');
  overlay.classList.add('md-editor');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  const modal = el('div', 'modal md-editor-modal');
  modal.appendChild(el('h3', '', 'Markdown editor'));

  const src = el('textarea', 'md-src');
  src.spellcheck = false;
  src.setAttribute('aria-label', 'Markdown source');
  const prev = el('div', 'md-prev');
  prev.setAttribute('aria-label', 'Preview');
  const tasks = el('div', 'md-tasks');
  const status = el('div', 'hint', '');
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  const refresh = () => {
    const text = src.value;
    // Preview: marked + DOMPurify are page globals; flow fences become SVG.
    prev.innerHTML = renderPreview(text, { marked: window.marked, DOMPurify: window.DOMPurify });
    // Task strip: every '- [ ]' / '- [x]' line as a live checkbox.
    tasks.textContent = '';
    const lines = text.split('\n');
    const found = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^- \[[ x]\]/i.test(lines[i])) found.push(i);
    }
    if (found.length) tasks.appendChild(el('div', 'hint', 'Tasks (editing the source):'));
    for (const i of found) {
      const line = lines[i];
      const done = /^- \[x\]/i.test(line);
      const label = el('label', 'md-task');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = done;
      cb.addEventListener('change', () => {
        lines[i] = toggleTaskLine(lines[i]);
        src.value = lines.join('\n');
        refresh();
      });
      label.appendChild(cb);
      label.appendChild(el('span', '', line.replace(/^- \[[ x]\]\s*/i, '')));
      tasks.appendChild(label);
    }
  };
  src.addEventListener('input', refresh);

  const row = el('div', 'perm-actions');
  const save = el('button', 'btn small primary', 'Save');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await ccx.invoke('file:saveText', { path, content: src.value });
      if (r && r.ok) { toast('Saved ' + r.bytes + ' bytes', 'ok'); status.textContent = 'saved ' + path; }
      else throw new Error((r && r.error) || 'save failed');
    } catch (err) { toast(String(err && err.message || err), 'err'); }
    save.disabled = false;
  });
  const cancel = el('button', 'btn small', 'Close');
  cancel.addEventListener('click', close);
  row.append(save, cancel);

  const split = el('div', 'md-split');
  split.append(src, prev);
  modal.append(split, tasks, status, row);
  overlay.appendChild(modal);
  $('#modal-root').appendChild(overlay);

  status.textContent = 'loading…';
  const start = initialText != null ? Promise.resolve(initialText) : readMarkdown(path);
  start.then((text) => { src.value = text; status.textContent = path; refresh(); src.focus(); })
    .catch((err) => { status.textContent = String(err && err.message || err); refresh(); });
}
