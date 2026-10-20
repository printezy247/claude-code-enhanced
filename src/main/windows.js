// Which window owns which chat and terminal session.
//
// The chat and session managers are global: their ids come from one counter
// in each manager, so a second manager would mint the same ids again and two
// windows would fight over the same chat. Window ownership therefore lives
// here: every session and chat is claimed by the window that created it, an
// event goes only to the owner, and a window that goes away takes its
// sessions and chats with it.
'use strict';

/**
 * The open windows and what each one owns.
 *
 * Keyed by the window's webContents id — the only id a renderer can prove
 * ownership of, because the main process learns it from the IPC event.
 */
class WindowRegistry {
  constructor() {
    // webContents.id -> { win, chats:Set<string>, sessions:Set<string> }
    this.entries = new Map();
  }

  /** Register a window. Returns the id that identifies it. */
  add(win) {
    const id = win.webContents.id;
    this.entries.set(id, { win, chats: new Set(), sessions: new Set() });
    return id;
  }

  /** Forget a window. Its chats and sessions are the caller's problem. */
  remove(id) {
    this.entries.delete(id);
  }

  entry(id) { return this.entries.get(id) || null; }

  /** The BrowserWindow for an id, or null. */
  winOf(id) {
    const e = this.entries.get(id);
    return e ? e.win : null;
  }

  /** Every registered window, oldest first. */
  windows() {
    return [...this.entries.values()].map(e => e.win);
  }

  get size() { return this.entries.size; }

  /** Record that a window owns a chat or a session. */
  claim(id, kind, itemId) {
    const e = this.entries.get(id);
    if (!e || !itemId) return false;
    e[kind].add(itemId);
    return true;
  }

  /** Drop a claim (the chat or session is gone). */
  release(kind, itemId) {
    for (const e of this.entries.values()) e[kind].delete(itemId);
  }

  /**
   * The id of the window that owns an item, or null when nothing owns it.
   *
   * An unowned item is never delivered anywhere on its own: `route` only
   * falls back for items that have no owner at all (a session opened before
   * this feature existed).
   */
  ownerOf(kind, itemId) {
    for (const [id, e] of this.entries) {
      if (e[kind].has(itemId)) return id;
    }
    return null;
  }

  /** The items a window owns. */
  itemsOf(id, kind) {
    const e = this.entries.get(id);
    return e ? [...e[kind]] : [];
  }
}

/**
 * The window an event for a chat or a session belongs to.
 *
 * Returns null when the owner is gone (its window was closed), so the event
 * is dropped instead of leaking into another window.
 */
function route(registry, kind, itemId, fallback) {
  const owner = registry.ownerOf(kind, itemId);
  if (owner == null) return fallback || null;
  const w = registry.winOf(owner);
  return w && !w.isDestroyed() ? w : null;
}

module.exports = { WindowRegistry, route };
