// Chat upgrade, phase 2 (0.9.91): the queue is an editable, pausable list.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadRenderer, flush } = require('./helpers/renderer.js');
const q = await import('../src/renderer/chat/queue.js');

const texts = (l) => l.map((x) => x.text);
const mk = (...t) => t.map((x) => q.makeItem(x));

describe('queue data rules', () => {
  it('reads strings and old {text, blocks} items', () => {
    const a = q.makeItem('hi');
    const b = q.makeItem({ text: 'x', blocks: [{ type: 'image' }] });
    expect(a).toMatchObject({ text: 'hi', blocks: null });
    expect(b.blocks.length).toBe(1);
    expect(a.id).not.toBe(q.makeItem('hi').id);
  });
  it('moves, runs next, duplicates, removes and edits without touching the input', () => {
    const l = mk('a', 'b', 'c');
    expect(texts(q.move(l, 0, 2))).toEqual(['b', 'c', 'a']);
    expect(texts(q.move(l, 2, 0))).toEqual(['c', 'a', 'b']);
    expect(texts(q.runNext(l, 2))).toEqual(['c', 'a', 'b']);
    expect(texts(q.duplicate(l, 1))).toEqual(['a', 'b', 'b', 'c']);
    expect(q.duplicate(l, 1)[1].id).not.toBe(q.duplicate(l, 1)[2].id);
    expect(texts(q.remove(l, 1))).toEqual(['a', 'c']);
    expect(texts(q.edit(l, 0, '  A2 '))).toEqual(['A2', 'b', 'c']);
    expect(texts(q.edit(l, 0, '   '))).toEqual(['b', 'c']);
    expect(texts(l)).toEqual(['a', 'b', 'c']);
  });
  it('ignores bad indexes', () => {
    const l = mk('a');
    expect(texts(q.move(l, 5, 0))).toEqual(['a']);
    expect(texts(q.remove(l, -1))).toEqual(['a']);
  });
  it('the drain runs the head unless a rule holds it', () => {
    const l = mk('a', 'b');
    expect(q.nextAction([], {})).toBe(null);
    expect(q.nextAction(l, {}).run.text).toBe('a');
    expect(q.nextAction(l, { paused: true })).toEqual({ hold: 'paused' });
    expect(q.nextAction(l, { lastTurnError: true })).toEqual({ hold: 'error' });
    expect(q.nextAction(l, { permWaiting: true })).toEqual({ hold: 'permission' });
    expect(q.nextAction(l, { spendWarn: true })).toEqual({ hold: 'spend' });
  });
  it('a rule that is off does not hold', () => {
    expect(q.nextAction(mk('a'), { lastTurnError: true, rules: { onError: false } }).run.text).toBe('a');
  });
  it('an ask-first item waits until approved', () => {
    const l = [q.makeItem('a', { ask: true })];
    expect(q.nextAction(l, {})).toEqual({ hold: 'ask' });
    expect(q.nextAction([{ ...l[0], approved: true }], {}).run.text).toBe('a');
  });
  it('a scheduled item waits for its time', () => {
    const at = Date.now() + 60000;
    const l = [q.makeItem('a', { runAt: at })];
    expect(q.nextAction(l, { now: Date.now() })).toEqual({ hold: 'scheduled', wakeAt: at });
    expect(q.nextAction(l, { now: at + 1 }).run.text).toBe('a');
  });
  it('serialises without images and reads old saves', () => {
    const l = [q.makeItem({ text: 'p', blocks: [{ source: { data: 'AAAA' } }] })];
    const s = JSON.stringify(q.serialize(l));
    expect(s).not.toContain('AAAA');
    expect(q.deserialize(s)[0]).toMatchObject({ text: 'p', imgCount: 1 });
    expect(texts(q.deserialize('["x",{"text":"y"}]'))).toEqual(['x', 'y']);
    expect(q.deserialize('{bad')).toEqual([]);
  });
  it('50 items stay cheap', () => {
    let l = mk(...Array.from({ length: 50 }, (_, i) => 'm' + i));
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) l = q.move(l, i % 50, (i * 7) % 50);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

const ipc = (extra = {}) => ({
  'app:info': { ok: true, appVersion: '0', electron: '0', claude: { found: true, path: '', version: '' }, home: '/h' },
  'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
  'settings:get': { ok: true, settings: { defaultCwd: '/tmp', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
  'connectors:presets': { ok: true, presets: [] },
  'chat:create': { ok: true, id: 'c1', cwd: '/tmp', model: '', permissionMode: 'acceptEdits', provider: null },
  'chat:send': { ok: true },
  ...extra,
});

async function busyChat(...msgs) {
  const h = loadRenderer({ ipc: ipc() });
  await flush();
  const chat = h.window.Chat.chats.get('c1');
  h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
  for (const m of msgs) { chat.composer.value = m; chat.send('queue'); }
  return { h, chat };
}
const sends = (h) => h.calls.filter((c) => c.channel === 'chat:send');
const idle = async (h) => { h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: false }); await flush(8); await new Promise((r) => setTimeout(r, 80)); await flush(4); };

describe('queue panel in the chat', () => {
  it('shows the count and one row per message', async () => {
    const { h, chat } = await busyChat('one', 'two');
    const doc = h.window.document;
    expect(doc.querySelector('.q-title').textContent).toBe('Queue (2)');
    expect([...doc.querySelectorAll('.q-row .q-text')].map((n) => n.textContent)).toEqual(['one', 'two']);
    expect(chat.pendingMsgs.length).toBe(2);
  });
  it('Alt+Down moves the focused row and keeps the new order', async () => {
    const { h, chat } = await busyChat('one', 'two', 'three');
    const row = h.window.document.querySelector('.q-row');
    row.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(texts(chat.pendingMsgs)).toEqual(['two', 'one', 'three']);
    expect([...h.window.document.querySelectorAll('.q-row .q-text')].map((n) => n.textContent)).toEqual(['two', 'one', 'three']);
    const saved = JSON.parse(h.window.localStorage.getItem('cce:pending:/tmp'));
    expect(texts(saved)).toEqual(['two', 'one', 'three']);
  });
  it('runs the head when the turn ends cleanly', async () => {
    const { h } = await busyChat('one', 'two');
    await idle(h);
    expect(sends(h).map((c) => c.payload.text)).toEqual(['one']);
  });
  it('holds after a failed turn, then Run anyway runs it', async () => {
    const { h, chat } = await busyChat('one');
    chat.lastTurnError = true;
    await idle(h);
    expect(sends(h).length).toBe(0);
    expect(h.window.document.querySelector('.q-banner').textContent).toMatch(/ended with an error/);
    [...h.window.document.querySelectorAll('.q-banner .q-btn')].find((b) => b.textContent === 'Run anyway').click();
    await new Promise((r) => setTimeout(r, 120));
    expect(sends(h).length).toBe(1);
  });
  it('Pause holds and Resume runs', async () => {
    const { h, chat } = await busyChat('one');
    [...h.window.document.querySelectorAll('.q-head .q-btn')].find((b) => b.textContent === 'Pause').click();
    await idle(h);
    expect(sends(h).length).toBe(0);
    expect(chat.pendingMsgs.length).toBe(1);
    [...h.window.document.querySelectorAll('.q-head .q-btn')].find((b) => b.textContent === 'Resume').click();
    await new Promise((r) => setTimeout(r, 120));
    expect(sends(h).length).toBe(1);
  });
  it('Clear empties the queue and Undo brings it back', async () => {
    const { h, chat } = await busyChat('one', 'two');
    [...h.window.document.querySelectorAll('.q-head .q-btn')].find((b) => b.textContent === 'Clear').click();
    expect(chat.pendingMsgs.length).toBe(0);
    h.window.document.querySelector('.toast-action').click();
    expect(texts(chat.pendingMsgs)).toEqual(['one', 'two']);
  });
  it('Up arrow in an empty box takes the newest queued message back', async () => {
    const { h, chat } = await busyChat('one', 'two');
    chat.composer.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(chat.composer.value).toBe('two');
    expect(texts(chat.pendingMsgs)).toEqual(['one']);
  });
  it('an ask-first head waits for Run', async () => {
    const { h, chat } = await busyChat('one');
    chat.pendingMsgs[0] = { ...chat.pendingMsgs[0], ask: true };
    await idle(h);
    expect(sends(h).length).toBe(0);
    expect(h.window.document.querySelector('.q-banner').textContent).toMatch(/waits for your OK/);
  });
  it('queued images are saved as files and come back after a restart', async () => {
    const h = loadRenderer({ ipc: ipc({ 'draft:images': (p) => (p.op === 'load' && String(p.key).startsWith('queue:') ? { ok: true, images: [{ media_type: 'image/png', data: 'QUFBQQ==' }] } : { ok: true }) }) });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    chat.composer.value = 'with pic';
    chat.pendingImages.push({ media_type: 'image/png', data: 'QUFBQQ==' });
    chat.send('queue');
    const id = chat.pendingMsgs[0].id;
    expect(h.calls.some((c) => c.channel === 'draft:images' && c.payload.key === 'queue:/tmp:' + id && c.payload.images.length === 1)).toBe(true);
    await h.window.Chat.createSession({ cwd: '/tmp' });
    await flush(8);
    const again = [...h.window.Chat.chats.values()].pop();
    expect(again.pendingMsgs[0].blocks.length).toBe(1);
  });
  it('removing an item deletes its saved images', async () => {
    const h = loadRenderer({ ipc: ipc() });
    await flush();
    const chat = h.window.Chat.chats.get('c1');
    h.window.Chat.handleEvent({ id: 'c1', kind: 'status', busy: true });
    chat.composer.value = 'pic';
    chat.pendingImages.push({ media_type: 'image/png', data: 'QUFBQQ==' });
    chat.send('queue');
    const id = chat.pendingMsgs[0].id;
    h.window.document.querySelector('.q-more').click();
    [...h.window.document.querySelectorAll('.q-menu-item')].find((b) => b.textContent === 'Remove').click();
    expect(h.calls.filter((c) => c.channel === 'draft:images' && c.payload.key === 'queue:/tmp:' + id).pop().payload.images).toEqual([]);
  });
});
