// Where this chat runs: this folder, or an isolated git worktree. The target
// is fixed when a chat starts, so changing it opens a new chat (after asking).
import { toast } from '../app/core.js';
import { createSession } from './session.js';
import { el } from './util.js';

export function wireTargetChip(chat, res) {
  const btn = chat.targetBtn;
  if (!btn) return;
  const isTree = !!res.worktree;
  btn.querySelector('.tg-label').textContent = isTree ? 'Worktree' : 'Local';
  btn.title = isTree ? 'This chat edits the git worktree ' + res.worktree.path : 'This chat edits the project folder directly';
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; btn.setAttribute('aria-expanded', 'false'); } };
  btn.addEventListener('click', () => {
    if (menu) return close();
    menu = el('div', 'wf-menu target-menu');
    menu.setAttribute('role', 'menu');
    const add = (label, hint, current, fn) => {
      const b = el('button', 'wf-item');
      b.setAttribute('role', 'menuitem');
      const t = el('span', 'wf-txt');
      t.appendChild(el('b', '', label + (current ? ' ✓' : '')));
      t.appendChild(el('span', '', hint));
      b.appendChild(t);
      b.addEventListener('click', () => { close(); fn(); });
      menu.appendChild(b);
    };
    add('Local', 'edit the project folder directly', !isTree, () => {
      if (isTree) openNew(false);
    });
    add('New worktree', 'an isolated git copy on its own branch', isTree, () => { if (!isTree) openNew(true); });
    chat.pane.querySelector('.chat-composer').appendChild(menu);
    btn.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('.wf-item');
    if (first) first.focus();
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } });
    setTimeout(() => document.addEventListener('mousedown', function away(e) { if (!menu || !menu.contains(e.target)) { close(); document.removeEventListener('mousedown', away, true); } }, true), 0);
  });

  async function openNew(worktree) {
    const where = worktree ? 'an isolated git worktree' : 'the project folder';
    const ok = await window.askText('Start a new chat in ' + where + '? This chat keeps running. Type OK to continue.', '', { okLabel: 'Open' });
    if (ok === null || String(ok).trim().toLowerCase() !== 'ok') return;
    const root = res.worktree && res.worktree.root ? res.worktree.root : chat.cwd;
    createSession({ cwd: root, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode, worktree });
    toast('Opened a new chat in ' + where);
  }
}
