// Multi-window: which window owns which chat and terminal session.
//
// Two app windows can run at the same time. The chat and session managers
// are global, so their ids are global too — the only thing that keeps the
// windows apart is a record of which window opened what, and the routing
// built on it. These tests pin that routing: a session's output goes to the
// window that opened it, and a window cannot touch another window's chat.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const stub = require('electron');
const main = require('../src/main/main.js');

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The IPC event a window sends: the main process reads the sender's id. */
const sender = (w) => ({ sender: { id: w.webContents.id } });

const { windowRegistry, sessions } = main;

beforeAll(async () => {
  // The main process creates the first window during startup, after the
  // translator proxy has bound its port. Wait for it: a test that reaches for
  // windows[1] before it exists would fail for the wrong reason.
  const deadline = Date.now() + 8000;
  while (stub.__state.windows.length < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await flush();
});

describe('multi-window', () => {
  it('opens a second window on request', async () => {
    const before = stub.__state.windows.length;
    const res = await stub.__state.handlers.get('window:new')(sender(stub.__state.windows[0]), {});
    expect(res.ok).toBe(true);
    expect(stub.__state.windows.length).toBe(before + 1);
    expect(res.count).toBe(before + 1);
  });

  it('keeps the window that opened a session apart from another window', () => {
    const w1 = stub.__state.windows[0];
    const w2 = stub.__state.windows[1];
    expect(w1).toBeTruthy();
    expect(w2).toBeTruthy();
    windowRegistry.claim(w1.webContents.id, 'sessions', 'sOwn');
    expect(windowRegistry.ownerOf('sessions', 'sOwn')).toBe(w1.webContents.id);
  });

  it('sends terminal output only to the window that opened the session', () => {
    const w1 = stub.__state.windows[0];
    const w2 = stub.__state.windows[1];
    windowRegistry.claim(w1.webContents.id, 'sessions', 'sRoute');
    stub.__state.sent.length = 0;
    sessions.emit('data', 'sRoute', 'hello');
    const toW1 = stub.__state.sent.filter((s) => s.channel === 'pty:data' && s.payload.id === 'sRoute');
    expect(toW1.length).toBe(1);
    expect(toW1[0].wcId).toBe(w1.webContents.id);
    expect(toW1[0].wcId).not.toBe(w2.webContents.id);
  });

  it('sends chat events only to the window that owns the chat', () => {
    const w1 = stub.__state.windows[0];
    windowRegistry.claim(w1.webContents.id, 'chats', 'cRoute');
    stub.__state.sent.length = 0;
    main.chats.emit('event', 'cRoute', { kind: 'status', busy: true });
    const sent = stub.__state.sent.filter((s) => s.channel === 'chat:event' && s.payload.id === 'cRoute');
    expect(sent.length).toBe(1);
    expect(sent[0].wcId).toBe(w1.webContents.id);
  });

  it('drops a chat event whose owning window is gone', () => {
    const w1 = stub.__state.windows[0];
    windowRegistry.claim(w1.webContents.id, 'chats', 'cGone');
    w1.destroyed = true;
    stub.__state.sent.length = 0;
    main.chats.emit('event', 'cGone', { kind: 'status', busy: true });
    const sent = stub.__state.sent.filter((s) => s.channel === 'chat:event' && s.payload.id === 'cGone');
    expect(sent.length).toBe(0);
    w1.destroyed = false;
  });

  it('refuses to close a chat that belongs to another window', async () => {
    const w1 = stub.__state.windows[0];
    const w2 = stub.__state.windows[1];
    windowRegistry.claim(w1.webContents.id, 'chats', 'cForeign');
    const res = await stub.__state.handlers.get('chat:close')(sender(w2), { id: 'cForeign' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/another window/i);
  });

  it('lets the owning window close its own chat', async () => {
    const w1 = stub.__state.windows[0];
    const res = await stub.__state.handlers.get('chat:close')(sender(w1), { id: 'cForeign' });
    expect(res.ok).toBe(true);
  });

  it('raises the window that owns the finished chat, not the newest one', () => {
    // The notification click used to show `win` — the NEWEST window — so with
    // two windows open, "Claude finished" could raise the wrong one.
    const w1 = stub.__state.windows[0];
    const w2 = stub.__state.windows[1];
    windowRegistry.claim(w1.webContents.id, 'chats', 'cNotify');
    const show1 = vi.spyOn(w1, 'show');
    const show2 = vi.spyOn(w2, 'show');
    stub.__state.notifications.length = 0;

    main.chats.emit('event', 'cNotify', { kind: 'status', busy: false });

    const notes = stub.__state.notifications;
    expect(notes.length, 'no notification was raised').toBe(1);
    notes[0].emit('click');
    expect(show1, 'the owning window was not raised').toHaveBeenCalled();
    expect(show2, 'the wrong window was raised').not.toHaveBeenCalled();
  });

  it('raises no notification for a chat the user closed', async () => {
    const w2 = stub.__state.windows[1];
    windowRegistry.claim(w2.webContents.id, 'chats', 'cClosed');
    // Blur EVERY window, not just the owner. On the UNFIXED code the owner
    // falls back to the NEWEST window (the fallback `win`), and that one was
    // focused by `window:new` — so no notification is raised on the unfixed
    // code either, and the RED would be a false one.
    for (const w of stub.__state.windows) w.blur();
    stub.__state.notifications.length = 0;

    // The user closed the chat: its late frames are ghosts.
    await stub.__state.handlers.get('chat:close')(sender(w2), { id: 'cClosed' });

    main.chats.emit('event', 'cClosed', { kind: 'status', busy: false });
    expect(stub.__state.notifications.length, 'a closed chat still raised a notification').toBe(0);
  });

  it('brings a hidden window back from the tray', async () => {
    // Close-to-tray hides a window; with two windows open, closing the newest
    // left the older, hidden one with no way back.
    const w1 = stub.__state.windows[0];
    const w2 = stub.__state.windows[1];
    const set = stub.__state.handlers.get('settings:set');
    const res = await set(null, { settings: { closeToTray: true } });
    expect(res.ok, 'close-to-tray could not be turned on').toBe(true);
    const tray = stub.__state.tray;
    expect(tray, 'no tray item was created').toBeTruthy();
    const show = (tray.menu && tray.menu.t || []).find((i) => i.label === 'Show');
    expect(show, 'the tray has no Show item').toBeTruthy();

    w1.hide();
    expect(w1.isVisible(), 'the window did not hide').toBe(false);
    show.click();
    expect(w1.isVisible(), 'the tray did not bring the hidden window back').toBe(true);

    // Leave the app as the test found it.
    await set(null, { settings: { closeToTray: false } });
    if (tray && !tray.isDestroyed()) tray.destroy();
  });

  it('tears a closed window down, and drops its chat’s later frames', () => {
    // The plan's Review Focus #1: a window closes while a chat is running.
    // The engine process and the pty must go with it, and the dead chat's
    // frames must not show up in another window.
    const w1 = stub.__state.windows[0];
    const w2 = stub.__state.windows[1];
    const closeSpy = vi.spyOn(main.chats, 'close');
    const killSpy = vi.spyOn(main.sessions, 'kill');
    windowRegistry.claim(w1.webContents.id, 'chats', 'cTear');
    windowRegistry.claim(w1.webContents.id, 'sessions', 'sTear');

    w1.close();

    expect(closeSpy, 'the chat was not closed with its window').toHaveBeenCalledWith('cTear');
    expect(killSpy, 'the session was not killed with its window').toHaveBeenCalledWith('sTear');

    stub.__state.sent.length = 0;
    main.chats.emit('event', 'cTear', { kind: 'status', busy: true });
    const toW2 = stub.__state.sent.filter((s) => s.channel === 'chat:event'
      && s.payload.id === 'cTear' && s.wcId === w2.webContents.id);
    expect(toW2.length, 'the dead chat’s frames were delivered to another window').toBe(0);
  });

  it('raises the newest window when the owner is gone by the time it is clicked', async () => {
    // The notification is raised for the window that OWNS the chat, but that
    // window may be closed between the raise and the click. The click must
    // then fall back to the newest window rather than doing nothing. #N1
    const open = stub.__state.handlers.get('window:new');
    await open(null, {});
    await open(null, {});
    const all = stub.__state.windows;
    const owner = all[all.length - 2];
    const newest = all[all.length - 1];
    owner.blur();                    // the user is looking at another window
    const show = vi.spyOn(newest, 'show');
    windowRegistry.claim(owner.webContents.id, 'chats', 'cGoneWin');
    stub.__state.notifications.length = 0;

    main.chats.emit('event', 'cGoneWin', { kind: 'status', busy: false });
    const notes = stub.__state.notifications;
    expect(notes.length, 'no notification was raised').toBe(1);

    owner.close();                   // the owner goes away before the click
    notes[0].emit('click');
    expect(show, 'the click raised no window at all').toHaveBeenCalled();
  });
});
