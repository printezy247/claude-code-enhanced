// Window ownership: who owns which chat and terminal session.
//
// Multi-window means two BrowserWindows can run at the same time, each with
// its own chats. The chat and session managers are global, so the ids are
// global too — the only thing that keeps two windows apart is a record of
// which window opened what. These tests pin that record and the routing rule
// built on it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WindowRegistry, route } = require('../src/main/windows.js');

/** A window stand-in with the one field the registry reads. */
function fakeWin(id) {
  return {
    webContents: { id },
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    show() {},
    focus() {},
  };
}

describe('window ownership registry', () => {
  it('claims an item for the window that opened it', () => {
    const reg = new WindowRegistry();
    const a = fakeWin(1);
    reg.add(a);
    expect(reg.claim(1, 'chats', 'c1')).toBe(true);
    expect(reg.ownerOf('chats', 'c1')).toBe(1);
    expect(reg.itemsOf(1, 'chats')).toEqual(['c1']);
  });

  it('keeps two windows apart', () => {
    const reg = new WindowRegistry();
    reg.add(fakeWin(1));
    reg.add(fakeWin(2));
    reg.claim(1, 'chats', 'c1');
    reg.claim(2, 'chats', 'c2');
    expect(reg.ownerOf('chats', 'c1')).toBe(1);
    expect(reg.ownerOf('chats', 'c2')).toBe(2);
    expect(reg.itemsOf(1, 'chats')).toEqual(['c1']);
    expect(reg.itemsOf(2, 'chats')).toEqual(['c2']);
  });

  it('releases a claim when the item is gone', () => {
    const reg = new WindowRegistry();
    reg.add(fakeWin(1));
    reg.claim(1, 'sessions', 's1');
    reg.release('sessions', 's1');
    expect(reg.ownerOf('sessions', 's1')).toBe(null);
  });

  it('drops a late frame for an item that was released', () => {
    const reg = new WindowRegistry();
    const a = fakeWin(1);
    const b = fakeWin(2);
    reg.add(a);
    reg.add(b);
    reg.claim(1, 'chats', 'c1');
    reg.release('chats', 'c1');
    // The chat is gone: its late frame must be dropped, not delivered to
    // whichever window happens to be newest.
    expect(route(reg, 'chats', 'c1', b)).toBe(null);
  });

  it('routes an event to the window that owns the item', () => {
    const reg = new WindowRegistry();
    const a = fakeWin(1);
    const b = fakeWin(2);
    reg.add(a);
    reg.add(b);
    reg.claim(1, 'chats', 'c1');
    expect(route(reg, 'chats', 'c1', null)).toBe(a);
    expect(route(reg, 'chats', 'c1', b)).toBe(a);   // the fallback never wins over an owner
  });

  it('drops the event when the owning window is gone', () => {
    const reg = new WindowRegistry();
    const a = fakeWin(1);
    reg.add(a);
    reg.claim(1, 'chats', 'c1');
    a.destroyed = true;
    expect(route(reg, 'chats', 'c1', null)).toBe(null);
  });

  it('falls back for an item nobody owns', () => {
    const reg = new WindowRegistry();
    const b = fakeWin(2);
    reg.add(b);
    expect(route(reg, 'chats', 'c-unknown', b)).toBe(b);
    expect(route(reg, 'chats', 'c-unknown', null)).toBe(null);
  });

  it('forgets a window and everything it owned', () => {
    const reg = new WindowRegistry();
    reg.add(fakeWin(1));
    reg.claim(1, 'chats', 'c1');
    reg.claim(1, 'sessions', 's1');
    reg.remove(1);
    expect(reg.size).toBe(0);
    expect(reg.ownerOf('chats', 'c1')).toBe(null);
    expect(reg.ownerOf('sessions', 's1')).toBe(null);
  });

  it('refuses a claim for a window it does not know', () => {
    const reg = new WindowRegistry();
    expect(reg.claim(99, 'chats', 'c1')).toBe(false);
    expect(reg.ownerOf('chats', 'c1')).toBe(null);
  });
});
