// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { chatToken, conversationContext, urlMention } from './mentions.js';
import { chatTurns, openChats } from './mentions-live.js';
import { elIcon, toast } from '../app/core.js';
import { handleEvent } from './events.js';
import { folderEntries, headLines } from './cmdmatch.js';
import { ensurePanes, setPreview } from './preview.js';
import { hideSlash } from './slash.js';
import { chats, el, esc } from './util.js';

/**
 * Read an image as base64, shrinking it first. A full-screen PNG is ~500 kB;
 * a few of them blocked the message at the IPC size cap. The long edge is
 * capped at 1568 px (the size vision models resize to anyway) and the pixels
 * are re-encoded as JPEG when that is smaller. Anything that cannot be
 * decoded (or has no canvas, as in tests) goes through unchanged.
 */
const IMG_MAX_EDGE = 1568;

export async function readImageFile(file) {
  const raw = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const orig = { media_type: file.type || 'image/png', data: raw.split(',')[1] };
  if (!/^image\/(png|jpeg|webp|bmp)$/.test(orig.media_type)) return orig;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return orig;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMG_MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 300 * 1024) { bmp.close(); return orig; }
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * scale));
    cv.height = Math.max(1, Math.round(bmp.height * scale));
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close();
    const out = cv.toDataURL('image/jpeg', 0.85);
    const data = out.split(',')[1];
    return data && data.length < orig.data.length ? { media_type: 'image/jpeg', data } : orig;
  } catch { return orig; }
}

/** Attach a local file: images become content blocks, others become text. */
export async function attachFiles(chat, fileList) {
  for (const file of [...fileList]) {
    const type = file.type || '';
    if (type.startsWith('image/') && file.size < 20 * 1024 * 1024) {
      chat.pendingImages.push(await readImageFile(file));
    } else if (file.size > 400 * 1024) {
      toast(file.name + ' is too large to attach inline (' + Math.round(file.size / 1024) + ' kB)', 'err');
      continue;
    } else {
      const text = await file.text();
      chat.composer.value += (chat.composer.value ? '\n' : '') + '@' + file.name + '\n' + text.slice(0, 4000);
      autosize(chat.composer);
      continue;
    }
  }
  renderImageChips(chat);
}

/** Mention a file by path so the agent reads it itself (PDFs, big or binary files). */
export function addFileRef(chat, p) {
  const ref = '@' + (/\s/.test(p) ? '"' + p + '"' : p);
  const cur = chat.composer.value;
  chat.composer.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + ref + ' ';
  autosize(chat.composer);
  chat.composer.focus();
}

/** Files already read by the main process: images become blocks, text inlines, the rest go by path. */
export function applyAttachedFiles(chat, files) {
  for (const f of files) {
    if (f.base64 && f.mediaType) {
      chat.pendingImages.push({ media_type: f.mediaType, data: f.base64 });
    } else if (f.ref && f.path) {
      addFileRef(chat, f.path);
    } else if (f.text != null) {
      chat.composer.value += (chat.composer.value ? '\n' : '') + '@' + f.name + '\n' + f.text;
    } else if (f.error) {
      toast(f.name + ': ' + f.error, 'err');
    }
  }
  renderImageChips(chat);
  autosize(chat.composer);
}

export { persistPending, renderQueued } from './qpanel.js';

/**
 * A send the engine refused: put the text and images back in the composer
 * (unless the user has already started something new) so nothing is lost.
 */
export function restoreUnsent(chat, text, blocks) {
  if (text && !chat.composer.value) { chat.composer.value = text; autosize(chat.composer); }
  if (blocks && blocks.length && !chat.pendingImages.length) {
    for (const b of blocks) {
      if (b && b.type === 'image' && b.source && b.source.data) chat.pendingImages.push({ media_type: b.source.media_type, data: b.source.data });
    }
    renderImageChips(chat);
  }
}

export function renderImageChips(chat) {
  chat.imgs.innerHTML = '';
  chat.imgs.classList.toggle('hidden', !chat.pendingImages.length);
  chat.pendingImages.forEach((img, i) => {
    const chip = elIcon('span', 'img-chip', CCEIcons.svg('file', 13) + ' image ' + (i + 1));
    const x = elIcon('button', 'close', CCEIcons.svg('close', 13));
    x.title = 'Remove';
    x.setAttribute('aria-label', 'Remove image');
    x.addEventListener('click', () => { chat.pendingImages.splice(i, 1); renderImageChips(chat); });
    chip.appendChild(x);
    chat.imgs.appendChild(chip);
  });
  persistImages(chat);
}

/**
 * Keep the pasted images of an unsent message across a crash. They go to the
 * main process (0600 files), never to localStorage. Coalesced so a paste of
 * several screenshots is one write.
 */
function persistImages(chat) {
  if (chat.restoringImages) return;
  clearTimeout(chat.imgSaveTimer);
  chat.imgSaveTimer = setTimeout(() => {
    ccx.invoke('draft:images', { op: 'save', key: chat.cwd || '', images: chat.pendingImages || [] }).catch(() => {});
  }, 300);
}

/** Put back the images an unsent message had when the app last stopped. */
export async function restoreDraftImages(chat) {
  try {
    const r = await ccx.invoke('draft:images', { op: 'load', key: chat.cwd || '' });
    const imgs = (r && r.images) || [];
    if (!imgs.length || chat.pendingImages.length) return;
    chat.restoringImages = true;
    chat.pendingImages.push(...imgs);
    renderImageChips(chat);
  } catch { /* nothing to restore */ } finally { chat.restoringImages = false; }
}

export function clearImages(chat) { chat.pendingImages = []; renderImageChips(chat); }

const GIT_REFS = [
  { kind: 'git', label: 'diff', hint: 'Unstaged changes, pasted as a diff' },
  { kind: 'git', label: 'staged', hint: 'Staged changes, pasted as a diff' },
  { kind: 'git', label: 'branch', hint: 'Current branch name' },
];
const AT_DIFF_MAX = 20000;

/** Folder names found in the flat file list, shallowest first. */
function projectFolders(files) {
  const set = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

export async function maybeAt(chat) {
  const v = chat.composer.value;
  const pos = chat.composer.selectionStart ?? v.length;
  const m = v.slice(0, pos).match(/(^|\s)@([^\s@]*)$/);
  if (!m) {
    if (chat.atMode) { chat.atMode = false; hideSlash(chat); }
    return false;
  }
  chat.atMode = true;
  const q = m[2].toLowerCase();
  if (!chat.filesCache) {
    const r = await ccx.invoke('project:files', { cwd: chat.cwd });
    chat.filesCache = r.ok ? r.files : [];
  }
  if (!chat.foldersCache) chat.foldersCache = projectFolders(chat.filesCache);
  const git = GIT_REFS.filter((g) => g.label.startsWith(q));
  const dirs = chat.foldersCache.filter((f) => f.toLowerCase().includes(q)).slice(0, 4).map((f) => ({ kind: 'folder', label: f + '/' }));
  const files = chat.filesCache.filter(f => f.toLowerCase().includes(q)).slice(0, 10).map((f) => ({ kind: 'file', label: f }));
  // Other open conversations: @ one to bring its latest exchange into this message.
  const convs = openChats(chat.id).filter((c) => (c.title + ' ' + c.folder).toLowerCase().includes(q)).slice(0, 4)
    .map((c) => ({ kind: 'chat', label: c.title, hint: c.folder, chatId: c.id }));
  const url = urlMention(m[2]);   // the query keeps its case for an address
  const items = (url ? [{ kind: 'url', label: url }] : []).concat(git, convs, dirs, files);
  if (!items.length) { hideSlash(chat); return true; }
  chat.atItems = items;
  chat.slashIdx = 0;
  chat.slashItems = items;   // the key handler checks its length
  ensurePanes(chat);
  chat.slashList.style.maxHeight = '';
  chat.slashSpacer.style.height = '0px';
  for (const n of [...chat.slashList.querySelectorAll('.slash-item, .slash-section')]) n.remove();
  items.forEach((it, i) => {
    const icon = it.kind === 'git' ? 'branch' : it.kind === 'chat' ? 'layers' : it.kind === 'url' ? 'globe' : 'file';
    const item = elIcon('div', 'slash-item at-item' + (i === chat.slashIdx ? ' sel' : ''), CCEIcons.svg(icon, 14) + ' ' + esc(it.kind === 'git' ? '@' + it.label : it.kind === 'chat' ? it.label + (it.hint ? '  ·  ' + it.hint : '') : it.label));
    item.dataset.idx = String(i);
    item.style.position = 'static';
    item.addEventListener('mousedown', (e) => { e.preventDefault(); chat.slashIdx = i; applyAt(chat); });
    item.addEventListener('mouseenter', () => { chat.slashIdx = i; markAt(chat); });
    chat.slashList.appendChild(item);
  });
  chat.slash.classList.remove('hidden');
  markAt(chat);
  return true;
}

function markAt(chat) {
  for (const n of chat.slashList.querySelectorAll('.at-item')) n.classList.toggle('sel', n.dataset.idx === String(chat.slashIdx));
  clearTimeout(chat.slashPreviewTimer);
  const it = chat.atItems[chat.slashIdx];
  chat.slashPreviewTimer = setTimeout(() => loadAtPreview(chat, it), 80);
}

async function loadAtPreview(chat, it) {
  if (!it) return setPreview(chat, null);
  if (it.kind === 'git') return setPreview(chat, { title: '@' + it.label, badge: 'git', meta: it.hint });
  if (it.kind === 'url') return setPreview(chat, { title: it.label, badge: 'link', meta: 'Sent as text; the engine fetches it if it needs to' });
  if (it.kind === 'chat') {
    const other = openChats(chat.id).find((c) => c.id === it.chatId);
    const ctx = other ? conversationContext(it.label, chatTurns(other.chat), 900) : '';
    return setPreview(chat, { title: it.label, badge: 'conversation', meta: ctx ? 'Its latest exchange comes with your message' : 'Nothing said in it yet', body: ctx.replace(/^<conversation[^>]*>\n|\n<\/conversation>$/g, '') });
  }
  if (it.kind === 'folder') {
    const names = folderEntries(chat.filesCache, it.label, 30);
    return setPreview(chat, { title: it.label, badge: 'folder', meta: names.length + (names.length >= 30 ? '+' : '') + ' entries', body: names.join('\n') });
  }
  if (/\.(png|jpe?g|gif|webp)$/i.test(it.label) && !it.label.split('/').includes('..') && !it.label.startsWith('/')) {
    setPreview(chat, { title: it.label, badge: 'image', meta: 'loading…' });
    try {
      const r = await ccx.invoke('file:thumb', { path: (chat.cwd || '') + '/' + it.label });
      if (chat.atItems[chat.slashIdx] !== it) return;
      if (r && r.ok && r.url) return setPreview(chat, { title: it.label, badge: 'image', meta: Math.round(r.size / 1024) + ' KB', image: r.url });
      return setPreview(chat, { title: it.label, badge: 'image', meta: r && r.tooLarge ? 'Large image: ' + Math.round(r.size / 1024) + ' KB' : 'No preview' });
    } catch { return setPreview(chat, { title: it.label, badge: 'image', meta: 'No preview' }); }
  }
  if (/\.(ico|pdf|zip|gz|woff2?)$/i.test(it.label)) return setPreview(chat, { title: it.label, badge: 'file', meta: 'Binary file: no text preview' });
  setPreview(chat, { title: it.label, badge: 'file', meta: 'loading…' });
  if (it.label.split('/').includes('..') || it.label.startsWith('/')) return setPreview(chat, { title: it.label, badge: 'file', meta: 'No preview' });
  try {
    const r = await ccx.invoke('file:read', { path: (chat.cwd || '') + '/' + it.label, maxBytes: 24000 });
    if (chat.atItems[chat.slashIdx] !== it) return;
    if (r && r.ok && !r.tooLarge) {
      const h = headLines(r.content, 40);
      setPreview(chat, { title: it.label, badge: 'file', meta: r.size + ' bytes', body: h.text, cut: h.cut });
    } else setPreview(chat, { title: it.label, badge: 'file', meta: r && r.tooLarge ? 'Large file: ' + r.size + ' bytes' : 'No preview' });
  } catch { if (chat.atItems[chat.slashIdx] === it) setPreview(chat, { title: it.label, badge: 'file', meta: 'No preview' }); }
}

export async function applyAt(chat) {
  const it = chat.atItems[chat.slashIdx >= 0 ? chat.slashIdx : 0];
  chat.atMode = false;
  hideSlash(chat);
  if (!it) return;
  let insert = it.kind === 'git' ? '' : it.kind === 'chat' ? chatToken(it.label) + ' ' : '@' + it.label + ' ';
  if (it.kind === 'git') {
    try {
      if (it.label === 'branch') {
        const r = await ccx.invoke('git:info', { cwd: chat.cwd });
        insert = (r && r.ok && r.branch ? 'branch `' + r.branch + '`' : '(no branch)') + ' ';
      } else {
        const r = await ccx.invoke('git:diff', { cwd: chat.cwd, staged: it.label === 'staged' });
        const patch = r && r.ok ? String(r.patch || '').slice(0, AT_DIFF_MAX) : '';
        // A diff of a markdown file can hold ``` itself: fence with one more backtick than any run inside.
        const fence = '`'.repeat(Math.max(3, ...(patch.match(/`+/g) || []).map((m) => m.length + 1)));
        insert = patch ? '\n' + fence + 'diff\n' + patch + '\n' + fence + '\n' : '(no ' + it.label + ' changes) ';
      }
    } catch { insert = '(git unavailable) '; }
  }
  const v = chat.composer.value;
  const pos = chat.composer.selectionStart ?? v.length;
  const before = v.slice(0, pos).replace(/@([^\s@]*)$/, insert);
  chat.composer.value = before + v.slice(pos);
  chat.composer.setSelectionRange(before.length, before.length);
  autosize(chat.composer);
  chat.composer.focus();
}

// The composer auto-expands as new lines are formed (matching Claude Code Desktop)
// up to max height, with scrolling once cap is exceeded.
const ONE_LINE = 20;

 // one line of text (line-height); the box adds the margin
export function autosize(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  const lines = (ta.value || '').split('\n').length;
  // In jsdom or before layout, scrollHeight is 0: estimate from line count if scrollHeight <= ONE_LINE
  const full = Math.max(ta.scrollHeight || 0, lines * ONE_LINE);
  const maxHeight = Math.min(320, Math.max(160, Math.round((window.innerHeight || 800) * 0.35)));
  const h = Math.min(maxHeight, Math.max(ONE_LINE, full));
  ta.style.height = h + 'px';
  ta.style.overflowY = full > maxHeight ? 'auto' : 'hidden';
}

function setExpanded(chat, on) {
  // Kept as no-op for backward compatibility
}

/* ---------------- global event wiring ---------------- */

// Anchor interception: a markdown link opens externally instead of replacing
// the app with a web page. #6 (main.js also blocks navigation; this is the
// renderer half so the click feels immediate.)
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  e.stopPropagation();
  ccx.invoke('shell:openExternal', { url: href });
});

if (window.ccx && window.ccx.onChatEvent) {
  window.ccx.onChatEvent((evt) => {
    try { handleEvent(evt); } catch (err) { console.error('chat render error', err); }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // A palette, find bar or dialog that already handled Escape must not
    // also interrupt the running turn.
    if (e.defaultPrevented) return;
    // The Conversations dropdown outranks everything: close it, don't stop the turn.
    const drop = document.querySelector('#convo-drop');
    if (drop && !drop.classList.contains('hidden')) return;
    for (const [, chat] of chats) {
      if (chat.pane.classList.contains('active')) {
        const panel = chat.pane.querySelector('.chat-skills-panel');
        if (panel) { panel.remove(); return; }
        if (!chat.permSlot.querySelector(".perm-card:not(.elic)") && chat.busy && !e.shiftKey) {
          ccx.invoke('chat:interrupt', { id: chat.id });
        }
      }
    }
  }
});

export const toggleExpanded = (chat) => {
  if (chat && chat.composer) chat.composer.focus();
};
