// The Files tab of a chat that runs on another machine over ssh: read-only.
// Folders, a file as plain text, and the folder's git diff. Text is always set
// as text, so nothing from the remote machine is ever read as markup.
import { el, toast } from './core.js';

export const parentOf = (p) => {
  if (p === '/' || p === '~') return p;
  const cut = p.replace(/\/+$/, '').lastIndexOf('/');
  if (cut <= 0) return p.startsWith('~') ? '~' : '/';
  return p.slice(0, cut);
};
const join = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;

export function renderRemoteFiles(body, chat) {
  const hostId = chat.ssh.id;
  let dir = chat.cwd || '~';
  body.appendChild(el('div', 'rail-sub hint', 'On ' + (chat.ssh.host || chat.ssh.label) + ' over ssh. Read-only.'));
  const bar = el('div', 'rail-actions');
  const up = el('button', 'btn small remote-up', 'Up');
  up.type = 'button';
  const diff = el('button', 'btn small remote-diff', 'Git diff');
  diff.type = 'button';
  const where = el('span', 'hint mono remote-path', dir);
  bar.appendChild(up); bar.appendChild(diff); bar.appendChild(where);
  body.appendChild(bar);
  const list = el('div', 'task-rows tall');
  const view = el('pre', 'remote-view mono');
  view.hidden = true;
  body.appendChild(list);
  body.appendChild(view);

  const fail = (e) => { toast(String((e && e.message) || e), 'err'); };
  const showText = (r) => { view.hidden = false; view.textContent = (r.text || '(empty)') + (r.truncated ? '\n… (cut off)' : ''); };

  async function go(next) {
    try {
      const r = await ccx.invoke('ssh:ls', { hostId, path: next });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not list that folder');
      dir = next;
      where.textContent = dir;
      view.hidden = true;
      list.textContent = '';
      if (!r.entries.length) list.appendChild(el('div', 'task-row hint', 'empty'));
      for (const e of r.entries) {
        const row = el('button', 'task-row mono remote-row' + (e.dir ? ' dir' : ''), (e.dir ? e.name + '/' : e.name));
        row.type = 'button';
        row.addEventListener('click', async () => {
          if (e.dir) { go(join(dir, e.name)); return; }
          try {
            const f = await ccx.invoke('ssh:read', { hostId, path: join(dir, e.name) });
            if (!f || !f.ok) throw new Error((f && f.error) || 'Could not read that file');
            showText(f);
          } catch (err) { fail(err); }
        });
        list.appendChild(row);
      }
      if (r.truncated) list.appendChild(el('div', 'task-row hint', 'first entries only'));
    } catch (err) { fail(err); }
  }
  up.addEventListener('click', () => go(parentOf(dir)));
  diff.addEventListener('click', async () => {
    try {
      const r = await ccx.invoke('ssh:diff', { hostId, path: dir });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not run git diff');
      showText({ ...r, text: r.text || 'No changes.' });
    } catch (err) { fail(err); }
  });
  go(dir);
}
