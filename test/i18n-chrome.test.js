// Interface language (0.12.0): the queue panel, target chip, code-block actions
// and queue settings read their text from the dictionary. es and de must cover
// every English key with the same {placeholders}, and every key the code asks
// for must exist, or the screen would show "queue.hold.tests".
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const i18n = await import('../src/renderer/i18n.js');
const queue = await import('../src/renderer/chat/queue.js');

afterEach(() => i18n.setLang('en'));

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('dictionaries', () => {
  it('es and de cover every English key', () => {
    expect(i18n.incompleteLocales()).toEqual([]);
  });

  it('a translation keeps the placeholders of the English text', () => {
    const bad = [];
    for (const code of ['es', 'de']) {
      i18n.setLang(code);
      for (const key of i18n.keysOf('en')) {
        i18n.setLang('en'); const en = i18n.t(key);
        i18n.setLang(code); const tr = i18n.t(key);
        if (placeholders(en) !== placeholders(tr)) bad.push(code + ':' + key);
        if (tr === key || !tr.trim()) bad.push(code + ':' + key + ' (empty)');
      }
    }
    expect(bad).toEqual([]);
  });

  it('every key the interface code asks for exists', () => {
    const files = ['chat/qpanel.js', 'chat/queue.js', 'chat/target.js', 'chat/markdown.js', 'app/settings.js', 'app/board.js'];
    const missing = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8');
      // a prefix ending in '.' is built at run time; the next test covers its values
      for (const m of src.matchAll(/\btf?\('([a-z][\w.]*)'/g)) if (!m[1].endsWith('.') && !i18n.hasKey(m[1])) missing.push(f + ' → ' + m[1]);
    }
    expect(missing).toEqual([]);
  });

  it('a dynamic key (queue.hold.*, queue.rule.*) exists for every value it can take', () => {
    for (const h of ['paused', 'error', 'permission', 'spend', 'tests', 'ask', 'scheduled', 'default']) expect(i18n.hasKey('queue.hold.' + h), h).toBe(true);
    for (const r of ['onError', 'onPermission', 'onSpend', 'onTests']) expect(i18n.hasKey('queue.rule.' + r), r).toBe(true);
  });
});

describe('the queue in another language', () => {
  it('English text is what it always was', () => {
    expect(queue.holdText('tests')).toBe('Queue paused: a test run failed in the last turn');
    expect(queue.summary({ effort: 'high', ask: true, blocks: [{}, {}] })).toEqual(['2 images', 'effort high', 'asks first']);
  });

  it('chips and banners follow the language', () => {
    i18n.setLang('es');
    expect(queue.holdText('tests')).toBe('Cola en pausa: falló una prueba en el último turno');
    expect(queue.summary({ effort: 'high', ask: true, blocks: [{}] })).toEqual(['1 imagen', 'esfuerzo high', 'pregunta antes']);
    i18n.setLang('de');
    expect(queue.summary({ blocks: [{}, {}, {}] })).toEqual(['3 Bilder']);
    expect(i18n.tf('queue.title', { n: 4 })).toBe('Warteschlange (4)');
  });

  it('an unknown hold falls back to a generic banner, never to the raw key', () => {
    expect(queue.holdText('mystery')).toBe('Queue held');
  });
});
