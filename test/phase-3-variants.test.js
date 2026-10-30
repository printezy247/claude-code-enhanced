// @vitest-environment jsdom
// Phase 3.4: edited re-asks are remembered as variants of the message they
// branched from, survive a restart, and can be reopened from that message.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { addVariant, variantsFor, removeVariant, MAX_VARIANTS } from '../src/renderer/chat/variants.js';

const { loadRenderer, flush } = createRequire(import.meta.url)('./helpers/renderer.js');

beforeEach(() => localStorage.clear());

describe('variants store', () => {
  it('keeps the edited prompts under the message they came from', () => {
    addVariant('s1', 'u1', 'try B');
    addVariant('s1', 'u1', 'try C');
    addVariant('s1', 'u2', 'other');
    expect(variantsFor('s1', 'u1').map((v) => v.text)).toEqual(['try B', 'try C']);
    expect(variantsFor('s1', 'u2').length).toBe(1);
    expect(variantsFor('s2', 'u1')).toEqual([]);
  });
  it('does not repeat the same prompt', () => {
    addVariant('s1', 'u1', 'same');
    addVariant('s1', 'u1', 'same');
    expect(variantsFor('s1', 'u1').length).toBe(1);
  });
  it('survives a restart (reads from storage)', () => {
    addVariant('s1', 'u1', 'kept');
    expect(JSON.parse(localStorage.getItem('variants:s1'))[0].text).toBe('kept');
  });
  it('caps the list, oldest first out', () => {
    for (let i = 0; i < MAX_VARIANTS + 3; i++) addVariant('s1', 'u1', 'v' + i);
    const list = variantsFor('s1', 'u1');
    expect(list.length).toBe(MAX_VARIANTS);
    expect(list[list.length - 1].text).toBe('v' + (MAX_VARIANTS + 2));
  });
  it('removes one', () => {
    addVariant('s1', 'u1', 'a'); addVariant('s1', 'u1', 'b');
    removeVariant('s1', 'u1', 'a');
    expect(variantsFor('s1', 'u1').map((v) => v.text)).toEqual(['b']);
  });
  it('ignores a missing session or message id', () => {
    addVariant('', 'u1', 'x'); addVariant('s1', '', 'x');
    expect(variantsFor('', 'u1')).toEqual([]);
  });
});

describe('on the message', () => {
  it('shows a chip with the count and lists the variants, and Reopen branches again', async () => {
    const h = loadRenderer({ ipc: {
      'app:info': { ok: true, appVersion: '0.0.0-test', electron: '0.0.0', claude: { found: true, path: '/x', version: '1' }, home: '/home/test' },
      'providers:all': { ok: true, presets: [], instances: [], defaultUid: null },
      'settings:get': { ok: true, settings: { defaultCwd: '/home/test', fontSize: 14, scrollback: 1000 }, claude: { found: true, path: '', version: '' } },
      'connectors:presets': { ok: true, presets: [] },
      'chat:create': { ok: true, id: 'c1', cwd: '/work/proj', model: '', permissionMode: 'default', provider: null },
    } });
    await flush(4);
    const w = h.window;
    const chat = w.Chat.chats.get('c1');
    chat.sessionId = 's1';
    w.localStorage.setItem('variants:s1', JSON.stringify([{ uuid: 'u1', text: 'try B', at: 1 }, { uuid: 'u1', text: 'try C', at: 2 }]));
    w.Chat.handleEvent({ id: 'c1', kind: 'message', msg: { type: 'user', uuid: 'u1', message: { content: 'first ask' } } });
    const wrap = chat.msgs.querySelector('.user-msg');
    const chip = wrap.querySelector('.variant-chip');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('2');
    chip.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const rows = [...wrap.querySelectorAll('.variant-row')];
    expect(rows.map((r) => r.querySelector('.variant-text').textContent)).toEqual(['try B', 'try C']);
    rows[0].querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await flush(4);
    const made = h.calls.filter((c) => c.channel === 'chat:create').pop();
    expect(made.payload).toMatchObject({ resume: 's1', fork: true, resumeAt: 'u1' });
  });
});
