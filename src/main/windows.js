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
    // "chats:c1" -> true: the item died with its window. Its frames are
    // dropped, NOT routed to another window: a dead chat's output must not
    // appear in a live one. #F3
    this.dead = new Set();
  }

  /** Register a window. Returns the id that identifies it. */
  add(win) {
    const id = win.webContents.id;
    this.entries.set(id, { win, chats: new Set(), sessions: new Set() });
    return id;
  }

  /**
   * Forget a window. Its chats and sessions are the caller's problem.
   *
   * The items the window owned are remembered as dead: they are gone with it,
   * so a late frame for one of them is dropped instead of falling back to
   * whichever window happens to be newest. #F3
   */
  remove(id) {
    const e = this.entries.get(id);
    if (e) {
      for (const c of e.chats) this.dead.add('chats:' + c);
      for (const s of e.sessions) this.dead.add('sessions:' + s);
    }
    this.entries.delete(id);
    // The dead list only grows with closed windows; keep it bounded.
    while (this.dead.size > 500) this.dead.delete(this.dead.values().next().value);
  }

  /** True when the item's window went away and took the item with it. */
  isDead(kind, itemId) {
    return this.dead.has(kind + ':' + itemId);
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
 * is dropped instead of leaking into another window. An item that died with
 * its window is dropped even though nobody owns it any more. #F3
 */
function route(registry, kind, itemId, fallback) {
  if (registry.isDead && registry.isDead(kind, itemId)) return null;
  const owner = registry.ownerOf(kind, itemId);
  if (owner == null) return fallback || null;
  const w = registry.winOf(owner);
  return w && !w.isDestroyed() ? w : null;
}

module.exports = { WindowRegistry, route };
