// Where this chat runs: this folder, an isolated git worktree, or another
// machine over SSH. The target is fixed when a chat starts, so changing it
// opens a new chat (after asking).
import { t, tf } from '../i18n.js';
import { toast } from '../app/core.js';
import { createSession } from './session.js';
import { el } from './util.js';

export function wireTargetChip(chat, res) {
  const btn = chat.targetBtn;
  if (!btn) return;
  const isTree = !!res.worktree;
  const isSsh = !!res.ssh;
  btn.querySelector('.tg-label').textContent = isSsh ? t('target.ssh') + ' · ' + res.ssh.label : isTree ? t('target.worktree') : t('target.local');
  btn.title = isSsh ? tf('target.tipSsh', { label: res.ssh.label }) : isTree ? tf('target.tipTree', { path: res.worktree.path }) : t('target.tipLocal');
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
    add(t('target.local'), t('target.localDesc'), !isTree && !isSsh, () => {
      if (isTree || isSsh) openNew(false);
    });
    // A worktree is a local copy; from a remote chat there is nothing to copy.
    if (!isSsh) add(t('target.newTree'), t('target.newTreeDesc'), isTree, () => { if (!isTree) openNew(true); });
    chat.pane.querySelector('.chat-composer').appendChild(menu);
    // The menu is there at once; saved SSH hosts join it when the list arrives.
    const mine = menu;
    ccx.invoke('sshhosts:list').then((r) => {
      if (menu !== mine) return;   // closed meanwhile
      for (const h of (r && r.hosts) || []) {
        add(t('target.ssh') + ' · ' + h.label, tf('target.sshDesc', { who: (h.user ? h.user + '@' : '') + h.host }), isSsh && res.ssh.id === h.id, () => openSsh(h));
      }
    }).catch(() => { /* no hosts: the local choices only */ });
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
    // A remote chat's folder is a path on the other machine: the local chat starts in the default folder.
    const root = isSsh ? undefined : (res.worktree && res.worktree.root ? res.worktree.root : chat.cwd);
    createSession({ cwd: root, providerUid: chat.provider ? chat.provider.uid : null, model: chat.model || '', permissionMode: chat.mode, worktree });
    toast('Opened a new chat in ' + where);
  }

  async function openSsh(host) {
    const dir = await window.askText(tf('target.sshAsk', { label: host.label }), isSsh && res.ssh.id === host.id ? chat.cwd : '~', { okLabel: 'Open' });
    if (dir === null || !String(dir).trim()) return;
    createSession({ cwd: String(dir).trim(), sshHost: host.id, permissionMode: chat.mode });
    toast(tf('target.sshOpened', { label: host.label }));
  }
}
