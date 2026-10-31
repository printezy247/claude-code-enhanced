// @vitest-environment jsdom
// The #mem-N linker, run on real DOM: it must turn citations into buttons and leave
// code, links and existing buttons alone.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CCEMemTimeline = require('../src/shared/memtimeline.js');

const src = readFileSync(path.join(__dirname, '..', 'src/renderer/chat/panel-memory.js'), 'utf8');
const body = src.slice(src.indexOf('export function linkMemoryCitations'));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const opened = [];
const chats = new Map();
// eslint-disable-next-line no-new-func
const link = new Function('el', 'chats', 'CCEMemTimeline', 'openMemoryCitation', 'document', 'NodeFilter',
  body.replace('export function', 'return function'))(el, chats, CCEMemTimeline, (c, n) => opened.push(n), document, NodeFilter);

describe('linkMemoryCitations', () => {
  it('buttons for citations in text, not in code or links', () => {
    document.body.innerHTML = '<div class="chat-pane" id="p"><div id="m"><p>See #mem-3 and #mem-12.</p><pre><code>#mem-9</code></pre><a href="#">#mem-5</a></div></div>';
    const m = document.getElementById('m');
    link(m);
    const btns = [...m.querySelectorAll('button.mem-cite')];
    expect(btns.map((b) => b.textContent)).toEqual(['#mem-3', '#mem-12']);
    expect(m.querySelector('pre').textContent).toBe('#mem-9');
    expect(m.querySelector('a').textContent).toBe('#mem-5');
    expect(m.querySelector('p').textContent).toBe('See #mem-3 and #mem-12.');
  });
  it('clicking opens that note on the chat whose pane holds it', () => {
    document.body.innerHTML = '<div class="chat-pane" id="p"><div id="m">Look at #mem-4</div></div>';
    chats.set('c1', { pane: document.getElementById('p') });
    link(document.getElementById('m'));
    document.querySelector('button.mem-cite').click();
    expect(opened).toEqual([4]);
  });
});
