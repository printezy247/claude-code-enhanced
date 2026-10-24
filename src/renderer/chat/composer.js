// Split from the former chat.js (roadmap 4.1). Behaviour is unchanged.
import { elIcon, toast } from '../app/core.js';
import { handleEvent } from './events.js';
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

/** Messages sent while a turn is running, shown as pending chips. #32 */
export function renderQueued(chat) {
  if (!chat.queuedEl) return;
  chat.queuedEl.innerHTML = '';
  chat.queuedEl.classList.toggle('hidden', !chat.pendingMsgs.length);
  for (let i = 0; i < chat.pendingMsgs.length; i++) {
    const item = chat.pendingMsgs[i];
    const t = typeof item === 'string' ? item : (item && item.text) || '';
    const chip = el('span', 'queued-chip');
    const label = el('span', 'queued-chip-text', t.length > 70 ? t.slice(0, 70) + '…' : t);
    const del = el('span', 'queued-chip-del', ' ×');
    del.title = 'Remove queued message';
    del.onclick = (e) => {
      e.stopPropagation();
      chat.pendingMsgs.splice(i, 1);
      persistPending(chat);
      renderQueued(chat);
    };
    chip.appendChild(label);
    chip.appendChild(del);
    chat.queuedEl.appendChild(chip);
  }
}

/**
 * Remember queued messages across a crash: the text only. Pasted images are
 * megabytes of base64, which overflow the storage quota and would leave
 * screenshots sitting unencrypted on disk.
 */
export function persistPending(chat) {
  try {
    const texts = (chat.pendingMsgs || []).map((m) => (typeof m === 'string' ? m : (m && m.text) || '')).filter(Boolean);
    localStorage.setItem('cce:pending:' + (chat.cwd || ''), JSON.stringify(texts));
  } catch { /* quota or private mode: the queue just is not remembered */ }
}

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
}

export function clearImages(chat) { chat.pendingImages = []; renderImageChips(chat); }

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
  const files = chat.filesCache.filter(f => f.toLowerCase().includes(q)).slice(0, 10);
  if (!files.length) { hideSlash(chat); return true; }
  chat.atItems = files;
  chat.slashIdx = 0;
  chat.slash.innerHTML = '';
  files.forEach((f, i) => {
    const item = elIcon('div', 'slash-item' + (i === chat.slashIdx ? ' sel' : ''), CCEIcons.svg('file', 14) + ' ' + esc(f));
    item.addEventListener('mousedown', (e) => { e.preventDefault(); chat.slashIdx = i; applyAt(chat); });
    chat.slash.appendChild(item);
  });
  chat.slash.classList.remove('hidden');
  return true;
}

export function applyAt(chat) {
  const f = chat.atItems[chat.slashIdx >= 0 ? chat.slashIdx : 0];
  if (f) {
    const v = chat.composer.value;
    const pos = chat.composer.selectionStart ?? v.length;
    const before = v.slice(0, pos).replace(/@([^\s@]*)$/, '@' + f + ' ');
    chat.composer.value = before + v.slice(pos);
    chat.composer.setSelectionRange(before.length, before.length);
    chat.composer.focus();
  }
  chat.atMode = false;
  hideSlash(chat);
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
