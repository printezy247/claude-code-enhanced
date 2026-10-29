// The list + preview panel shared by the "/" and "@" menus. Everything from
// disk or the engine goes in with textContent, never innerHTML.
import { el } from './util.js';

export const ROW_H = 28;
const LIST_H = 280;

/** Build the list and preview panes once per chat. */
export function ensurePanes(chat) {
  if (chat.slashList) return;
  chat.slash.classList.add('slash-split');
  chat.slashList = el('div', 'slash-list');
  chat.slashList.setAttribute('role', 'listbox');
  chat.slashSpacer = el('div', 'slash-spacer');
  chat.slashList.appendChild(chat.slashSpacer);
  chat.slashPreview = el('div', 'slash-preview');
  chat.slash.appendChild(chat.slashList);
  chat.slash.appendChild(chat.slashPreview);
}

/** Show a preview: { title, badge, meta, body, cut, image }. Text, plus an optional data-URL image. */
export function setPreview(chat, p) {
  const box = chat.slashPreview;
  if (!box) return;
  box.textContent = '';
  if (!p) return;
  const head = el('div', 'sp-head');
  head.appendChild(el('b', 'sp-title', p.title || ''));
  if (p.badge) head.appendChild(el('span', 'sp-badge', p.badge));
  box.appendChild(head);
  if (p.meta) box.appendChild(el('div', 'sp-meta', p.meta));
  if (p.image && /^data:image\/(png|jpeg|gif|webp);base64,/.test(p.image)) {
    const img = document.createElement('img');
    img.className = 'sp-thumb';
    img.alt = p.title || 'image preview';
    img.src = p.image;
    box.appendChild(img);
  }
  if (p.body) {
    const pre = el('pre', 'sp-body');
    pre.textContent = p.body + (p.cut ? '\n…' : '');
    box.appendChild(pre);
  }
}

export { LIST_H };
